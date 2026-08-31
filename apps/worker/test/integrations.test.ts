import { describe, expect, it, vi, afterEach } from 'vitest';

// The SMS/email providers call fetch; the harness gives us a real D1-backed env.
import { makeEnv, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { openSecret, sealSecret, secretStorageAvailable } from '../src/lib/secretBox';
import {
  deleteSecret,
  getIntegrations,
  getRazorpayCredentials,
  integrationSecretStatus,
  invalidateIntegrationCache,
  putSecret,
  resolveSecret,
  saveIntegrations,
  validateIntegrations,
  DEFAULT_INTEGRATIONS,
} from '../src/lib/integrations';
import { sendSmsDetailed } from '../src/lib/sms';
import { sendEmailDetailed, emailConfigured } from '../src/lib/email';

// base64("test-encryption-key-for-unit-tests") — a fixed test vector, not a
// credential. Named to avoid tripping secret scanners.
const TEST_PASSPHRASE = 'dGVzdC1lbmNyeXB0aW9uLWtleS1mb3ItdW5pdC10ZXN0cw==';

function env(overrides: Partial<TestEnv> = {}) {
  const { env } = makeEnv({ SETTINGS_ENCRYPTION_KEY: TEST_PASSPHRASE, ...overrides });
  invalidateIntegrationCache();
  return env;
}

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateIntegrationCache();
});

// ===========================================================================
describe('secretBox', () => {
  it('round-trips a value and never stores it in the clear', async () => {
    const e = env();
    const sealed = await sealSecret(e as any, 'super-secret-api-key');

    expect(sealed.ciphertext).not.toContain('super-secret');
    expect(sealed.hint).toBe('••••-key');
    expect(await openSecret(e as any, sealed)).toBe('super-secret-api-key');
  });

  it('produces different ciphertext for the same value (random IV)', async () => {
    const e = env();
    const a = await sealSecret(e as any, 'same-value');
    const b = await sealSecret(e as any, 'same-value');

    expect(a.ciphertext).not.toBe(b.ciphertext);
    // ...but the fingerprint is stable, which is how the panel shows WHICH value
    // is stored without revealing it.
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('refuses to decrypt tampered ciphertext instead of returning garbage', async () => {
    const e = env();
    const sealed = await sealSecret(e as any, 'original');

    // Flip a bit in the ciphertext BYTES. The obvious version of this — replacing
    // the last base64 character with 'A' — is a no-op whenever that character is
    // already 'A', so it passed locally and failed in CI roughly one run in 64.
    // Mutating the decoded bytes always changes the value.
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    const tampered = { ...sealed, ciphertext: bytes.toString('base64') };
    expect(tampered.ciphertext).not.toBe(sealed.ciphertext);

    await expect(openSecret(e as any, tampered)).rejects.toThrow();
  });

  it('cannot decrypt with a different encryption key', async () => {
    const sealed = await sealSecret(env() as any, 'original');
    // Rotating SETTINGS_ENCRYPTION_KEY must invalidate existing ciphertext rather
    // than silently succeed off a warm key cache.
    const other = makeEnv({ SETTINGS_ENCRYPTION_KEY: 'a-completely-different-key' }).env;

    await expect(openSecret(other as any, sealed)).rejects.toThrow();
  });

  it('reports storage as unavailable when no encryption key is configured', () => {
    expect(secretStorageAvailable(makeEnv().env as any)).toBe(false);
    expect(secretStorageAvailable(env() as any)).toBe(true);
  });
});

// ===========================================================================
describe('credential resolution', () => {
  it('prefers a panel-managed value over the environment', async () => {
    const e = env({ RESEND_API_KEY: 'from-environment' });

    expect(await resolveSecret(e as any, 'RESEND_API_KEY')).toBe('from-environment');

    await putSecret(e as any, 'RESEND_API_KEY', 'from-panel', 'admin-1');
    expect(await resolveSecret(e as any, 'RESEND_API_KEY')).toBe('from-panel');
  });

  it('falls back to the environment when the panel value is removed', async () => {
    const e = env({ RESEND_API_KEY: 'from-environment' });
    await putSecret(e as any, 'RESEND_API_KEY', 'from-panel', 'admin-1');
    expect(await resolveSecret(e as any, 'RESEND_API_KEY')).toBe('from-panel');

    await deleteSecret(e as any, 'RESEND_API_KEY');
    expect(await resolveSecret(e as any, 'RESEND_API_KEY')).toBe('from-environment');
  });

  it('never writes the plaintext into the database', async () => {
    const e = env();
    await putSecret(e as any, 'MSG91_AUTH_KEY', 'plaintext-should-not-appear', 'admin-1');

    const row = await drizzleOf(e).select().from(schema.integrationSecrets)
      .where(eq(schema.integrationSecrets.name, 'MSG91_AUTH_KEY')).get();

    expect(row).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain('plaintext-should-not-appear');
    expect(row!.hint).toBe('••••pear');
  });

  it('reports which source is in effect, without leaking values', async () => {
    const e = env({ RESEND_API_KEY: 'from-environment' });
    await putSecret(e as any, 'MSG91_AUTH_KEY', 'panel-value', 'admin-1');

    const status = await integrationSecretStatus(e as any);
    const byName = Object.fromEntries(status.map((s) => [s.name, s]));

    expect(byName.MSG91_AUTH_KEY.source).toBe('panel');
    expect(byName.RESEND_API_KEY.source).toBe('environment');
    expect(byName.BREVO_API_KEY.source).toBe('unset');
    // The whole payload must be free of secret material.
    expect(JSON.stringify(status)).not.toContain('panel-value');
    expect(JSON.stringify(status)).not.toContain('from-environment');
  });

  it('rejects credentials that are not on the allow-list', async () => {
    const e = env();
    await expect(putSecret(e as any, 'SOME_RANDOM_KEY', 'x', null)).rejects.toThrow(/Unknown credential/);
  });

  it('refuses to store a credential when the server has no encryption key', async () => {
    const e = makeEnv().env; // no SETTINGS_ENCRYPTION_KEY
    await expect(putSecret(e as any, 'RESEND_API_KEY', 'x', null)).rejects.toThrow(/SETTINGS_ENCRYPTION_KEY/);
  });

  it('validates the Firebase service account is a usable key file', async () => {
    const e = env();
    await expect(
      putSecret(e as any, 'FIREBASE_SERVICE_ACCOUNT', '{"not":"a key"}', null),
    ).rejects.toThrow(/client_email/);
    await expect(
      putSecret(
        e as any,
        'FIREBASE_SERVICE_ACCOUNT',
        JSON.stringify({ client_email: 'a@b.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----' }),
        null,
      ),
    ).resolves.toBeTruthy();
  });
});

// ===========================================================================
describe('integration config', () => {
  it('defaults to every provider disabled', async () => {
    const cfg = await getIntegrations(env() as any);
    expect(cfg.sms.provider).toBe('none');
    expect(cfg.email.provider).toBe('none');
    expect(cfg.video.provider).toBe('r2');
  });

  it('persists a provider change and serves it from cache', async () => {
    const e = env();
    await saveIntegrations(e as any, { sms: { ...DEFAULT_INTEGRATIONS.sms, provider: 'msg91', from: 'TOPHNT', templateId: 'tpl_1' } });

    const cfg = await getIntegrations(e as any);
    expect(cfg.sms.provider).toBe('msg91');
    expect(cfg.sms.from).toBe('TOPHNT');
  });

  it('rejects configurations that would fail at send time', () => {
    const base = structuredClone(DEFAULT_INTEGRATIONS);

    expect(() => validateIntegrations({ ...base, sms: { ...base.sms, provider: 'twilio', from: '' } }))
      .toThrow(/E.164|phone number/i);
    expect(() => validateIntegrations({ ...base, sms: { ...base.sms, provider: 'twilio', from: '9876543210' } }))
      .toThrow(/E.164/);
    expect(() => validateIntegrations({ ...base, sms: { ...base.sms, provider: 'msg91', from: 'TOPHNT', templateId: '' } }))
      .toThrow(/template/i);
    expect(() => validateIntegrations({ ...base, sms: { ...base.sms, provider: 'custom', customUrl: 'http://insecure' } }))
      .toThrow(/https/);
    expect(() => validateIntegrations({ ...base, email: { provider: 'resend', from: '', replyTo: '' } }))
      .toThrow(/From address/i);
    expect(() => validateIntegrations({ ...base, video: { provider: 'bunny', libraryId: '', cdnHostname: '' } }))
      .toThrow(/Library ID/i);
    expect(() => validateIntegrations({ ...base, video: { provider: 'bunny', libraryId: 'abc', cdnHostname: 'x.b-cdn.net' } }))
      .toThrow(/numeric/);
  });

  it('exposes the Razorpay key id from config with an environment fallback', async () => {
    const e = env({ RAZORPAY_KEY_ID: 'rzp_env', RAZORPAY_KEY_SECRET: 'secret_env' });
    expect((await getRazorpayCredentials(e as any)).keyId).toBe('rzp_env');

    await saveIntegrations(e as any, { payments: { razorpayKeyId: 'rzp_panel' } });
    const creds = await getRazorpayCredentials(e as any);
    expect(creds.keyId).toBe('rzp_panel');
    expect(creds.keySecret).toBe('secret_env');
  });
});

// ===========================================================================
describe('SMS gateway dispatch', () => {
  it('reports a clear error when no gateway is configured', async () => {
    const result = await sendSmsDetailed(env() as any, '9876543210', 'code 123456', '123456');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No SMS gateway/);
  });

  it('sends through MSG91 with the DLT template and normalised number', async () => {
    const e = env();
    await putSecret(e as any, 'MSG91_AUTH_KEY', 'msg91-key', null);
    await saveIntegrations(e as any, {
      sms: { ...DEFAULT_INTEGRATIONS.sms, provider: 'msg91', from: 'TOPHNT', templateId: 'tpl_9', otpVariable: 'otp' },
    });

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ type: 'success', request_id: 'req_1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendSmsDetailed(e as any, '+91 98765-43210', 'ignored for template gateways', '123456');

    expect(result.ok).toBe(true);
    expect(result.provider).toBe('msg91');
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toContain('msg91.com');
    expect((init.headers as any).authkey).toBe('msg91-key');
    const body = JSON.parse(init.body);
    expect(body.template_id).toBe('tpl_9');
    // 10-digit local number, prefixed once — not "+91+91…".
    expect(body.recipients[0].mobiles).toBe('919876543210');
    expect(body.recipients[0].otp).toBe('123456');
  });

  it('treats an HTTP 200 with an error payload as a failure', async () => {
    const e = env();
    await putSecret(e as any, 'MSG91_AUTH_KEY', 'msg91-key', null);
    await saveIntegrations(e as any, {
      sms: { ...DEFAULT_INTEGRATIONS.sms, provider: 'msg91', from: 'TOPHNT', templateId: 'tpl_9' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ type: 'error', message: 'DLT template not approved' }), { status: 200 })));

    const result = await sendSmsDetailed(e as any, '9876543210', 'x', '123456');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/DLT template not approved/);
  });

  it('sends through HanuOTP with the code, normalised number and template', async () => {
    const e = env();
    await putSecret(e as any, 'HANUOTP_API_KEY', 'hanu-key', null);
    await saveIntegrations(e as any, {
      sms: { ...DEFAULT_INTEGRATIONS.sms, provider: 'hanuotp', templateId: 'tpl_42' },
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'success', request_id: 'hz1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendSmsDetailed(e as any, '+91 98765-43210', 'ignored for template gateways', '123456');

    expect(result.ok).toBe(true);
    expect(result.provider).toBe('hanuotp');
    expect(result.id).toBe('hz1');
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(init?.method ?? 'GET').toBe('GET');
    expect(url).toContain('api.hanuotp.in/sms-otp.php');
    // 10-digit local number, the bare code, the key and the template id.
    expect(url).toContain('number=9876543210');
    expect(url).toContain('OTP=123456');
    expect(url).toContain('apikey=hanu-key');
    expect(url).toContain('templatesid=tpl_42');
  });

  it('defaults the HanuOTP template id to "default" when blank', async () => {
    const e = env();
    await putSecret(e as any, 'HANUOTP_API_KEY', 'hanu-key', null);
    await saveIntegrations(e as any, { sms: { ...DEFAULT_INTEGRATIONS.sms, provider: 'hanuotp' } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendSmsDetailed(e as any, '9876543210', 'x', '654321');

    const [url] = fetchMock.mock.calls[0] as any;
    expect(url).toContain('templatesid=default');
  });

  it('treats a HanuOTP 200 with an error payload as a failure', async () => {
    const e = env();
    await putSecret(e as any, 'HANUOTP_API_KEY', 'hanu-key', null);
    await saveIntegrations(e as any, { sms: { ...DEFAULT_INTEGRATIONS.sms, provider: 'hanuotp' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'error', message: 'invalid apikey' }), { status: 200 })));

    const result = await sendSmsDetailed(e as any, '9876543210', 'x', '123456');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid apikey/);
  });

  it('reports a missing HanuOTP key rather than sending', async () => {
    const e = env();
    await saveIntegrations(e as any, { sms: { ...DEFAULT_INTEGRATIONS.sms, provider: 'hanuotp' } });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendSmsDetailed(e as any, '9876543210', 'x', '123456');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/API key is not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('escapes placeholders in a custom gateway URL', async () => {
    const e = env();
    await putSecret(e as any, 'SMS_CUSTOM_TOKEN', 'tok&en', null);
    await saveIntegrations(e as any, {
      sms: {
        ...DEFAULT_INTEGRATIONS.sms,
        provider: 'custom',
        customUrl: 'https://gw.example.com/send?key={token}&to={to}&text={message}',
      },
    });
    const fetchMock = vi.fn(async () => new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendSmsDetailed(e as any, '9876543210', 'code 1 & 2', '123456');

    const [url] = fetchMock.mock.calls[0] as any;
    // A literal `&` in the token or message must not create a new query param.
    expect(url).toContain('key=tok%26en');
    expect(url).toContain('text=code%201%20%26%202');
  });

  it('never throws, even when the gateway connection fails', async () => {
    const e = env();
    await putSecret(e as any, 'FAST2SMS_API_KEY', 'f2s', null);
    await saveIntegrations(e as any, { sms: { ...DEFAULT_INTEGRATIONS.sms, provider: 'fast2sms', from: 'TOPHNT' } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const result = await sendSmsDetailed(e as any, '9876543210', 'x', '123456');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/network down/);
  });
});

describe('email gateway dispatch', () => {
  it('sends through Maileroo v2 with a Bearer key and a structured JSON body', async () => {
    const e = env();
    await putSecret(e as any, 'MAILEROO_API_KEY', 'maileroo-key', null);
    await saveIntegrations(e as any, {
      email: { ...DEFAULT_INTEGRATIONS.email, provider: 'maileroo', from: 'TopHunt <no-reply@tophunt.in>', replyTo: 'help@tophunt.in' },
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { reference_id: 'ref_9' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendEmailDetailed(e as any, {
      to: 'user@example.com',
      subject: 'Your code',
      html: '<b>123456</b>',
      text: '123456',
    });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe('maileroo');
    expect(result.id).toBe('ref_9');
    const [url, init] = fetchMock.mock.calls[0] as any;
    // v2 JSON endpoint, Bearer auth — NOT the legacy /send + X-API-Key, which is
    // what rejects a modern Sending Key as "invalid API key".
    expect(url).toBe('https://smtp.maileroo.com/api/v2/emails');
    expect((init.headers as any).Authorization).toBe('Bearer maileroo-key');
    expect((init.headers as any)['Content-Type']).toBe('application/json');
    const sent = JSON.parse(init.body);
    expect(sent.from).toEqual({ address: 'no-reply@tophunt.in', display_name: 'TopHunt' });
    expect(sent.to).toEqual([{ address: 'user@example.com', display_name: '' }]);
    expect(sent.subject).toBe('Your code');
    expect(sent.html).toBe('<b>123456</b>');
    expect(sent.plain).toBe('123456');
    expect(sent.reply_to).toEqual([{ address: 'help@tophunt.in', display_name: '' }]);
  });

  it('treats a Maileroo 200 with success:false as a failure', async () => {
    const e = env();
    await putSecret(e as any, 'MAILEROO_API_KEY', 'maileroo-key', null);
    await saveIntegrations(e as any, { email: { ...DEFAULT_INTEGRATIONS.email, provider: 'maileroo', from: 'a@b.com' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, message: 'domain not verified' }), { status: 200 })));

    const result = await sendEmailDetailed(e as any, { to: 'u@e.com', subject: 's', html: '<p>h</p>' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/domain not verified/);
  });

  it('reports a missing Maileroo key rather than sending', async () => {
    const e = env();
    await saveIntegrations(e as any, { email: { ...DEFAULT_INTEGRATIONS.email, provider: 'maileroo', from: 'a@b.com' } });
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendEmailDetailed(e as any, { to: 'u@e.com', subject: 's', html: '<p>h</p>' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/API key is not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports Maileroo ready in the health check once its key is set', async () => {
    const e = env();
    await saveIntegrations(e as any, { email: { ...DEFAULT_INTEGRATIONS.email, provider: 'maileroo', from: 'a@b.com' } });
    expect(await emailConfigured(e as any)).toBe(false);
    await putSecret(e as any, 'MAILEROO_API_KEY', 'maileroo-key', null);
    invalidateIntegrationCache();
    expect(await emailConfigured(e as any)).toBe(true);
  });
});
