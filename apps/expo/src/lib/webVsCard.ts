/**
 * Web fallback VS card, drawn straight onto a Canvas 2D context.
 *
 * The canonical VS image is rendered by the Worker (`lib/vsPublication.ts`).
 * When that image is late or the renderer is failing, a share sheet would
 * otherwise sit on "Preparing the VS image…" forever. This draws an equivalent
 * 1080×1920 card in the browser from the two entries, so image sharing still
 * works.
 *
 * Canvas, NOT a DOM screenshot: drawing decoded bitmaps from local `blob:`
 * copies (src/lib/shareMedia.ts) has none of html-to-image's failure modes (CORS
 * taint, fonts, Safari quirks, huge clones).
 *
 * Web-only, no react-native imports. Every failure throws; callers treat that as
 * "no image".
 */
import { readImageBlob, withTimeout } from './shareMedia';

export interface VsCardSide {
  /** An ORIGINAL media url (not a `/cdn-cgi/` variant), or a poster still. */
  imageUrl: string | null;
  username: string;
}

export interface VsCardInput {
  left: VsCardSide;
  right: VsCardSide;
  title: string;
  kind: 'photo' | 'video';
}

const W = 1080;
const H = 1920;
const GUTTER = 28;
const PANEL_W = (W - GUTTER * 3) / 2;
const PANEL_H = 900;
const PANEL_TOP = 420;
const FONT = '"Urbanist-Bold", "Urbanist", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

type Drawable = ImageBitmap | HTMLImageElement;

async function loadBitmap(url: string): Promise<Drawable> {
  const blob = await readImageBlob(url);
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* Safari < 17 cannot decode some types this way; fall through */
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('image decode failed'));
        img.src = objectUrl;
      }),
      8000,
      'image decode',
    );
    return img;
  } finally {
    // Safe once loaded: the decoded image stays drawable.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draw `img` covering the box (like CSS object-fit: cover), clipped to a rounded rect. */
function drawCover(ctx: CanvasRenderingContext2D, img: Drawable, x: number, y: number, w: number, h: number, r: number) {
  const iw = (img as any).width || (img as any).naturalWidth;
  const ih = (img as any).height || (img as any).naturalHeight;
  const scale = Math.max(w / iw, h / ih);
  const sw = w / scale;
  const sh = h / scale;
  // Bias the crop slightly upwards: faces sit in the upper third of most entries.
  const sx = (iw - sw) / 2;
  const sy = Math.max(0, Math.min(ih - sh, (ih - sh) * 0.35));
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.clip();
  ctx.drawImage(img as any, sx, sy, sw, sh, x, y, w, h);
  ctx.restore();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, size: number, min = 22): number {
  let s = size;
  ctx.font = `700 ${s}px ${FONT}`;
  while (s > min && ctx.measureText(text).width > maxWidth) {
    s -= 2;
    ctx.font = `700 ${s}px ${FONT}`;
  }
  return s;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

function pill(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, size: number, maxWidth: number, bg: string, fg: string) {
  fitText(ctx, text, maxWidth - size, size);
  const label = ellipsize(ctx, text, maxWidth - size);
  const tw = ctx.measureText(label).width;
  const padX = size * 0.7;
  const h = size * 1.7;
  ctx.fillStyle = bg;
  roundRect(ctx, cx - tw / 2 - padX, y, tw + padX * 2, h, h / 2);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, y + h / 2 + 1);
}

function placeholder(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, initial: string) {
  ctx.save();
  roundRect(ctx, x, y, w, h, 34);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `700 160px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initial.toUpperCase(), x + w / 2, y + h / 2);
  ctx.restore();
}

/** Render the card to a JPEG Blob. Throws on any failure (no canvas, unreadable photo, timeout). */
export async function renderVsCardBlob(input: VsCardInput, opts: { timeoutMs?: number } = {}): Promise<Blob> {
  if (typeof document === 'undefined') throw new Error('VS card: no document');
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('VS card: no 2D context');

  const work = (async () => {
    // Both photos are required: a two-player card with one face is a lie.
    const [a, b] = await Promise.all([
      input.left.imageUrl ? loadBitmap(input.left.imageUrl) : Promise.reject(new Error('VS card: left image missing')),
      input.right.imageUrl ? loadBitmap(input.right.imageUrl) : Promise.reject(new Error('VS card: right image missing')),
    ]);
    try {
      await withTimeout((document as any).fonts?.ready ?? Promise.resolve(), 2000, 'fonts');
    } catch {
      /* system font fallback is fine */
    }

    // Background
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#2A0B33');
    g.addColorStop(0.35, '#5B1146');
    g.addColorStop(0.75, '#C2185B');
    g.addColorStop(1, '#FF4D67');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W / 2, PANEL_TOP + PANEL_H / 2, 40, W / 2, PANEL_TOP + PANEL_H / 2, 620);
    glow.addColorStop(0, 'rgba(255,215,0,0.22)');
    glow.addColorStop(1, 'rgba(255,215,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Brand + title
    pill(ctx, 'TopHunt', W / 2, 96, 46, 420, '#FFFFFF', '#111111');
    ctx.fillStyle = '#FFD700';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    fitText(ctx, 'VS BATTLE', W - 120, 92);
    ctx.fillText('VS BATTLE', W / 2, 290);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    const title = (input.title || '').trim() || 'TopHunt Battle';
    fitText(ctx, title, W - 160, 44);
    ctx.fillText(ellipsize(ctx, title, W - 160), W / 2, 360);

    // Panels
    const leftX = GUTTER;
    const rightX = GUTTER * 2 + PANEL_W;
    for (const [img, x] of [
      [a, leftX],
      [b, rightX],
    ] as const) {
      ctx.fillStyle = '#FFD700';
      roundRect(ctx, x - 8, PANEL_TOP - 8, PANEL_W + 16, PANEL_H + 16, 42);
      ctx.fill();
      if (img) drawCover(ctx, img, x, PANEL_TOP, PANEL_W, PANEL_H, 34);
      else placeholder(ctx, x, PANEL_TOP, PANEL_W, PANEL_H, '?');
    }

    // VS badge
    const cx = W / 2;
    const cy = PANEL_TOP + PANEL_H / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 30;
    ctx.beginPath();
    ctx.arc(cx, cy, 118, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.restore();
    const badge = ctx.createRadialGradient(cx, cy, 10, cx, cy, 108);
    badge.addColorStop(0, '#FF4D67');
    badge.addColorStop(1, '#C2185B');
    ctx.beginPath();
    ctx.arc(cx, cy, 108, 0, Math.PI * 2);
    ctx.fillStyle = badge;
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `800 104px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VS', cx, cy + 4);

    // Handles
    const nameY = PANEL_TOP + PANEL_H + 48;
    const handle = (u: string) => `@${String(u || 'player').replace(/^@+/, '')}`;
    pill(ctx, handle(input.left.username), leftX + PANEL_W / 2, nameY, 44, PANEL_W, 'rgba(0,0,0,0.38)', '#FFFFFF');
    pill(ctx, handle(input.right.username), rightX + PANEL_W / 2, nameY, 44, PANEL_W, 'rgba(0,0,0,0.38)', '#FFFFFF');

    // Footer
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `700 54px ${FONT}`;
    ctx.fillText('Vote. Battle. Win.', W / 2, H - 170);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = `600 40px ${FONT}`;
    ctx.fillText(`${input.kind === 'video' ? 'Video' : 'Photo'} battle · tophunt.in`, W / 2, H - 105);

    for (const img of [a, b]) (img as any)?.close?.();

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('VS card: encode failed'))), 'image/jpeg', 0.9);
    });
  })();
  return withTimeout(work, opts.timeoutMs ?? 20_000, 'VS card');
}

/** A side of a match payload -> the still to draw (original photo, or a video poster). */
export function vsStillFor(side: any, posterFor?: (mediaUrl: string) => string | null): string | null {
  if (!side) return null;
  const media = typeof side.mediaUrl === 'string' ? side.mediaUrl : null;
  if (!media) return null;
  if (side.mediaType === 'video') return posterFor?.(media) ?? null;
  return media;
}

/** Build the card input from a match payload. Null when either side has no drawable still. */
export function vsCardInputFromMatch(match: any, posterFor?: (mediaUrl: string) => string | null): VsCardInput | null {
  if (!match?.userA || !match?.userB) return null;
  const left = vsStillFor(match.userA, posterFor);
  const right = vsStillFor(match.userB, posterFor);
  if (!left || !right) return null;
  return {
    left: { imageUrl: left, username: match.userA.username || 'player' },
    right: { imageUrl: right, username: match.userB.username || 'player' },
    title: match.title || '',
    kind: match.type === 'video' ? 'video' : 'photo',
  };
}
