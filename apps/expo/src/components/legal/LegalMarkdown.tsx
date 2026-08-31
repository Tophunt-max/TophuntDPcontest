import React, { useMemo } from 'react';
import { View, Text, StyleSheet, type TextStyle } from 'react-native';
import { parseLegalBlocks, splitBoldRuns } from './legalBlocks';

/**
 * Renders the small subset of Markdown legal documents are written in.
 *
 * ## Why this exists
 *
 * The legal screens rendered a whole document inside a single `<Text>`. The admin
 * textarea that feeds them offered "Markdown or plain text", and the documents were
 * written with `**bold**` headings and `*   ` bullets — so what reached the user was
 * a wall of literal asterisks with no visible structure. A twelve-section Terms of
 * Service in one undifferentiated block is unreadable, and that is a compliance
 * problem rather than a cosmetic one: an app-store reviewer and a payment provider
 * both need to be able to find a specific clause.
 *
 * ## Why not a Markdown library
 *
 * `react-native-markdown-display` and its peers pull in a CommonMark parser and a
 * style bridge to render four block types. This app ships to the web through Expo,
 * so that is bundle weight on a screen most users open once. The grammar is fixed,
 * documented in `legalBlocks.ts`, and authored by us — a full parser buys nothing,
 * and an unsupported construct degrades to plain text rather than throwing.
 *
 * Block parsing and bold-run splitting live in `./legalBlocks` so they can be unit
 * tested; this file is only the mapping from block to view.
 */

/** Wrap the odd-indexed (bold) runs of a line in a bold `<Text>`. */
function renderInline(text: string, boldStyle: TextStyle): React.ReactNode {
  const runs = splitBoldRuns(text);
  if (!runs) return text;
  return runs.map((run, i) =>
    i % 2 === 1 ? (
      <Text key={i} style={boldStyle}>
        {run}
      </Text>
    ) : (
      run
    ),
  );
}

interface Props {
  /** The document source. */
  content: string;
  /** Body text colour; headings use `headingColor`. */
  color: string;
  headingColor: string;
  /** Bullet glyph and list numbering colour. */
  accentColor: string;
}

export function LegalMarkdown({ content, color, headingColor, accentColor }: Props) {
  const blocks = useMemo(() => parseLegalBlocks(content), [content]);

  return (
    <View>
      {blocks.map((block, index) => {
        // A heading that opens the document does not need the gap that separates
        // one from preceding prose.
        const first = index === 0;

        switch (block.kind) {
          case 'h2':
            return (
              <Text
                key={index}
                accessibilityRole="header"
                style={[styles.h2, { color: headingColor }, first && styles.firstBlock]}
              >
                {renderInline(block.text, styles.bold)}
              </Text>
            );
          case 'h3':
            return (
              <Text
                key={index}
                accessibilityRole="header"
                style={[styles.h3, { color: headingColor }, first && styles.firstBlock]}
              >
                {renderInline(block.text, styles.bold)}
              </Text>
            );
          case 'bullet':
            return (
              <View key={index} style={styles.listRow}>
                <Text style={[styles.marker, { color: accentColor }]}>•</Text>
                <Text style={[styles.body, styles.listText, { color }]}>
                  {renderInline(block.text, styles.bold)}
                </Text>
              </View>
            );
          case 'numbered':
            return (
              <View key={index} style={styles.listRow}>
                <Text style={[styles.marker, styles.numberMarker, { color: accentColor }]}>
                  {block.marker}
                </Text>
                <Text style={[styles.body, styles.listText, { color }]}>
                  {renderInline(block.text, styles.bold)}
                </Text>
              </View>
            );
          default:
            return (
              <Text key={index} style={[styles.body, styles.paragraph, { color }]}>
                {renderInline(block.text, styles.bold)}
              </Text>
            );
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 15, lineHeight: 24, fontFamily: 'Urbanist-Regular' },
  bold: { fontFamily: 'Urbanist-Bold' },
  paragraph: { marginBottom: 14 },
  h2: { fontSize: 18, lineHeight: 26, fontFamily: 'Urbanist-Bold', marginTop: 12, marginBottom: 10 },
  h3: { fontSize: 16, lineHeight: 24, fontFamily: 'Urbanist-Bold', marginTop: 8, marginBottom: 8 },
  firstBlock: { marginTop: 0 },
  listRow: { flexDirection: 'row', marginBottom: 10, paddingRight: 4 },
  // Fixed width so list text aligns into a column whatever the marker is.
  marker: { width: 22, fontSize: 15, lineHeight: 24, fontFamily: 'Urbanist-Bold' },
  numberMarker: { width: 26 },
  listText: { flex: 1 },
});
