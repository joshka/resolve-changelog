# Resolve changelog

An experiment in resolving changelog conflicts with a small TypeScript bot instead of changing
contributors to a changelog-fragment workflow.

A maintainer comments `/resolve-changelog` on a pull request. The bot combines complete bullet
insertions under existing Unreleased subsections and merges the base branch into the PR branch.
It uses GitHub APIs through `actions/github-script`; it does not execute code from the PR.

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

## Current limitations

- Only same-repository PRs are supported. Fork branches need separate write credentials.
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
