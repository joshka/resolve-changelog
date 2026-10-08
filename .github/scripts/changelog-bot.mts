import { writeFileSync } from 'node:fs';
import type { getOctokit } from '@actions/github';
import type * as ActionsCore from '@actions/core';
import { ManualResolutionRequired, resolve } from './resolve-changelog.mts';

// github-script injects these objects; the imports above are erased at runtime.
type GitHub = ReturnType<typeof getOctokit>;
type Repository = { owner: string; repo: string };
type PullRequest = Awaited<ReturnType<GitHub['rest']['pulls']['get']>>['data'];
interface TreeUpdate {
  path: string;
  mode: TreeEntry['mode'];
  type: TreeEntry['type'];
  sha?: string | null;
  content?: string;
}

export interface TreeEntry {
  path: string;
  sha: string;
  type: 'blob' | 'commit';
  mode: '100644' | '100755' | '120000' | '160000';
}

type Tree = Map<string, TreeEntry>;
interface MergePlan {
  updates: TreeUpdate[];
  changelogConflict: boolean;
}

export interface BotServices {
  github: GitHub;
  writer?: { repository: string; github: GitHub };
  core: typeof ActionsCore;
  context: {
    repo: Repository;
    payload: {
      issue?: { number: number; pull_request?: unknown };
      comment?: { body?: string; user: { login: string; type: string } };
    };
  };
}

const COMMAND = '/resolve-changelog';
const CHANGELOG = 'CHANGELOG.md';

function refuse(message: string): never {
  throw new ManualResolutionRequired(message);
}

function sameEntry(left: TreeEntry | undefined, right: TreeEntry | undefined): boolean {
  return left?.sha === right?.sha && left?.mode === right?.mode && left?.type === right?.type;
}

// Plan a three-way tree merge. Only CHANGELOG.md may need content resolution;
// all other paths must be identical or changed on just one side.
export function planMerge(ancestor: Tree, head: Tree, target: Tree): MergePlan {
  const updates: TreeUpdate[] = [];
  let changelogConflict = false;
  const paths = new Set([...ancestor.keys(), ...head.keys(), ...target.keys()]);

  for (const path of paths) {
    const original = ancestor.get(path);
    const current = head.get(path);
    const incoming = target.get(path);

    if (sameEntry(current, incoming) || sameEntry(original, incoming)) continue;
    if (sameEntry(original, current)) {
      if (incoming) {
        updates.push(incoming);
      } else if (current) {
        updates.push({ ...current, sha: null });
      }
      continue;
    }

    const regularChangelog = path === CHANGELOG && [original, current, incoming].every(entry => {
      return entry?.type === 'blob' && entry.mode === '100644';
    });
    if (!regularChangelog) refuse(`Overlapping changes in ${JSON.stringify(path)} require manual resolution.`);
    changelogConflict = true;
  }

  return { updates, changelogConflict };
}

async function loadTree(github: GitHub, repository: Repository, sha: string): Promise<Tree> {
  const { data } = await github.rest.git.getTree({ ...repository, tree_sha: sha, recursive: '1' });
  if (data.truncated) refuse('The repository tree is too large for this resolver.');
  const entries: Tree = new Map();
  for (const entry of data.tree) {
    if (entry.type === 'tree') continue;
    if (!entry.path || !entry.sha ||
        !['blob', 'commit'].includes(entry.type ?? '') ||
        !['100644', '100755', '120000', '160000'].includes(entry.mode ?? '')) {
      refuse('Unsupported repository tree entry.');
    }
    const { path, sha, type, mode } = entry;
    entries.set(path, { path, sha, type, mode } as TreeEntry);
  }
  return entries;
}

async function loadText(github: GitHub, repository: Repository, entry: TreeEntry | undefined): Promise<string> {
  if (!entry) refuse('Missing changelog entry.');
  const { data } = await github.rest.git.getBlob({ ...repository, file_sha: entry.sha });
  if (data.encoding !== 'base64') refuse('Unsupported changelog blob encoding.');
  const bytes = Buffer.from(data.content, 'base64');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function loadPull(github: GitHub, repository: Repository, number: number): Promise<PullRequest> {
  const { data: pull } = await github.rest.pulls.get({ ...repository, pull_number: number });
  // The PR payload can retain its original base SHA after the branch advances.
  const { data: baseRef } = await github.rest.git.getRef({
    ...repository, ref: `heads/${pull.base.ref}`,
  });
  return { ...pull, base: { ...pull.base, sha: baseRef.object.sha } };
}

async function prepareMerge(github: GitHub, repository: Repository, pull: PullRequest): Promise<MergePlan | null> {
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...repository,
    basehead: `${pull.base.sha}...${pull.head.sha}`,
  });
  if (comparison.merge_base_commit.sha === pull.base.sha) return null;

  const [ancestor, head, target] = await Promise.all([
    loadTree(github, repository, comparison.merge_base_commit.sha),
    loadTree(github, repository, pull.head.sha),
    loadTree(github, repository, pull.base.sha),
  ]);
  const plan = planMerge(ancestor, head, target);

  if (plan.changelogConflict) {
    const [leftText, baseText, rightText] = await Promise.all([
      loadText(github, repository, head.get(CHANGELOG)),
      loadText(github, repository, ancestor.get(CHANGELOG)),
      loadText(github, repository, target.get(CHANGELOG)),
    ]);
    plan.updates.push({ path: CHANGELOG, mode: '100644', type: 'blob',
      content: resolve(leftText, baseText, rightText) });
  }

  // Workflow changes need additional token permissions and should be reviewed.
  if (plan.updates.some(entry => entry.path.startsWith('.github/workflows/'))) {
    refuse('Updating workflow files requires manual branch synchronization.');
  }
  return plan;
}

async function publishMerge(services: BotServices, pull: PullRequest, plan: MergePlan): Promise<string> {
  const { github, context, writer } = services;
  const headRepository = pull.head.repo;
  if (!headRepository) refuse('The PR head repository is no longer available.');
  const repository = { owner: headRepository.owner.login, repo: headRepository.name };
  const publisher = writer?.github ?? github;
  const { data: headCommit } = await publisher.rest.git.getCommit({
    ...repository, commit_sha: pull.head.sha,
  });
  const { data: tree } = await publisher.rest.git.createTree({
    ...repository, base_tree: headCommit.tree.sha, tree: plan.updates,
  });
  const { data: commit } = await publisher.rest.git.createCommit({
    ...repository,
    message: `changelog: Merge ${pull.base.ref} and resolve entries`,
    tree: tree.sha,
    parents: [pull.head.sha, pull.base.sha],
  });

  const current = await loadPull(github, context.repo, pull.number);
  if (current.state !== 'open' || current.head.sha !== pull.head.sha ||
      current.base.sha !== pull.base.sha || current.head.ref !== pull.head.ref ||
      current.base.ref !== pull.base.ref || current.head.repo?.id !== pull.head.repo?.id) {
    refuse('The PR changed while resolving; invoke the bot again.');
  }

  // No force push: a concurrent new commit makes this update fail rather than
  // losing the contributor work. This merge preserves both captured parents.
  await publisher.rest.git.updateRef({
    ...repository, ref: `heads/${pull.head.ref}`, sha: commit.sha, force: false,
  });
  return commit.sha;
}

async function finish({ github, context, core }: BotServices, issueNumber: number, result: string, message: string): Promise<void> {
  core.setOutput('result', result);
  core.summary.addHeading('Changelog resolution').addRaw(message);
  await core.summary.write();
  if (result === 'resolved' || result === 'unchanged') core.notice(message);
  else core.warning(message);

  await github.rest.issues.createComment({
    ...context.repo, issue_number: issueNumber, body: message,
  });
}

/** Check upstream authorization before requesting any fork credentials. */
export async function authorizeRequest(services: BotServices) {
  const { github, context, core } = services;
  const { issue, comment } = context.payload;
  if (!issue?.pull_request || comment?.body?.trim() !== COMMAND) return null;
  if (comment.user.type === 'Bot') return null;

  const repository = context.repo;
  const { data: permission } = await github.rest.repos.getCollaboratorPermissionLevel({
    ...repository, username: comment.user.login,
  });
  if (!['write', 'maintain', 'admin'].includes(permission.permission)) {
    core.notice('Changelog resolution requires repository write access.');
    return null;
  }

  const pull = await loadPull(github, repository, issue.number);
  if (pull.state !== 'open' || !pull.head.repo) return null;
  return pull;
}

/** All repository reads use the upstream token; only publication uses a writer. */
export default async function runBot(services: BotServices) {
  const { github, context, core, writer } = services;
  const pull = await authorizeRequest(services);
  if (!pull) return;
  const repository = context.repo;
  const isFork = pull.head.repo?.full_name !== pull.base.repo.full_name;

  try {
    if (pull.state !== 'open') refuse('The PR is no longer open.');
    if (writer && writer.repository !== pull.head.repo?.full_name) {
      refuse('The writer token does not target this PR head repository.');
    }
    const plan = await prepareMerge(github, repository, pull);
    if (!plan) {
      await finish(services, pull.number, 'unchanged', 'The PR already contains the current base branch.');
      return;
    }
    if (isFork && !writer) {
      const changelog = plan.updates.find(update => update.path === CHANGELOG)?.content;
      if (changelog === undefined) {
        refuse('This fork needs a normal branch merge; the bot has no authorized writer for it.');
      }
      writeFileSync('resolved-CHANGELOG.md', changelog);
      const runUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository.owner}/${repository.repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
      await finish(services, pull.number, 'prepared',
        `Prepared the resolved changelog for head ${pull.head.sha} and base ${pull.base.sha}. ` +
        `Download the resolution artifact from ${runUrl}. Merge the captured base into your branch, ` +
        'replace CHANGELOG.md with the downloaded file, and publish the result. The fork branch was not changed.');
      return;
    }
    const sha = await publishMerge(services, pull, plan);
    await finish(services, pull.number, 'resolved', `Updated the PR with merge commit ${sha}. Check the required CI runs before merging.`);
  } catch (error) {
    if (error instanceof ManualResolutionRequired) {
      await finish(services, pull.number, 'refused', error.message);
    } else {
      // Do not retry mutations or report successful publication as a refusal.
      core.setOutput('result', 'error');
      core.setFailed(`Changelog bot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
