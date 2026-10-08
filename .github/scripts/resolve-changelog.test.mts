import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from './resolve-changelog.mts';

const prefix = `# Changelog

## [Unreleased]

### New features

`;
const existing = '* Existing.\n\n';
const suffix = `### Fixed bugs

## [1.0.0] - 2026-01-01

* Released.
`;
const base = prefix + existing + suffix;

function entry(text: string) {
  return `* ${text}\n\n`;
}

function withFeature(text: string) {
  return prefix + existing + entry(text) + suffix;
}

function withFix(changelog: string, text: string) {
  return changelog.replace('### Fixed bugs\n\n', '### Fixed bugs\n\n' + entry(text));
}

test('preserves unchanged text exactly', () => {
  assert.equal(resolve(base, base, base), base);
});

test('orders additions left then right and preserves multiline Markdown', () => {
  const leftEntry = 'Left.\n  Continuation.\n\n  Paragraph.';
  const left = withFeature(leftEntry);
  const right = withFeature('Right.');
  const expected = prefix + existing + entry(leftEntry) + entry('Right.') + suffix;

  assert.equal(resolve(left, base, right), expected);
});

test('emits identical insertion blocks once', () => {
  const changed = withFeature('Shared.');
  assert.equal(resolve(changed, base, changed), changed);
});

test('supports insertion before an existing entry', () => {
  const left = prefix + entry('First.') + existing + suffix;
  assert.equal(resolve(left, base, base), left);
});

test('supports empty subsections', () => {
  const right = withFix(base, 'Fix.');
  assert.equal(resolve(base, base, right), right);
});

test('refuses edits, deletion, release changes, and new headings', () => {
  const unsupportedChanges = [
    base.replace('Existing.', 'Edited.'),
    base.replace(existing, ''),
    base.replace('Released.', 'Changed release.'),
    base.replace('### Fixed bugs', '### Packaging'),
  ];

  for (const changed of unsupportedChanges) {
    assert.throws(() => resolve(changed, base, base));
  }
});

test('refuses partial entries, binary text, CRLF, and missing final newline', () => {
  const unsupportedChanges = [
    withFeature('Bad.\nUnindented prose.'),
    withFeature('NUL\0'),
    base.replaceAll('\n', '\r\n'),
    base.trimEnd(),
  ];

  for (const changed of unsupportedChanges) {
    assert.throws(() => resolve(changed, base, base));
  }
});

test('combines independent additions in multiple subsections', () => {
  const left = withFeature('Feature.');
  const right = withFix(base, 'Fix.');
  assert.equal(resolve(left, base, right), withFix(left, 'Fix.'));
});

