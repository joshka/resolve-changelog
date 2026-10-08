interface Subsection {
  header: string;
  entries: string[];
}

interface Changelog {
  beforeSubsections: string;
  subsections: Subsection[];
  afterUnreleased: string;
}

export class ManualResolutionRequired extends Error {}

function requireSupported(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new ManualResolutionRequired(message);
  }
}

function parseChangelog(text: string): Changelog {
  const isSupportedText = text.endsWith('\n') && !text.includes('\0') && !text.includes('\r');
  requireSupported(isSupportedText, 'Expected LF-delimited text ending with a newline.');

  const unreleasedHeadings = [...text.matchAll(/^## \[Unreleased\]\n/gm)];
  requireSupported(unreleasedHeadings.length === 1, 'Expected exactly one Unreleased section.');

  const heading = unreleasedHeadings[0];
  const bodyStart = heading.index + heading[0].length;
  const remainingText = text.slice(bodyStart);
  const nextRelease = remainingText.search(/^## /m);
  const bodyEnd = nextRelease === -1 ? text.length : bodyStart + nextRelease;
  const body = text.slice(bodyStart, bodyEnd);

  const subsectionHeadings = [...body.matchAll(/^### .+\n/gm)];
  requireSupported(subsectionHeadings.length > 0, 'Expected existing Unreleased subsections.');

  const subsections = subsectionHeadings.map((subheading, index) => {
    const contentStart = subheading.index + subheading[0].length;
    const contentEnd = subsectionHeadings[index + 1]?.index ?? body.length;
    return parseSubsection(subheading[0], body.slice(contentStart, contentEnd));
  });

  return {
    beforeSubsections: text.slice(0, bodyStart + subsectionHeadings[0].index),
    subsections,
    afterUnreleased: text.slice(bodyEnd),
  };
}

function parseSubsection(heading: string, content: string) {
  const bulletStarts = [...content.matchAll(/^\* /gm)];
  const firstBullet = bulletStarts[0]?.index ?? content.length;
  const entries = bulletStarts.map((bullet, index) => {
    const end = bulletStarts[index + 1]?.index ?? content.length;
    const entry = content.slice(bullet.index, end);
    validateEntry(entry);
    return entry;
  });

  // Retain the heading and its spacing exactly, including in empty subsections.
  return { header: heading + content.slice(0, firstBullet), entries };
}

function validateEntry(entry: string) {
  requireSupported(
    entry.split('\n').slice(1).every(line => !line.trim() || line.startsWith('  ')),
    'Only complete bullet entries and indented continuations are supported.',
  );
  requireSupported(entry.endsWith('\n\n'), 'Entries must end with a blank line.');
}

function validateUnchangedStructure(base: Changelog, side: Changelog) {
  requireSupported(
    side.beforeSubsections === base.beforeSubsections &&
    side.afterUnreleased === base.afterUnreleased &&
    side.subsections.length === base.subsections.length &&
    side.subsections.every((section, index) => section.header === base.subsections[index].header),
    'Changes outside existing Unreleased bullet entries require manual resolution.',
  );
}

function collectInsertions(baseEntries: string[], sideEntries: string[]): string[] {
  // One insertion slot before each base entry, plus one after the last entry.
  // Each base entry must still appear verbatim and in the original order.
  const slots: string[] = Array(baseEntries.length + 1).fill('');
  let nextBaseEntry = 0;

  for (const entry of sideEntries) {
    if (entry === baseEntries[nextBaseEntry]) {
      nextBaseEntry++;
    } else {
      slots[nextBaseEntry] += entry;
    }
  }

  requireSupported(
    nextBaseEntry === baseEntries.length,
    'An existing entry was edited, deleted, or reordered.',
  );
  return slots;
}

function mergeSubsection(base: Subsection, left: Subsection, right: Subsection) {
  const leftInsertions = collectInsertions(base.entries, left.entries);
  const rightInsertions = collectInsertions(base.entries, right.entries);
  const parts = [base.header];

  for (let slot = 0; slot <= base.entries.length; slot++) {
    parts.push(leftInsertions[slot]);

    // Identical insertion blocks appear once; otherwise LEFT precedes RIGHT.
    if (rightInsertions[slot] !== leftInsertions[slot]) {
      parts.push(rightInsertions[slot]);
    }
    parts.push(base.entries[slot] ?? '');
  }

  return parts.join('');
}

/** Combine complete Unreleased bullet insertions, preserving all existing text. */
export function resolve(leftText: string, baseText: string, rightText: string): string {
  const base = parseChangelog(baseText);
  const left = parseChangelog(leftText);
  const right = parseChangelog(rightText);

  validateUnchangedStructure(base, left);
  validateUnchangedStructure(base, right);

  const mergedSubsections = base.subsections.map((subsection, index) => {
    return mergeSubsection(subsection, left.subsections[index], right.subsections[index]);
  });

  return base.beforeSubsections + mergedSubsections.join('') + base.afterUnreleased;
}

