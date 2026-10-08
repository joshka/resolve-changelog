# Resolve changelog

An experiment in resolving changelog conflicts with a small TypeScript bot instead of changing
contributors to a changelog-fragment workflow.

A maintainer comments `/resolve-changelog` on a pull request. The bot combines complete bullet
insertions under existing Unreleased subsections and merges the base branch into the PR branch.
It explicitly checks out upstream `main` and uses GitHub APIs through `actions/github-script`.
PR and fork files are read as data; their code is never executed by the bot.

## Run checks

Use the current stable Node release for development. TypeScript runs directly, without a
compilation step. CI checks both current Node and Node 24, the GitHub Script runtime.

```sh
npm ci
npm run typecheck
npm test
```

## Try a conflict

1. Create a PR that adds a bullet to the end of the New features subsection in `CHANGELOG.md`.
1. Add a different bullet at that same position on `main` and push it.
1. Confirm that GitHub reports the PR as conflicted.
1. Comment `/resolve-changelog` on the PR from an account with repository write access.
1. Inspect the bot workflow and merge commit. Both entries should remain, with PR additions first.

The workflow must be present on the default branch before the comment can trigger it.

## What the bot accepts

Existing changelog entries must appear unchanged and in their original order. New entries can go
before, between, or after them. Complete identical insertion blocks are included once. Entries
use `*` bullets followed by a space, indented continuation lines, LF newlines, and a trailing blank
line.

Other repository files can change on one side of the merge. The bot refuses overlapping changes
outside `CHANGELOG.md`, edits or deletions of existing changelog entries, heading changes, workflow
updates, truncated API trees, and a PR that moves during resolution. It updates the PR branch
without force-pushing and leaves final merging to the maintainer.

## Forks and first-time contributors

Anyone can submit a PR. A contributor or maintainer with upstream write access authorizes resolution
by posting `/resolve-changelog`; the PR author does not need upstream write access.

Without fork write credentials, the bot prepares a `resolved-changelog-<PR>` artifact containing
`resolved-CHANGELOG.md`. Its reply links the workflow run and records the exact head and base SHAs.
The author merges that captured base into the PR branch, replaces the conflicted `CHANGELOG.md`
with the downloaded file, then publishes the merge. If either branch has since changed, request
another resolution instead of applying an outdated file.

To allow automatic publication, register a GitHub App with **Contents: write** and install it on
selected repositories, including each fork that opts in. Configure these on the upstream repo:

- Repository variable `CHANGELOG_APP_CLIENT_ID`: the App's client ID.
- Repository secret `CHANGELOG_APP_PRIVATE_KEY`: the App's private key.

The workflow first checks the caller's upstream permissions. Only then does it request a short-lived
writer token restricted to the PR head repository and Contents permission. That token handles
publication only; the upstream `GITHUB_TOKEN` handles reading and replying to the PR. The token is
revoked when the job ends. A missing fork installation falls back to the downloadable resolution.

The bot checks that the writer targets the captured head repository, rechecks branch SHAs and the
head repository ID before publishing, and never force-pushes. An App token also lets normal PR CI
trigger without the `GITHUB_TOKEN` approval interruption. Fork PR CI still follows GitHub's normal
fork approval policies.

## Current limitations

- Fork publication requires an authorized GitHub App installation. Without it, the bot supplies
  a downloadable resolution and leaves the branch untouched.
- Resolution creates a merge commit; it does not rebase the contributor's commits.
- Invocation is manual. Conflict status does not have its own GitHub Actions event.
- The default workflow uses `GITHUB_TOKEN`. PR workflows triggered by its update may require
  approval;
  push workflows do not automatically rerun. Inspect CI before merging, or use a suitably scoped
  GitHub App token for normal event delivery.
- Branch protection can reject a bot update. This experiment does not bypass protection rules.

## Files

- `.github/scripts/resolve-changelog.mts`: pure Markdown resolver.
- `.github/scripts/changelog-bot.mts`: authorization, merge planning, publication, and reporting.
- `.github/scripts/*.test.mts`: resolver and mocked API tests.
- `.github/workflows/changelog-bot.yml`: comment-triggered bot.
- `.github/workflows/ci.yml`: current Node and Node 24 tests, plus strict type checking.
