import { describe, it, expect } from 'vitest';
import { parseLegalBlocks, splitBoldRuns } from '@/src/components/legal/legalBlocks';

/**
 * The legal screens used to render a whole document inside one `<Text>`, so the
 * `**bold**` headings and `-` bullets the documents are written with reached users
 * as literal asterisks. These tests pin the grammar that replaced it.
 *
 * The sample deliberately mirrors the real documents' shape, including a bold
 * "Last updated" line as the first block and a heading whose text begins with a
 * number — `## 1. Who may use TopHunt` — which is the case where heading and
 * numbered-list detection could plausibly collide.
 */
const SAMPLE = `**Last updated: 31 August 2026**

These terms are the agreement between you and TopHunt.

## 1. Who may use TopHunt

You must be at least 18 years old.

### Fair play

The following void an entry:

- Voting for your own entry through any other account.
- Buying, selling or organising votes.

1. First numbered item
2. Second numbered item`;

describe('parseLegalBlocks', () => {
  it('classifies every block type the documents use', () => {
    const blocks = parseLegalBlocks(SAMPLE);
    expect(blocks[0]).toEqual({ kind: 'p', text: '**Last updated: 31 August 2026**' });
    expect(blocks).toContainEqual({ kind: 'h2', text: '1. Who may use TopHunt' });
    expect(blocks).toContainEqual({ kind: 'h3', text: 'Fair play' });
    expect(blocks).toContainEqual({
      kind: 'bullet',
      text: 'Voting for your own entry through any other account.',
    });
    expect(blocks).toContainEqual({ kind: 'numbered', marker: '1.', text: 'First numbered item' });
  });

  it('strips the markup prefix from every block', () => {
    // The whole point of the change: no reader should see a `##` or a leading `-`.
    for (const block of parseLegalBlocks(SAMPLE)) {
      expect(block.text.startsWith('#')).toBe(false);
      expect(block.text.startsWith('- ')).toBe(false);
      expect(block.text.startsWith('* ')).toBe(false);
    }
  });

  it('treats `###` as a subsection rather than a section', () => {
    // `#{1,2}` would happily match `###` and swallow a `#` into the text.
    expect(parseLegalBlocks('### Sub')).toEqual([{ kind: 'h3', text: 'Sub' }]);
    expect(parseLegalBlocks('## Section')).toEqual([{ kind: 'h2', text: 'Section' }]);
  });

  it('joins soft-wrapped prose and splits on blank lines', () => {
    expect(parseLegalBlocks('one\ntwo\n\nthree')).toEqual([
      { kind: 'p', text: 'one two' },
      { kind: 'p', text: 'three' },
    ]);
  });

  it('degrades unknown constructs to prose instead of dropping them', () => {
    // An admin-authored document may contain anything. Losing a clause silently
    // would be far worse than rendering its markup.
    const blocks = parseLegalBlocks('| a | b |\n\n> quoted');
    expect(blocks).toEqual([
      { kind: 'p', text: '| a | b |' },
      { kind: 'p', text: '> quoted' },
    ]);
  });

  it('ignores empty input', () => {
    expect(parseLegalBlocks('')).toEqual([]);
    expect(parseLegalBlocks('\n\n  \n')).toEqual([]);
  });
});

describe('splitBoldRuns', () => {
  it('alternates plain and bold runs', () => {
    expect(splitBoldRuns('a **b** c')).toEqual(['a ', 'b', ' c']);
  });

  it('returns null when there is nothing to format', () => {
    expect(splitBoldRuns('plain')).toBeNull();
  });

  it('returns null on unbalanced delimiters', () => {
    // Otherwise a stray `**` would bold the entire rest of the document.
    expect(splitBoldRuns('a **b')).toBeNull();
    expect(splitBoldRuns('**a** b **c')).toBeNull();
  });
});
