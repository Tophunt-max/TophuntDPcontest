/**
 * Battle entry screening: QR / payment screenshots are refused before upload.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { entryScreeningVerdict } from '@/src/lib/entryScreeningRules';

describe('entryScreeningVerdict', () => {
  it('a normal photo (no codes) passes', () => {
    expect(entryScreeningVerdict([])).toEqual({ ok: true });
    expect(entryScreeningVerdict(null)).toEqual({ ok: true });
  });

  it('a UPI / payment QR gets the payment message', () => {
    for (const data of [
      'upi://pay?pa=merchant@okicici&pn=Shop&am=100',
      'UPI://PAY?PA=someone@ybl',
      'https://paytm.me/abc',
      'https://rzp.io/l/xyz',
    ]) {
      const v = entryScreeningVerdict([{ type: 'qr', data }]);
      expect(v.ok, data).toBe(false);
      if (!v.ok) expect(v.reason, data).toBe('payment_qr');
    }
  });

  it('any other QR code is refused too (entries are photos)', () => {
    const v = entryScreeningVerdict([{ type: 'qr_code', data: 'https://example.com' }]);
    expect(v).toMatchObject({ ok: false, reason: 'qr_code' });
  });

  it('non-QR barcodes do not block (a product box in the background is fine)', () => {
    expect(entryScreeningVerdict([{ type: 'ean13', data: '8901234567890' }])).toEqual({ ok: true });
  });
});

describe('web scanner (BarcodeDetector)', () => {
  afterEach(() => {
    delete (globalThis as any).BarcodeDetector;
    vi.unstubAllGlobals();
  });

  it('fails open where the browser has no BarcodeDetector', async () => {
    const { screenEntryImage } = await import('@/src/lib/entryScreening.web');
    expect(await screenEntryImage('blob:x')).toEqual({ ok: true });
  });

  it('blocks a QR the browser finds', async () => {
    (globalThis as any).BarcodeDetector = class {
      static async getSupportedFormats() {
        return ['qr_code'];
      }
      async detect() {
        return [{ format: 'qr_code', rawValue: 'upi://pay?pa=a@b' }];
      }
    };
    vi.stubGlobal('createImageBitmap', async () => ({ close() {} }));
    vi.stubGlobal('fetch', async () => ({ blob: async () => new Blob(['x']) }));
    const { screenEntryImage } = await import('@/src/lib/entryScreening.web');
    expect(await screenEntryImage('blob:x')).toMatchObject({ ok: false, reason: 'payment_qr' });
  });
});
