import React from 'react';
import { View, Text, StyleSheet, Linking, TouchableOpacity, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';

/**
 * A tiny, dependency-free HTML renderer for blog content.
 *
 * The app doesn't ship react-native-webview / react-native-render-html, so we
 * parse a pragmatic subset of HTML (as produced by WordPress + the archive
 * importer) into React Native primitives: headings, paragraphs, images, lists,
 * blockquotes, links, and inline bold/italic. Anything unknown degrades to
 * plain text, so content is always readable.
 */

interface Props {
  html: string;
  isDark?: boolean;
}

type InlineSeg = { text: string; bold?: boolean; italic?: boolean; href?: string };
type Block =
  | { type: 'heading'; level: number; segs: InlineSeg[] }
  | { type: 'paragraph'; segs: InlineSeg[] }
  | { type: 'listitem'; ordered: boolean; index: number; segs: InlineSeg[] }
  | { type: 'quote'; segs: InlineSeg[] }
  | { type: 'image'; src: string }
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
  // Tokenize into tags and text.
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
      // ignore all other inline tags
      continue;
    }
    const text = decodeEntities(tok).replace(/\s+/g, ' ');
    if (text) segs.push({ text, bold: bold > 0, italic: italic > 0, href });
  }
  return segs.filter((s) => s.text.length > 0);
}

/** Parse the (already script/style-stripped) HTML into a flat list of blocks. */
function parseBlocks(html: string): Block[] {
  const blocks: Block[] = [];

  // Pull standalone images first (also inside <figure>) so they become blocks.
  // Then walk block-level tags in document order.
  const blockRegex =
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>|<p[^>]*>([\s\S]*?)<\/p>|<blockquote[^>]*>([\s\S]*?)<\/blockquote>|<(ul|ol)[^>]*>([\s\S]*?)<\/\5>|<img[^>]*>|<hr\s*\/?>/gi;

  let match: RegExpExecArray | null;
  let lastIndex = 0;
  const pushLooseText = (chunk: string) => {
    // Any text sitting between recognized blocks -> paragraph(s).
    const cleaned = chunk.replace(/<[^>]+>/g, ' ');
    const segs = parseInline(chunk);
    if (segs.length && cleaned.trim()) blocks.push({ type: 'paragraph', segs });
  };

  while ((match = blockRegex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      // there may be loose inline content / stray images before this block
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
    } else if (lower.startsWith('<img')) {
      const src = extractImgSrc(raw);
      if (src) blocks.push({ type: 'image', src });
    } else if (lower.startsWith('<hr')) {
      blocks.push({ type: 'hr' });
    }
  }

  // Trailing loose content / images after the last block.
  if (lastIndex < html.length) {
    const rest = html.slice(lastIndex);
    const imgs = rest.match(/<img[^>]*>/gi) || [];
    for (const im of imgs) {
      const src = extractImgSrc(im);
      if (src) blocks.push({ type: 'image', src });
    }
    pushLooseText(rest.replace(/<img[^>]*>/gi, ''));
  }

  // Fallback: nothing parsed but there is text -> single paragraph.
  if (blocks.length === 0) {
    const segs = parseInline(html);
    if (segs.length) blocks.push({ type: 'paragraph', segs });
  }
  return blocks;
}

function extractImgSrc(imgTag: string): string | null {
  const m =
    imgTag.match(/\sdata-src=["']([^"']+)["']/i) ||
    imgTag.match(/\ssrc=["']([^"']+)["']/i);
  if (!m) return null;
  let src = m[1].trim();
  // Wayback thumbnails sometimes prefix with a timestamp; keep as-is (works).
  if (src.startsWith('//')) src = 'https:' + src;
  if (!/^https?:/i.test(src)) return null;
  return src;
}

export default function RenderHtml({ html, isDark }: Props) {
  const { width } = useWindowDimensions();
  const textColor = isDark ? '#E6E6EA' : '#1A1A1E';
  const subColor = isDark ? '#A0A0A5' : '#555';
  const linkColor = '#FF3B30';
  const quoteBar = isDark ? '#3A3A3C' : '#E0E0E5';

  if (!html || !html.trim()) {
    return <Text style={{ color: subColor }}>No content available.</Text>;
  }

  // Strip dangerous / noisy elements before parsing.
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  const blocks = React.useMemo(() => parseBlocks(cleaned), [cleaned]);
  const contentWidth = width - 40;

  const renderSegs = (segs: InlineSeg[]) =>
    segs.map((s, i) => {
      if (s.href) {
        return (
          <Text
            key={i}
            style={{ color: linkColor, textDecorationLine: 'underline' }}
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
            color: textColor,
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
            const size = block.level <= 1 ? 24 : block.level === 2 ? 21 : 18;
            return (
              <Text key={idx} style={[styles.heading, { fontSize: size, color: textColor }]}>
                {renderSegs(block.segs)}
              </Text>
            );
          }
          case 'paragraph':
            return (
              <Text key={idx} style={[styles.paragraph, { color: textColor }]}>
                {renderSegs(block.segs)}
              </Text>
            );
          case 'listitem':
            return (
              <View key={idx} style={styles.listRow}>
                <Text style={[styles.bullet, { color: subColor }]}>
                  {block.ordered ? `${block.index}.` : '\u2022'}
                </Text>
                <Text style={[styles.paragraph, { color: textColor, flex: 1, marginBottom: 6 }]}>
                  {renderSegs(block.segs)}
                </Text>
              </View>
            );
          case 'quote':
            return (
              <View key={idx} style={[styles.quote, { borderLeftColor: quoteBar }]}>
                <Text style={[styles.paragraph, { color: subColor, fontStyle: 'italic', marginBottom: 0 }]}>
                  {renderSegs(block.segs)}
                </Text>
              </View>
            );
          case 'image':
            return (
              <Image
                key={idx}
                source={{ uri: block.src }}
                style={{ width: contentWidth, height: contentWidth * 0.6, borderRadius: 12, marginVertical: 12 }}
                contentFit="cover"
                transition={200}
              />
            );
          case 'hr':
            return <View key={idx} style={[styles.hr, { backgroundColor: quoteBar }]} />;
          default:
            return null;
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { fontWeight: '700', marginTop: 18, marginBottom: 8, lineHeight: 30 },
  paragraph: { fontSize: 16, lineHeight: 26, marginBottom: 14 },
  listRow: { flexDirection: 'row', paddingRight: 8 },
  bullet: { width: 22, fontSize: 16, lineHeight: 26 },
  quote: { borderLeftWidth: 4, paddingLeft: 14, paddingVertical: 4, marginBottom: 14 },
  hr: { height: 1, marginVertical: 18, opacity: 0.6 },
});
