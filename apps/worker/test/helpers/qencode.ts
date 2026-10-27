/**
 * A fake Qencode API plus the env/settings that make Qencode "live".
 *
 * Replaces `globalThis.fetch` for `https://api.qencode.com/*` only; any other
 * URL falls through to `passthrough` (default: a 404), so a test notices if code
 * starts calling something it did not expect.
 */
import { drizzleOf, type TestEnv } from './harness';
import * as schema from '../../src/db/schema';
import { invalidateIntegrationCache } from '../../src/lib/integrations';
import { resetQencodeTokenCache } from '../../src/lib/qencode';

/** Everything `qencodeConfig()` needs. */
export const QENCODE_ENV = {
  QENCODE_API_KEY: 'qk_test',
  R2_ACCOUNT_ID: 'acct123',
  R2_BUCKET: 'tophunt-media',
  R2_ACCESS_KEY_ID: 'AKIDTEST',
  R2_SECRET_ACCESS_KEY: 'secret-test',
};

/** Select Qencode in the admin settings (the provider switch). */
export async function selectVideoProvider(env: TestEnv, provider: 'qencode' | 'r2' = 'qencode') {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.settings)
    .values({ id: 'integrations', data: { video: { provider } } as any, updatedAt: ts })
    .onConflictDoUpdate({ target: schema.settings.id, set: { data: { video: { provider } } as any, updatedAt: ts } })
    .run();
  invalidateIntegrationCache();
  resetQencodeTokenCache();
}

export interface FakeJob {
  status: string;
  error?: number;
  error_description?: string | null;
  duration?: string;
}

export interface FakeQencode {
  /** task_token -> state returned by /v1/status. */
  jobs: Map<string, FakeJob>;
  /** Every start_encode2 call, with the parsed query. */
  started: { taskToken: string; query: any; payload: string | null }[];
  /** Paths called, in order. */
  calls: string[];
  /** Make start_encode2 fail (Qencode down). */
  failStart: boolean;
  /** Make /v1/status throw (network). */
  failStatus: boolean;
  restore: () => void;
}

export function installFakeQencode(passthrough?: (url: string, init?: any) => Promise<Response>): FakeQencode {
  const realFetch = globalThis.fetch;
  let taskSeq = 0;
  const state: FakeQencode = {
    jobs: new Map(),
    started: [],
    calls: [],
    failStart: false,
    failStatus: false,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.qencode.com/')) {
      return passthrough ? passthrough(url, init) : new Response('not found', { status: 404 });
    }
    const path = new URL(url).pathname;
    state.calls.push(path);
    const form = new URLSearchParams(String(init?.body ?? ''));
    const json = (body: any, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (path === '/v1/access_token') {
      if (form.get('api_key') !== QENCODE_ENV.QENCODE_API_KEY) return json({ error: 2, message: 'invalid api key' });
      return json({ error: 0, token: 'sess-token', expire: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (path === '/v1/create_task') {
      if (form.get('token') !== 'sess-token') return json({ error: 3, message: 'bad token' });
      taskSeq += 1;
      return json({ error: 0, task_token: `task-${taskSeq}`, upload_url: 'https://storage.qencode.com/v1/upload_file' });
    }
    if (path === '/v1/start_encode2') {
      if (state.failStart) return new Response('upstream down', { status: 503 });
      const taskToken = form.get('task_token') || '';
      state.started.push({ taskToken, query: JSON.parse(form.get('query') || '{}'), payload: form.get('payload') });
      state.jobs.set(taskToken, { status: 'queued' });
      return json({ error: 0, status_url: 'https://api.qencode.com/v1/status' });
    }
    if (path === '/v1/status') {
      if (state.failStatus) throw new TypeError('network down');
      const token = form.get('task_tokens') || '';
      const job = state.jobs.get(token);
      return json({ error: 0, statuses: job ? { [token]: { error: 0, error_description: null, ...job } } : {} });
    }
    return json({ error: 1, message: `unexpected ${path}` });
  }) as any;
  return state;
}

/** Write what a successful encode leaves in R2. */
export async function writeEncodedOutput(env: TestEnv, videoId: string, opts: { thumbnail?: boolean } = {}) {
  await env.MEDIA.put(`videos/${videoId}/playlist.m3u8`, '#EXTM3U');
  await env.MEDIA.put(`videos/${videoId}/video_1/playlist.m3u8`, '#EXTM3U');
  await env.MEDIA.put(`videos/${videoId}/video_1/segment-0.ts`, new Uint8Array([0x47]));
  if (opts.thumbnail !== false) {
    await env.MEDIA.put(`videos/${videoId}/thumbnail.jpg`, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
  }
}
