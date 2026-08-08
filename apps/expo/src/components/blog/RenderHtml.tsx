import React, { useState } from 'react';
import { View, Text, StyleSheet, Linking, Platform, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';

/**
 * A tiny, dependency-free HTML renderer for blog content, tuned for a pleasant
 * reading experience (editorial typography, auto-sized images, styled headings,
 * links, lists, quotes and simple tables). Parses a pragmatic subset of the
 * WordPress/archive HTML into React Native primitives; unknown tags degrade to
 * plain text so content is always readable.
 */

interface Props {
  html: string;
  isDark?: boolean;
}

// Clean cross-platform fonts (fixes the default web fallback font).
const FONT_SERIF = Platform.select({
  web: 'Georgia, Cambria, "Times New Roman", Times, serif',
  default: undefined,
}) as any;
const FONT_SANS = Platform.select({
  web: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  default: undefined,
}) as any;

const ACCENT = '#FF3B30';

type InlineSeg = { text: string; bold?: boolean; italic?: boolean; href?: string };
type Block =
  | { type: 'heading'; level: number; segs: InlineSeg[] }
  | { type: 'paragraph'; segs: InlineSeg[] }
  | { type: 'listitem'; ordered: boolean; index: number; segs: InlineSeg[] }
  | { type: 'quote'; segs: InlineSeg[] }
  | { type: 'image'; src: string }
  | { type: 'table'; rows: { header: boolean; cells: InlineSeg[][] }[] }
  | { type: 'hr' };

const decodeEntities = (s: string): string =>
  s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#8217;|&rsquo;/gi, '\u2019')
    .replace(/&#8216;|&lsquo;/gi, '\u2018')
    .replace(/&#8220;|&ldquo;/gi, '\u201C')
    .replace(/&#8221;|&rdquo;/gi, '\u201D')
    .replace(/&#8211;|&ndash;/gi, '\u2013')
    .replace(/&#8212;|&mdash;/gi, '\u2014')
    .replace(/&hellip;|&#8230;/gi, '\u2026')
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 10));
      } catch {
        return '';
      }
    });

/** Parse a run of inline HTML into styled text segments. */
function parseInline(html: string): InlineSeg[] {
  const segs: InlineSeg[] = [];
  let bold = 0;
  let italic = 0;
  let href: string | undefined;
  const tokens = html.split(/(<[^>]+>)/g);
  for (const tok of tokens) {
    if (!tok) continue;
    if (tok[0] === '<') {
      const tag = tok.toLowerCase();
      if (/^<(strong|b)\b/.test(tag)) bold++;
      else if (/^<\/(strong|b)>/.test(tag)) bold = Math.max(0, bold - 1);
      else if (/^<(em|i)\b/.test(tag)) italic++;
      else if (/^<\/(em|i)>/.test(tag)) italic = Math.max(0, italic - 1);
      else if (/^<a\b/.test(tag)) {
        const m = tok.match(/href=["']([^"']+)["']/i);
        href = m ? m[1] : undefined;
      } else if (/^<\/a>/.test(tag)) href = undefined;
      else if (/^<br\s*\/?>/.test(tag)) segs.push({ text: '\n' });
      continue;
    }
    const text = decodeEntities(tok).replace(/\s+/g, ' ');
    if (text) segs.push({ text, bold: bold > 0, italic: italic > 0, href });
  }
  return segs.filter((s) => s.text.length > 0);
}

function parseTable(tableHtml: string): Block | null {
  const rows: { header: boolean; cells: InlineSeg[][] }[] = [];
  const trs = tableHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
  for (const tr of trs) {
    const cellTags = tr.match(/<(t[hd])[^>]*>([\s\S]*?)<\/\1>/gi) || [];
    if (!cellTags.length) continue;
    const header = /<th/i.test(tr);
    const cells = cellTags.map((c) => parseInline(c.replace(/<\/?t[hd][^>]*>/gi, '')));
    rows.push({ header, cells });
  }
  return rows.length ? { type: 'table', rows } : null;
}

/** Parse the (already script/style-stripped) HTML into a flat list of blocks. */
function parseBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  const blockRegex =
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>|<p[^>]*>([\s\S]*?)<\/p>|<blockquote[^>]*>([\s\S]*?)<\/blockquote>|<(ul|ol)[^>]*>([\s\S]*?)<\/\5>|<table[^>]*>([\s\S]*?)<\/table>|<img[^>]*>|<hr\s*\/?>/gi;

  let match: RegExpExecArray | null;
  let lastIndex = 0;
  const pushLooseText = (chunk: string) => {
    const cleaned = chunk.replace(/<[^>]+>/g, ' ');
    const segs = parseInline(chunk);
    if (segs.length && cleaned.trim()) blocks.push({ type: 'paragraph', segs });
  };

  while ((match = blockRegex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      const between = html.slice(lastIndex, match.index);
      const imgs = between.match(/<img[^>]*>/gi) || [];
      for (const im of imgs) {
        const src = extractImgSrc(im);
        if (src) blocks.push({ type: 'image', src });
      }
    }
    lastIndex = blockRegex.lastIndex;

    const raw = match[0];
    const lower = raw.toLowerCase();
    if (lower.startsWith('<h')) {
      const level = parseInt(match[1], 10);
      const segs = parseInline(match[2] || '');
      if (segs.length) blocks.push({ type: 'heading', level, segs });
    } else if (lower.startsWith('<p')) {
      const segs = parseInline(match[3] || '');
      if (segs.length) blocks.push({ type: 'paragraph', segs });
    } else if (lower.startsWith('<blockquote')) {
      const segs = parseInline(match[4] || '');
      if (segs.length) blocks.push({ type: 'quote', segs });
    } else if (lower.startsWith('<ul') || lower.startsWith('<ol')) {
      const ordered = match[5].toLowerCase() === 'ol';
      const inner = match[6] || '';
      const items = inner.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
      items.forEach((li, i) => {
        const content = li.replace(/<\/?li[^>]*>/gi, '');
        const segs = parseInline(content);
        if (segs.length) blocks.push({ type: 'listitem', ordered, index: i + 1, segs });
      });
    } else if (lower.startsWith('<table')) {
      const t = parseTable(match[7] || '');
      if (t) blocks.push(t);
    } else if (lower.startsWith('<img')) {
      const src = extractImgSrc(raw);
      if (src) blocks.push({ type: 'image', src });
    } else if (lower.startsWith('<hr')) {
      blocks.push({ type: 'hr' });
    }
  }

  if (lastIndex < html.length) {
    const rest = html.slice(lastIndex);
    const imgs = rest.match(/<img[^>]*>/gi) || [];
    for (const im of imgs) {
      const src = extractImgSrc(im);
      if (src) blocks.push({ type: 'image', src });
    }
    pushLooseText(rest.replace(/<img[^>]*>/gi, ''));
  }

  if (blocks.length === 0) {
    const segs = parseInline(html);
    if (segs.length) blocks.push({ type: 'paragraph', segs });
  }
  return blocks;
}

function extractImgSrc(imgTag: string): string | null {
  const m = imgTag.match(/\sdata-src=["']([^"']+)["']/i) || imgTag.match(/\ssrc=["']([^"']+)["']/i);
  if (!m) return null;
  let src = m[1].trim();
  if (src.startsWith('//')) src = 'https:' + src;
  if (!/^https?:/i.test(src)) return null;
  return src;
}

/** Image that sizes itself to its natural aspect ratio (no cropping). */
function BlogImage({ src, width, isDark }: { src: string; width: number; isDark?: boolean }) {
  const [ratio, setRatio] = useState(1.6);
  return (
    <Image
      source={{ uri: src }}
      style={{
        width,
        aspectRatio: ratio,
        borderRadius: 16,
        marginVertical: 18,
        backgroundColor: isDark ? '#1C1C1E' : '#F1F1F4',
      }}
      contentFit="cover"
      transition={250}
      onLoad={(e: any) => {
        const w = e?.source?.width;
        const h = e?.source?.height;
        if (w && h) setRatio(Math.max(0.6, Math.min(w / h, 2.2)));
      }}
    />
  );
}

export default function RenderHtml({ html, isDark }: Props) {
  const { width } = useWindowDimensions();
  const textColor = isDark ? '#E7E7EC' : '#22222A';
  const headingColor = isDark ? '#FFFFFF' : '#111114';
  const subColor = isDark ? '#9B9BA3' : '#6A6A73';
  const linkColor = isDark ? '#FF6A60' : ACCENT;
  const rule = isDark ? '#2C2C30' : '#ECECF1';
  const quoteBg = isDark ? 'rgba(255,59,48,0.08)' : 'rgba(255,59,48,0.05)';
  const chipBg = isDark ? '#151517' : '#F7F7FA';

  if (!html || !html.trim()) {
    return <Text style={{ color: subColor, fontFamily: FONT_SANS }}>No content available.</Text>;
  }

  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  const blocks = React.useMemo(() => parseBlocks(cleaned), [cleaned]);
  const contentWidth = Math.min(width - 40, 720);

  const renderSegs = (segs: InlineSeg[], baseColor: string, baseFont: any) =>
    segs.map((s, i) => {
      if (s.href) {
        return (
          <Text
            key={i}
            style={{ color: linkColor, fontWeight: '600', fontFamily: baseFont, textDecorationLine: 'underline' }}
            onPress={() => Linking.openURL(s.href!).catch(() => {})}
          >
            {s.text}
          </Text>
        );
      }
      return (
        <Text
          key={i}
          style={{
            color: baseColor,
            fontFamily: baseFont,
            fontWeight: s.bold ? '700' : '400',
            fontStyle: s.italic ? 'italic' : 'normal',
          }}
        >
          {s.text}
        </Text>
      );
    });

  return (
    <View>
      {blocks.map((block, idx) => {
        switch (block.type) {
          case 'heading': {
            const size = block.level <= 1 ? 27 : block.level === 2 ? 23 : block.level === 3 ? 20 : 18;
            return (
              <Text
                key={idx}
                style={[styles.heading, { fontSize: size, color: headingColor, fontFamily: FONT_SANS }]}
              >
                {renderSegs(block.segs, headingColor, FONT_SANS)}
              </Text>
            );
          }
          case 'paragraph':
            return (
              <Text key={idx} style={[styles.paragraph, { color: textColor, fontFamily: FONT_SERIF }]}>
                {renderSegs(block.segs, textColor, FONT_SERIF)}
              </Text>
            );
          case 'listitem':
            return (
              <View key={idx} style={styles.listRow}>
                <View style={styles.bulletWrap}>
                  {block.ordered ? (
                    <Text style={[styles.bulletNum, { color: linkColor, fontFamily: FONT_SANS }]}>{block.index}.</Text>
                  ) : (
                    <View style={[styles.dot, { backgroundColor: linkColor }]} />
                  )}
                </View>
                <Text style={[styles.paragraph, { color: textColor, fontFamily: FONT_SERIF, flex: 1, marginBottom: 8 }]}>
                  {renderSegs(block.segs, textColor, FONT_SERIF)}
                </Text>
              </View>
            );
          case 'quote':
            return (
              <View key={idx} style={[styles.quote, { borderLeftColor: linkColor, backgroundColor: quoteBg }]}>
                <Text style={[styles.paragraph, { color: subColor, fontStyle: 'italic', marginBottom: 0, fontFamily: FONT_SERIF }]}>
                  {renderSegs(block.segs, subColor, FONT_SERIF)}
                </Text>
              </View>
            );
          case 'image':
            return <BlogImage key={idx} src={block.src} width={contentWidth} isDark={isDark} />;
          case 'table':
            return (
              <View key={idx} style={[styles.table, { borderColor: rule }]}>
                {block.rows.map((row, ri) => (
                  <View
                    key={ri}
                    style={[
                      styles.tr,
                      { borderBottomColor: rule },
                      row.header && { backgroundColor: chipBg },
                    ]}
                  >
                    {row.cells.map((cell, ci) => (
                      <Text
                        key={ci}
                        style={[
                          styles.td,
                          {
                            color: row.header ? headingColor : textColor,
                            fontFamily: FONT_SANS,
                            fontWeight: row.header ? '700' : '400',
                          },
                        ]}
                      >
                        {renderSegs(cell, row.header ? headingColor : textColor, FONT_SANS)}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            );
          case 'hr':
            return <View key={idx} style={[styles.hr, { backgroundColor: rule }]} />;
          default:
            return null;
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontWeight: '800', marginTop: 26, marginBottom: 10, lineHeight: 34, letterSpacing: -0.3 },
  paragraph: { fontSize: 17.5, lineHeight: 30, marginBottom: 18 },
  listRow: { flexDirection: 'row', paddingRight: 8, marginBottom: 2 },
  bulletWrap: { width: 26, alignItems: 'flex-start', paddingTop: 9 },
  bulletNum: { fontSize: 15, fontWeight: '700' },
  dot: { width: 7, height: 7, borderRadius: 4, marginTop: 3 },
  quote: { borderLeftWidth: 4, paddingLeft: 16, paddingRight: 12, paddingVertical: 12, marginVertical: 8, borderRadius: 8 },
  table: { borderWidth: 1, borderRadius: 12, overflow: 'hidden', marginVertical: 16 },
  tr: { flexDirection: 'row', borderBottomWidth: 1 },
  td: { flex: 1, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14.5, lineHeight: 21 },
  hr: { height: 1, marginVertical: 26, opacity: 0.8 },
});
