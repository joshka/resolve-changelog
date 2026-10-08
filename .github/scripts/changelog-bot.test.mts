import { test } from 'node:test';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import runBot, { planMerge, type BotServices, type TreeEntry } from './changelog-bot.mts';

interface Call {
  name: string;
  args?: Record<string, unknown>;
  key?: string;
  value?: unknown;
}

interface MockPull {
  number?: number;
  state?: string;
  head?: { sha?: string; ref?: string; repo?: { full_name: string; id?: number; owner?: { login: string }; name?: string } };
  base?: { sha?: string; ref?: string; repo?: { full_name: string; id?: number; owner?: { login: string }; name?: string } };
}

interface Options {
  trees?: Record<string, TreeEntry[]>;
  contents?: Record<string, string>;
  pull?: MockPull;
  currentPull?: MockPull;
  permission?: string;
  ancestor?: string;
  truncated?: boolean;
  pushFails?: boolean;
  currentBase?: string;
}

function blob(path: string, sha: string): TreeEntry {
  return { path, sha, type: 'blob', mode: '100644' };
}

function tree(...entries: TreeEntry[]): Map<string, TreeEntry> {
  return new Map(entries.map(entry => [entry.path, entry]));
}

function harness(options: Options = {}): BotServices & { calls: Call[] } {
  const calls: Call[] = [];
  const changelog = '# Changelog\n\n## [Unreleased]\n\n### Fixed bugs\n\n';
  const files: Record<string, TreeEntry[]> = {
    ancestor: [blob('CHANGELOG.md', 'original'), blob('code.rs', 'code')],
    head: [blob('CHANGELOG.md', 'left'), blob('code.rs', 'head-code')],
    target: [blob('CHANGELOG.md', 'right'), blob('code.rs', 'code')],
    ...options.trees,
  };
  const contents: Record<string, string> = {
    original: changelog,
    left: changelog + '* PR fix.\n\n',
    right: changelog + '* Main fix.\n\n',
    ...options.contents,
  };
  const pull = {
    number: 42,
    state: 'open',
    head: { sha: 'head', ref: 'topic', repo: { full_name: 'owner/repo', id: 1, owner: { login: 'owner' }, name: 'repo' } },
    base: { sha: 'target', ref: 'main', repo: { full_name: 'owner/repo', id: 1, owner: { login: 'owner' }, name: 'repo' } },
    ...options.pull,
  };
  let pullReads = 0;
  let baseReads = 0;
  const endpoint = (name: string, implementation: (args: Record<string, unknown>) => unknown) => async (args: Record<string, unknown>) => {
    calls.push({ name, args });
    return { data: implementation(args) };
  };
  const github = { rest: {
    repos: {
      getCollaboratorPermissionLevel: endpoint('permission', () => ({ permission: options.permission ?? 'write' })),
      compareCommitsWithBasehead: endpoint('compare', () => ({ merge_base_commit: { sha: options.ancestor ?? 'ancestor' } })),
    },
    pulls: {
      get: endpoint('pull', () => {
        pullReads++;
        return pullReads === 1 ? pull : (options.currentPull ?? pull);
      }),
    },
    git: {
      getRef: endpoint('getRef', () => ({ object: { sha: ++baseReads === 1 ? 'target' : (options.currentBase ?? 'target') } })),
      getTree: endpoint('getTree', args => ({ tree: files[String(args.tree_sha)], truncated: options.truncated ?? false })),
      getBlob: endpoint('getBlob', args => ({ content: Buffer.from(contents[String(args.file_sha)]).toString('base64'), encoding: 'base64' })),
      getCommit: endpoint('getCommit', () => ({ tree: { sha: 'head-tree' } })),
      createTree: endpoint('createTree', () => ({ sha: 'merged-tree' })),
      createCommit: endpoint('createCommit', () => ({ sha: 'merged-commit' })),
      updateRef: endpoint('updateRef', () => {
        if (options.pushFails) throw new Error('Non-fast-forward');
        return {};
      }),
    },
    issues: { createComment: endpoint('comment', () => ({})) },
  } };
  const record = (name: string) => (value: unknown) => calls.push({ name, value });
  const summary = {
    addHeading() { return this; },
    addRaw() { return this; },
    async write() {},
  };
  const core = {
    summary,
    setOutput: (key: string, value: unknown) => calls.push({ name: 'output', key, value }),
    notice: record('notice'), warning: record('warning'), setFailed: record('failed'),
  };
  const context = {
    repo: { owner: 'owner', repo: 'repo' },
    payload: {
      issue: { number: 42, pull_request: {} },
      comment: { body: '/resolve-changelog', user: { login: 'maintainer', type: 'User' } },
    },
  };
  // Endpoint doubles intentionally implement only the API surface exercised here.
  return {
    github: github as unknown as BotServices['github'],
    context,
    core: core as unknown as BotServices['core'],
    calls,
  };
}

test('tree plan carries one-sided additions and deletions', () => {
  const original = blob('old.txt', 'old');
  const added = blob('new.txt', 'new');
  const plan = planMerge(tree(original), tree(original), tree(added));
  assert.deepEqual(plan.updates, [
    { path: 'old.txt', mode: '100644', type: 'blob', sha: null }, added,
  ]);
});

test('tree plan refuses overlapping non-changelog edits', () => {
  assert.throws(() => planMerge(
    tree(blob('code.rs', 'original')),
    tree(blob('code.rs', 'left')),
    tree(blob('code.rs', 'right')),
  ));
});

test('bot publishes a merge with both parents and resolved text', async () => {
  const bot = harness();
  await runBot(bot);
  const createdTree = bot.calls.find(call => call.name === 'createTree')!.args!;
  assert.equal(createdTree.base_tree, 'head-tree');
  assert.deepEqual(createdTree.tree, [{
    path: 'CHANGELOG.md', mode: '100644', type: 'blob',
    content: '# Changelog\n\n## [Unreleased]\n\n### Fixed bugs\n\n* PR fix.\n\n* Main fix.\n\n',
  }]);
  assert.deepEqual(bot.calls.find(call => call.name === 'createCommit')!.args!.parents, ['head', 'target']);
  assert.deepEqual(bot.calls.find(call => call.name === 'updateRef')!.args!, {
    owner: 'owner', repo: 'repo', ref: 'heads/topic', sha: 'merged-commit', force: false,
  });
  assert.equal(bot.calls.find(call => call.name === 'output')!.value, 'resolved');
  assert.equal(bot.calls.filter(call => call.name === 'comment').length, 1);
});

test('unrelated comments make no API calls', async () => {
  const bot = harness();
  bot.context.payload.comment!.body = 'hello';
  await runBot(bot);
  assert.deepEqual(bot.calls, []);
});

test('read-only callers cannot mutate or post replies', async () => {
  const bot = harness({ permission: 'read' });
  await runBot(bot);
  assert.deepEqual(bot.calls.map(call => call.name), ['permission', 'notice']);
});

test('already synchronized PRs are unchanged', async () => {
  const bot = harness({ ancestor: 'target' });
  await runBot(bot);
  assert.equal(bot.calls.find(call => call.name === 'output')!.value, 'unchanged');
  assert.ok(!bot.calls.some(call => call.name === 'createTree'));
});

test('forks without a writer produce an artifact without creating remote objects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'changelog-fork-'));
  const previousDirectory = process.cwd();
  try {
    process.chdir(directory);
    const bot = harness({ pull: {
      number: 42, state: 'open',
      head: { sha: 'head', ref: 'topic', repo: { full_name: 'contributor/fork',
        id: 2, owner: { login: 'contributor' }, name: 'fork' } },
      base: { sha: 'target', ref: 'main', repo: { full_name: 'owner/repo' } },
    } });
    await runBot(bot);
    assert.equal(bot.calls.find(call => call.name === 'output')!.value, 'prepared');
    assert.ok(!bot.calls.some(call => call.name === 'createTree'));
    const resolved = readFileSync('resolved-CHANGELOG.md', 'utf8');
    assert.ok(resolved.includes('* PR fix.'));
    assert.ok(resolved.includes('* Main fix.'));
  } finally {
    process.chdir(previousDirectory);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('truncated trees and unsupported entries never publish', async () => {
  for (const options of [
    { truncated: true },
    { contents: { left: '# Replaced changelog\n' } },
    { trees: { target: [blob('CHANGELOG.md', 'right'), blob('code.rs', 'target-code')] } },
    { trees: { target: [blob('CHANGELOG.md', 'right'), blob('code.rs', 'code'), blob('.github/workflows/ci.yml', 'workflow')] } },
  ]) {
    const bot = harness(options);
    await runBot(bot);
    assert.equal(bot.calls.find(call => call.name === 'output')!.value, 'refused');
    assert.ok(!bot.calls.some(call => call.name === 'createTree'));
  }
});

test('a concurrent PR update prevents branch publication', async () => {
  const bot = harness({ currentPull: {
    state: 'open', head: { sha: 'new-head', ref: 'topic' }, base: { sha: 'target', ref: 'main' },
  } });
  await runBot(bot);
  assert.equal(bot.calls.find(call => call.name === 'output')!.value, 'refused');
  assert.ok(!bot.calls.some(call => call.name === 'updateRef'));
});

test('publication errors are not retried or reported as success', async () => {
  const bot = harness({ pushFails: true });
  await runBot(bot);
  assert.equal(bot.calls.find(call => call.name === 'output')!.value, 'error');
  assert.equal(bot.calls.filter(call => call.name === 'updateRef').length, 1);
  assert.ok(bot.calls.some(call => call.name === 'failed'));
  assert.ok(!bot.calls.some(call => call.name === 'comment'));
});

test('base branch refs override stale PR payload SHAs', async () => {
  const bot = harness({ pull: {
    base: { sha: 'old-target', ref: 'main', repo: { full_name: 'owner/repo', id: 1, owner: { login: 'owner' }, name: 'repo' } },
  } });
  await runBot(bot);
  assert.equal(bot.calls.find(call => call.name === 'compare')!.args!.basehead, 'target...head');
  assert.deepEqual(bot.calls.find(call => call.name === 'createCommit')!.args!.parents, ['head', 'target']);
  assert.equal(bot.calls.find(call => call.name === 'output')!.value, 'resolved');
});

test('a concurrent base branch update prevents publication', async () => {
  const bot = harness({ currentBase: 'new-target' });
  await runBot(bot);
  assert.equal(bot.calls.find(call => call.name === 'output')!.value, 'refused');
  assert.ok(!bot.calls.some(call => call.name === 'updateRef'));
});

test('fork publication uses only the matching fork writer', async () => {
  const forkHead = { sha: 'head', ref: 'topic', repo: { full_name: 'contributor/fork',
    id: 2, owner: { login: 'contributor' }, name: 'fork' } };
  const bot = harness({ pull: { head: forkHead }, currentPull: {
    state: 'open', head: forkHead, base: { sha: 'target', ref: 'main' },
  } });
  const writer = harness();
  bot.writer = { repository: 'contributor/fork', github: writer.github };
  await runBot(bot);
  assert.equal(bot.calls.find(call => call.name === 'output')!.value, 'resolved');
  assert.ok(!bot.calls.some(call => call.name === 'createTree' || call.name === 'updateRef'));
  for (const name of ['getCommit', 'createTree', 'createCommit', 'updateRef']) {
    const args = writer.calls.find(call => call.name === name)!.args!;
    assert.equal(args.owner, 'contributor');
    assert.equal(args.repo, 'fork');
  }
});

test('a writer for another repository cannot publish', async () => {
  const bot = harness();
  const writer = harness();
  bot.writer = { repository: 'unrelated/repo', github: writer.github };
  await runBot(bot);
  assert.equal(bot.calls.find(call => call.name === 'output')!.value, 'refused');
  assert.deepEqual(writer.calls, []);
});

test('a changed head repository prevents branch publication', async () => {
  const bot = harness({ currentPull: {
    state: 'open',
    head: { sha: 'head', ref: 'topic', repo: { full_name: 'other/repo', id: 99 } },
    base: { sha: 'target', ref: 'main' },
  } });
  await runBot(bot);
  assert.equal(bot.calls.find(call => call.name === 'output')!.value, 'refused');
  assert.ok(!bot.calls.some(call => call.name === 'updateRef'));
});
