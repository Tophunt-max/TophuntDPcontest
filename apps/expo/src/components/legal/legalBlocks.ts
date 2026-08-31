/**
 * The block grammar legal documents are written in.
 *
 * Kept in a plain `.ts` module, separate from the component that renders it, for
 * two reasons: this is pure logic with no React in it, and `vitest.config.ts`
 * only collects the non-RN layer — a parser living inside a `.tsx` file could not
 * be unit tested at all.
 *
 * ## The grammar
 *
 *   `## Heading`      section heading
 *   `### Heading`     subsection heading
 *   `- item`          bullet (also `* item` and `• item`)
 *   `1. item`         numbered item, its number preserved as written
 *   blank line        paragraph break
 *
 * Inline `**bold**` is handled by the renderer, not here — it can occur inside any
 * block type, so it is not a block-level concern.
 *
 * Anything unrecognised is a paragraph. That is the important property: an
 * admin-authored document using a construct this grammar does not know degrades to
 * readable prose instead of vanishing or throwing.
 */

export type LegalBlock =
  | { kind: 'h2' | 'h3' | 'p'; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'numbered'; marker: string; text: string };

/** Split document source into renderable blocks. */
export function parseLegalBlocks(source: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'p', text: paragraph.join(' ') });
    paragraph = [];
  };

  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();

    if (line === '') {
      flush();
      continue;
    }

    // `###` before `#{1,2}`, otherwise the looser pattern would claim it.
    const h3 = /^###\s+(.*)$/.exec(line);
    if (h3) {
      flush();
      blocks.push({ kind: 'h3', text: h3[1].trim() });
      continue;
    }

    const h2 = /^#{1,2}\s+(.*)$/.exec(line);
    if (h2) {
      flush();
      blocks.push({ kind: 'h2', text: h2[1].trim() });
      continue;
    }

    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      blocks.push({ kind: 'bullet', text: bullet[1].trim() });
      continue;
    }

    const numbered = /^(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flush();
      blocks.push({ kind: 'numbered', marker: `${numbered[1]}.`, text: numbered[2].trim() });
      continue;
    }

    // Soft-wrapped prose: joined onto the current paragraph, so a hard-wrapped
    // source document does not render as one short line per source line.
    paragraph.push(line);
  }

  flush();
  return blocks;
}

/**
 * Split a line into alternating plain and bold runs.
 *
 * Returns `null` when there is nothing to do, or when the `**` delimiters are
 * unbalanced. An unbalanced trailing `**` would otherwise bold the whole
 * remainder of the document, and a stray visible asterisk is a far smaller
 * failure than a page that goes bold and stays that way.
 *
 * Otherwise returns runs in order; every odd index is bold.
 */
export function splitBoldRuns(text: string): string[] | null {
  if (!text.includes('**')) return null;
  const parts = text.split('**');
  // An even number of parts means an odd number of delimiters.
  if (parts.length % 2 === 0) return null;
  return parts;
}
