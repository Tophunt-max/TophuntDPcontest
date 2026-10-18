/**
 * Server-side VS battle card: ONE 1080x1920 JPEG showing both entries side by
 * side with a centred VS badge, both handles and the contest title.
 *
 * ---------------------------------------------------------------------------
 * Processing architecture (why it looks like this)
 * ---------------------------------------------------------------------------
 * The Worker runtime has no canvas, no `sharp`, no filesystem, and on the free
 * plan a 10ms CPU budget — decoding and re-encoding two camera photos in WASM
 * would blow that on every battle. So the heavy work is delegated to the
 * Cloudflare Images binding (`env.IMAGES`), which decodes, crops, composites and
 * encodes OFF the Worker's CPU budget:
 *
 *   base canvas  -> .draw(entry A, cropped to the left panel)
 *                -> .draw(entry B, cropped to the right panel)
 *                -> .draw(labels, title, VS badge)
 *                -> .output(image/jpeg)
 *
 * What the binding can NOT do reliably is text: `.text()` needs a font URL and
 * has a known platform failure mode. So everything textual (handles, title, the
 * VS badge) is rasterised HERE into small PNGs with a built-in 5x7 bitmap font
 * and a minimal PNG encoder (`CompressionStream('deflate')` is native). That is
 * deterministic, needs no external asset, and costs well under a millisecond of
 * CPU: the largest raster is the 240x240 badge.
 *
 * The canvas itself is a 1-bit palette PNG (zeroed rows + a native deflate), so
 * even the 1080x1920 background costs almost nothing to produce.
 *
 * Renderer is an interface so the publication workflow can be exercised in tests
 * with a recording fake, and so a different backend (a dedicated media service)
 * can be swapped in without touching the state machine.
 */

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1920;
/** Bumped whenever the visual output changes, so an old card is not reused. */
export const VS_RENDER_VERSION = 1;

const GUTTER = 24;
const PANEL_W = (CARD_WIDTH - GUTTER * 3) / 2; // 504
const PANEL_H = 896; // 9:16 — the shape of a story, so faces are not over-cropped
const PANEL_TOP = 380;
const PANEL_BORDER = 6;
const BADGE_SIZE = 240;
const NAME_TOP = PANEL_TOP + PANEL_H + 34;
const TITLE_TOP = 190;
const FOOTER_TOP = 1760;

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface VsLayout {
  width: number;
  height: number;
  /** Always userA (the creator), for every viewer. */
  leftPanel: Rect;
  /** Always userB (the joiner). */
  rightPanel: Rect;
  badge: Rect;
  /** Horizontal centres of the two name labels, and their top edge. */
  leftNameCenterX: number;
  rightNameCenterX: number;
  nameTop: number;
  titleTop: number;
  footerTop: number;
}

export function planVsLayout(): VsLayout {
  const leftPanel = { left: GUTTER, top: PANEL_TOP, width: PANEL_W, height: PANEL_H };
  const rightPanel = { left: GUTTER * 2 + PANEL_W, top: PANEL_TOP, width: PANEL_W, height: PANEL_H };
  return {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    leftPanel,
    rightPanel,
    badge: {
      left: Math.round(CARD_WIDTH / 2 - BADGE_SIZE / 2),
      top: Math.round(PANEL_TOP + PANEL_H / 2 - BADGE_SIZE / 2),
      width: BADGE_SIZE,
      height: BADGE_SIZE,
    },
    leftNameCenterX: leftPanel.left + PANEL_W / 2,
    rightNameCenterX: rightPanel.left + PANEL_W / 2,
    nameTop: NAME_TOP,
    titleTop: TITLE_TOP,
    footerTop: FOOTER_TOP,
  };
}

// ---------------------------------------------------------------------------
// Text sanitisation + bitmap font
// ---------------------------------------------------------------------------

/* prettier-ignore */
const FONT: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  "@": [".###.", "#...#", "#.###", "#.#.#", "#.###", "#....", ".###."],
  _: [".....", ".....", ".....", ".....", ".....", ".....", "#####"],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
  "&": [".##..", "#..#.", "#.#..", ".#...", "#.#.#", "#..#.", ".##.#"],
  "'": ["..#..", "..#..", ".#...", ".....", ".....", ".....", "....."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
  "#": [".#.#.", ".#.#.", "#####", ".#.#.", "#####", ".#.#.", ".#.#."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

const GLYPH_W = 5;
const GLYPH_H = 7;

/**
 * Reduce arbitrary user text to what the card can draw, safely.
 *
 * This is the injection boundary for the composite: nothing user-controlled
 * reaches a renderer except as pixels from this alphabet. Accents are folded
 * (NFKD), control/zero-width/bidi characters and everything outside the glyph
 * set are dropped, whitespace is collapsed, and the result is length-capped with
 * a ".." suffix. An empty result falls back to `fallback`.
 */
export function sanitizeCardText(raw: unknown, maxChars: number, fallback = ""): string {
  const folded = String(raw ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  let out = "";
  for (const ch of folded) {
    if (FONT[ch]) out += ch;
    else if (/\s/.test(ch)) out += " ";
  }
  out = out.replace(/\s+/g, " ").trim();
  if (!out) out = fallback;
  if (out.length > maxChars) out = `${out.slice(0, Math.max(1, maxChars - 2)).trimEnd()}..`;
  return out;
}

/** "@ALICE_99" — the handle form drawn under each panel. */
export function cardHandle(username: unknown): string {
  const handle = sanitizeCardText(String(username ?? "").replace(/^@+/, ""), 17, "PLAYER");
  return `@${handle}`;
}

// ---------------------------------------------------------------------------
// RGBA raster + PNG encoding
// ---------------------------------------------------------------------------

type RGBA = [number, number, number, number];

export interface Raster {
  width: number;
  height: number;
  data: Uint8Array; // RGBA, row-major
}

function newRaster(width: number, height: number): Raster {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Source-over blend of one pixel. `a` is 0..1 coverage multiplied into colour alpha. */
function blend(r: Raster, x: number, y: number, c: RGBA, coverage = 1): void {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
  const i = (y * r.width + x) * 4;
  const sa = (c[3] / 255) * coverage;
  if (sa <= 0) return;
  const da = r.data[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  for (let k = 0; k < 3; k++) {
    const src = c[k];
    const dst = r.data[i + k];
    r.data[i + k] = Math.round((src * sa + dst * da * (1 - sa)) / (oa || 1));
  }
  r.data[i + 3] = Math.round(oa * 255);
}

function fillRoundedRect(r: Raster, x0: number, y0: number, w: number, h: number, radius: number, c: RGBA): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      // Distance outside the rounded corner, for a 1px anti-aliased edge.
      const cx = x < x0 + radius ? x0 + radius : x > x0 + w - 1 - radius ? x0 + w - 1 - radius : x;
      const cy = y < y0 + radius ? y0 + radius : y > y0 + h - 1 - radius ? y0 + h - 1 - radius : y;
      const d = Math.hypot(x - cx, y - cy) - radius;
      const coverage = d <= -0.5 ? 1 : d >= 0.5 ? 0 : 0.5 - d;
      blend(r, x, y, c, coverage);
    }
  }
}

function drawText(r: Raster, text: string, x0: number, y0: number, scale: number, c: RGBA): void {
  let x = x0;
  for (const ch of text) {
    const glyph = FONT[ch] ?? FONT[" "];
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (glyph[gy][gx] !== "#") continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) blend(r, x + gx * scale + dx, y0 + gy * scale + dy, c);
        }
      }
    }
    x += (GLYPH_W + 1) * scale;
  }
}

export function textWidth(text: string, scale: number): number {
  const n = [...text].length;
  return n === 0 ? 0 : n * (GLYPH_W + 1) * scale - scale;
}

/** A pill-shaped label: dark translucent background, light text. */
export function rasterizeLabel(text: string, scale: number, opts: { fg?: RGBA; bg?: RGBA; padX?: number; padY?: number } = {}): Raster {
  const fg = opts.fg ?? [255, 255, 255, 255];
  const bg = opts.bg ?? [0, 0, 0, 150];
  const padX = opts.padX ?? scale * 4;
  const padY = opts.padY ?? scale * 2;
  const w = textWidth(text, scale) + padX * 2;
  const h = GLYPH_H * scale + padY * 2;
  const r = newRaster(Math.max(1, w), Math.max(1, h));
  fillRoundedRect(r, 0, 0, r.width, r.height, Math.floor(r.height / 2), bg);
  drawText(r, text, padX, padY, scale, fg);
  return r;
}

/** The centred VS orb: gradient disc, white ring, bold "VS" with a drop shadow. */
export function rasterizeVsBadge(size = BADGE_SIZE): Raster {
  const r = newRaster(size, size);
  const c = (size - 1) / 2;
  const outer = size / 2 - 2;
  const ring = 9;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const cov = d <= outer - 0.5 ? 1 : d >= outer + 0.5 ? 0 : outer + 0.5 - d;
      if (cov <= 0) continue;
      if (d > outer - ring) {
        blend(r, x, y, [255, 255, 255, 255], cov);
      } else {
        // Radial gradient: brand pink at the centre to a deep magenta rim.
        const t = Math.min(1, d / (outer - ring));
        const col: RGBA = [
          Math.round(255 + (194 - 255) * t),
          Math.round(77 + (24 - 77) * t),
          Math.round(103 + (91 - 103) * t),
          255,
        ];
        blend(r, x, y, col, cov);
      }
    }
  }
  const scale = Math.max(2, Math.floor(size / 20));
  const tw = textWidth("VS", scale);
  const tx = Math.round(c - tw / 2);
  const ty = Math.round(c - (GLYPH_H * scale) / 2);
  drawText(r, "VS", tx + Math.ceil(scale / 3), ty + Math.ceil(scale / 3), scale, [60, 0, 20, 170]);
  drawText(r, "VS", tx, ty, scale, [255, 255, 255, 255]);
  return r;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  // `deflate` in CompressionStream is the zlib (RFC 1950) format PNG requires.
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function ihdr(width: number, height: number, bitDepth: number, colorType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = bitDepth;
  d[9] = colorType;
  return chunk("IHDR", d);
}

export async function encodePngRgba(r: Raster): Promise<Uint8Array> {
  const stride = r.width * 4;
  const raw = new Uint8Array((stride + 1) * r.height);
  for (let y = 0; y < r.height; y++) raw.set(r.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return concat([PNG_SIGNATURE, ihdr(r.width, r.height, 8, 6), chunk("IDAT", await zlibDeflate(raw)), chunk("IEND", new Uint8Array(0))]);
}

/**
 * The 1080x1920 canvas as a 1-bit palette PNG: left half creator-red, right half
 * joiner-blue. Rows are a zeroed buffer plus a constant byte pattern, so this is
 * essentially free regardless of size.
 */
export async function encodeCanvasPng(width = CARD_WIDTH, height = CARD_HEIGHT): Promise<Uint8Array> {
  const rowBytes = Math.ceil(width / 8);
  const row = new Uint8Array(rowBytes + 1);
  const split = Math.floor(width / 2);
  for (let x = split; x < width; x++) row[1 + (x >> 3)] |= 0x80 >> (x & 7);
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) raw.set(row, y * (rowBytes + 1));
  const palette = new Uint8Array([0x2a, 0x0d, 0x18, 0x0d, 0x18, 0x2c]);
  return concat([
    PNG_SIGNATURE,
    ihdr(width, height, 1, 3),
    chunk("PLTE", palette),
    chunk("IDAT", await zlibDeflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export interface VsSideInput {
  /** Trusted entry bytes (R2 object or Bunny poster), already size-checked. */
  bytes: Uint8Array;
  username: string;
}

export interface VsRenderInput {
  left: VsSideInput;
  right: VsSideInput;
  title: string;
  kind: "photo" | "video";
}

export interface VsRenderOutput {
  bytes: Uint8Array;
  contentType: "image/jpeg";
  width: number;
  height: number;
  /** What was drawn, for metadata and tests. */
  labels: { left: string; right: string; title: string };
}

export interface VsRenderer {
  readonly id: string;
  render(input: VsRenderInput): Promise<VsRenderOutput>;
}

/** Thrown for inputs that can never render (malformed, unsupported, too small). */
export class VsMediaError extends Error {
  constructor(public readonly reason: string, message?: string) {
    super(message || reason);
  }
}

/** Accepted decoded formats. SVG is refused: it is a document, not a photo. */
const RENDERABLE_FORMATS = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "image/heic", "image/heif"]);
const MIN_DIMENSION = 64;
const MAX_DIMENSION = 12_000;

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> => new Blob([bytes]).stream() as ReadableStream<Uint8Array>;

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Badge PNG is identical for every card; build it once per isolate. */
let badgePng: Promise<Uint8Array> | null = null;
let canvasPng: Promise<Uint8Array> | null = null;

export function imagesBindingRenderer(images: ImagesBinding): VsRenderer {
  return {
    id: "cf-images-binding",
    async render(input: VsRenderInput): Promise<VsRenderOutput> {
      for (const side of [input.left, input.right]) {
        let info: ImageInfoResponse;
        try {
          info = await images.info(streamOf(side.bytes));
        } catch (e: any) {
          // 9412 = not an image. Any decode failure is a property of the file.
          throw new VsMediaError("malformed_media", e?.message || "entry could not be decoded");
        }
        if (!RENDERABLE_FORMATS.has(info.format) || !("width" in info)) {
          throw new VsMediaError("unsupported_format", `unsupported entry format ${info.format}`);
        }
        if (
          info.width < MIN_DIMENSION || info.height < MIN_DIMENSION ||
          info.width > MAX_DIMENSION || info.height > MAX_DIMENSION
        ) {
          throw new VsMediaError("unsupported_dimensions", `entry is ${info.width}x${info.height}`);
        }
      }

      const layout = planVsLayout();
      const labels = {
        left: cardHandle(input.left.username),
        right: cardHandle(input.right.username),
        title: sanitizeCardText(input.title, 24, "TOPHUNT BATTLE"),
      };
      const footer = input.kind === "video" ? "TOPHUNT  VIDEO BATTLE" : "TOPHUNT  PHOTO BATTLE";

      const nameScale = 4;
      const [leftName, rightName, title, foot] = await Promise.all([
        encodePngRgba(rasterizeLabel(labels.left, nameScale)),
        encodePngRgba(rasterizeLabel(labels.right, nameScale)),
        encodePngRgba(rasterizeLabel(labels.title, 6, { bg: [0, 0, 0, 120] })),
        encodePngRgba(rasterizeLabel(footer, 3, { fg: [255, 255, 255, 190], bg: [0, 0, 0, 0] })),
      ]);
      badgePng ||= encodePngRgba(rasterizeVsBadge(layout.badge.width));
      canvasPng ||= encodeCanvasPng(layout.width, layout.height);
      const [badge, canvas] = await Promise.all([badgePng, canvasPng]);

      const labelW = (text: string, scale: number, padX = scale * 4) => textWidth(text, scale) + padX * 2;
      const centred = (cx: number, w: number) => Math.round(cx - w / 2);

      const panel = (bytes: Uint8Array) =>
        images
          .input(streamOf(bytes))
          // `cover` + saliency gravity: fill the 9:16 panel without stretching,
          // cropping around the detected subject rather than the geometric centre.
          // `background` flattens transparent PNG/WebP onto black.
          .transform({
            width: PANEL_W - PANEL_BORDER * 2,
            height: PANEL_H - PANEL_BORDER * 2,
            fit: "cover",
            gravity: "auto",
            background: "#000000",
          })
          .transform({ border: { color: "#FFFFFF", width: PANEL_BORDER } });

      const result = await images
        .input(streamOf(canvas))
        .draw(panel(input.left.bytes), { left: layout.leftPanel.left, top: layout.leftPanel.top })
        .draw(panel(input.right.bytes), { left: layout.rightPanel.left, top: layout.rightPanel.top })
        .draw(streamOf(leftName), { left: centred(layout.leftNameCenterX, labelW(labels.left, nameScale)), top: layout.nameTop })
        .draw(streamOf(rightName), { left: centred(layout.rightNameCenterX, labelW(labels.right, nameScale)), top: layout.nameTop })
        .draw(streamOf(title), { left: centred(layout.width / 2, labelW(labels.title, 6)), top: layout.titleTop })
        .draw(streamOf(foot), { left: centred(layout.width / 2, labelW(footer, 3)), top: layout.footerTop })
        .draw(streamOf(badge), { left: layout.badge.left, top: layout.badge.top })
        .output({ format: "image/jpeg", quality: 85 });

      const bytes = await readAll(result.image());
      return { bytes, contentType: "image/jpeg", width: layout.width, height: layout.height, labels };
    },
  };
}

/** Test seam: drop the per-isolate badge/canvas memo. */
export function resetVsCompositeCacheForTests(): void {
  badgePng = null;
  canvasPng = null;
}
