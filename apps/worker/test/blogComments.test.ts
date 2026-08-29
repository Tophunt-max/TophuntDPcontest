/**
 * Reader comments on blog articles (`blog_comments`).
 *
 * These sit on PUBLIC, search-indexed pages, which changes what can go wrong
 * compared with the in-app comment paths. Each block below pins a property that
 * fails silently — no error, no log, just wrong content on a page anyone can see:
 *
 *  1. TABLE ISOLATION. `targetType` is a string passed straight through from the
 *     client to a chain of branches in the Worker. An unhandled value lands in
 *     the `posts` branch, which writes `post_comments` and bumps
 *     `posts.comment_count`. A blog comment stored there would be invisible on
 *     the article, would appear in app moderation as a feed comment, and could
 *     corrupt a real post's counter.
 *  2. TARGET VALIDATION. There is no owner uid to block on a blog article, so the
 *     only guard available is the target itself. Without it, any string works as a
 *     targetId and produces orphan rows that no read path shows and no moderator
 *     ever sees, and drafts can collect public comments before publication.
 *  3. VISIBILITY AFTER A WRITE. The thread's first page is cached in KV. A comment
 *     that is stored but not shown for 30 seconds reads as "my comment vanished",
 *     which is exactly when a reader posts it again.
 *  4. DELETE AUTHORITY. Anyone must be able to remove their own comment and
 *     nobody else's — on an indexed page a wrongful delete is censorship and a
 *     missing one is published spam.
 *  5. THE `total` HEADING. It is the one number the UI shows, and it comes from a
 *     COUNT rather than the page length, so it has to be right on page one of a
 *     long thread.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

// Bypass Firebase token verification: the bearer token is "uid" or "uid:role".
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

// Engagement counters live in a Durable Object that cannot start in this
// harness. The blog branch never touches them — proving that is part of the
// point — but the shared handler imports them.
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 0, votesB: 0, total: 0, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({ like: 0, comment: 0, share: 0 }),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { commentsCacheKey } from '../src/lib/cache';

const app = makeApp();
let env: TestEnv;

async function call(uid: string, action: string, data: any = {}) {
  const res = await app.request(
    '/api',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` },
      body: JSON.stringify({ action, ...data }),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/** GET /read/comments as `uid`, or as a signed-out visitor when uid is null. */
async function readThread(uid: string | null, query: string) {
  const res = await app.request(
    `/read/comments?${query}`,
    { headers: uid ? { Authorization: `Bearer ${uid}` } : {} },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
}

async function admin(method: string, path: string) {
  const res = await app.request(
    `/admin${path}`,
    { method, headers: { 'X-Admin-Secret': 'test-admin-secret' } },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function seedUser(uid: string) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: `${uid} name`, dpcoin: 0, createdAt: ts, updatedAt: ts } as any);
}

async function seedArticle(id: string, over: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.blogPosts)
    .values({
      id,
      slug: over.slug ?? id,
      title: over.title ?? `Article ${id}`,
      status: over.status ?? 'published',
      publishedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    } as any);
}

const blogRows = () => drizzleOf(env).select().from(schema.blogComments).all();

beforeEach(async () => {
  ({ env } = makeEnv());
  // Seeded on EVERY test, not just the moderation one: `getBannedWords` caches
  // the list per module for 60s, so whichever test ran first would otherwise fix
  // an empty list for the rest of the file. No other text here contains it.
  await drizzleOf(env).insert(schema.bannedWords).values({ word: 'forbidden', createdAt: Date.now() } as any);
  await seedUser('reader');
  await seedUser('other');
  await seedArticle('a1');
});

// --- 1. table isolation -----------------------------------------------------
describe('blog comments are stored apart from app-feed comments', () => {
  it('writes blog_comments and leaves post_comments untouched', async () => {
    const res = await call('reader', 'addComment', { targetType: 'blog', targetId: 'a1', text: 'Nice read' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const blog = await blogRows();
    expect(blog).toHaveLength(1);
    expect(blog[0]).toMatchObject({ postId: 'a1', userId: 'reader', text: 'Nice read' });

    const appComments = await drizzleOf(env).select().from(schema.postComments).all();
    expect(appComments).toHaveLength(0);
  });

  it('does not bump posts.comment_count for a social post that shares the id', async () => {
    // A blog article id and a social post id are separate spaces, so they CAN
    // coincide. If the blog write fell through to the posts branch it would
    // silently increment this counter.
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.posts)
      .values({ id: 'a1', userId: 'other', commentCount: 0, likeCount: 0, createdAt: ts } as any);

    await call('reader', 'addComment', { targetType: 'blog', targetId: 'a1', text: 'hello' });

    const post = await drizzleOf(env).select().from(schema.posts).where(eq(schema.posts.id, 'a1')).get();
    expect(post?.commentCount).toBe(0);
  });

  it('gives the blog thread its own cache key, so it cannot serve a post thread', () => {
    expect(commentsCacheKey('blog', 'a1')).not.toBe(commentsCacheKey('posts', 'a1'));
    expect(commentsCacheKey('blog', 'a1')).not.toBe(commentsCacheKey('contestMatches', 'a1'));
  });
});

// --- 2. target validation ---------------------------------------------------
describe('the article being commented on must exist and be published', () => {
  it('refuses an unknown targetId instead of creating an orphan row', async () => {
    const res = await call('reader', 'addComment', { targetType: 'blog', targetId: 'nope', text: 'hi' });
    expect(res.status).toBe(404);
    expect(await blogRows()).toHaveLength(0);
  });

  it('refuses a draft article', async () => {
    await seedArticle('draft1', { status: 'draft' });
    const res = await call('reader', 'addComment', { targetType: 'blog', targetId: 'draft1', text: 'hi' });
    expect(res.status).toBe(404);
    expect(await blogRows()).toHaveLength(0);
  });

  it('rejects an empty comment and one past the length limit', async () => {
    expect((await call('reader', 'addComment', { targetType: 'blog', targetId: 'a1', text: '   ' })).status).toBe(400);
    const long = 'x'.repeat(501);
    expect((await call('reader', 'addComment', { targetType: 'blog', targetId: 'a1', text: long })).status).toBe(400);
    expect(await blogRows()).toHaveLength(0);
  });

  it('applies banned-word moderation, same as every other comment path', async () => {
    const res = await call('reader', 'addComment', {
      targetType: 'blog',
      targetId: 'a1',
      text: 'this is forbidden text',
    });
    expect(res.status).toBe(400);
    expect(await blogRows()).toHaveLength(0);
  });

  it('treats a repeated clientId as the same comment (retry-safe)', async () => {
    const payload = { targetType: 'blog', targetId: 'a1', text: 'once', clientId: 'fixed-token' };
    const first = await call('reader', 'addComment', payload);
    const second = await call('reader', 'addComment', payload);
    expect(first.body.commentId).toBe('fixed-token');
    expect(second.body.duplicate).toBe(true);
    expect(await blogRows()).toHaveLength(1);
  });
});

// --- 3. visibility ----------------------------------------------------------
describe('the thread is readable by anyone and fresh after a write', () => {
  it('serves comments to a signed-out visitor with the author name attached', async () => {
    await call('reader', 'addComment', { targetType: 'blog', targetId: 'a1', text: 'public words' });

    const res = await readThread(null, 'targetType=blog&targetId=a1');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ text: 'public words', username: 'reader', likes: 0 });
  });

  it('shows a new comment immediately even though the first page is cached', async () => {
    await call('reader', 'addComment', { targetType: 'blog', targetId: 'a1', text: 'first' });
    // Populate the cache.
    expect((await readThread(null, 'targetType=blog&targetId=a1')).body.items).toHaveLength(1);
    // A second comment must invalidate it.
    await call('other', 'addComment', { targetType: 'blog', targetId: 'a1', text: 'second' });
    const after = await readThread(null, 'targetType=blog&targetId=a1');
    expect(after.body.items.map((i: any) => i.text)).toEqual(['second', 'first']);
  });

  it('returns an empty thread (not an error) for an article with no comments', async () => {
    const res = await readThread(null, 'targetType=blog&targetId=a1');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('pages with a cursor and terminates', async () => {
    for (let i = 0; i < 3; i++) {
      await call('reader', 'addComment', { targetType: 'blog', targetId: 'a1', text: `c${i}`, clientId: `t${i}` });
    }
    const p1 = await readThread(null, 'targetType=blog&targetId=a1&limit=2');
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();

    const p2 = await readThread(null, `targetType=blog&targetId=a1&limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();

    // No id appears on both pages.
    const ids = [...p1.body.items, ...p2.body.items].map((i: any) => i.id);
    expect(new Set(ids).size).toBe(3);
  });
});

// --- 4. delete authority ----------------------------------------------------
describe('deleting a blog comment', () => {
  async function seedComment(uid: string, text = 'mine') {
    const res = await call(uid, 'addComment', { targetType: 'blog', targetId: 'a1', text });
    return res.body.commentId as string;
  }

  it('lets the author remove their own comment', async () => {
    const id = await seedComment('reader');
    const res = await call('reader', 'deleteComment', { targetType: 'blog', targetId: 'a1', commentId: id });
    expect(res.status).toBe(200);
    expect(await blogRows()).toHaveLength(0);
  });

  it("refuses another reader's comment", async () => {
    const id = await seedComment('reader');
    const res = await call('other', 'deleteComment', { targetType: 'blog', targetId: 'a1', commentId: id });
    expect(res.status).toBe(403);
    expect(await blogRows()).toHaveLength(1);
  });

  it('lets an admin remove any comment', async () => {
    const id = await seedComment('reader');
    // `isAdmin` accepts the role carried on the verified token, which the mock
    // above reads from "uid:role".
    const res = await call('mod:admin', 'deleteComment', { targetType: 'blog', targetId: 'a1', commentId: id });
    expect(res.status).toBe(200);
    expect(await blogRows()).toHaveLength(0);
  });

  it('goes with the author when their account is deleted', async () => {
    // The most visible way "delete my account" could fail: these are the only
    // rows the user leaves on a public, indexed page.
    await seedComment('reader');
    const { deleteOwnAccount } = await import('../src/lib/accountDeletion');
    await deleteOwnAccount(env as any, 'reader');
    expect(await blogRows()).toHaveLength(0);
  });
});

// --- 5. total ---------------------------------------------------------------
describe('the "Comments (N)" total', () => {
  it('counts the whole thread, not the page', async () => {
    for (let i = 0; i < 5; i++) {
      await call('reader', 'addComment', { targetType: 'blog', targetId: 'a1', text: `c${i}`, clientId: `k${i}` });
    }
    const res = await readThread(null, 'targetType=blog&targetId=a1&limit=2');
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(5);
  });

  it('is absent for app and match threads, which have no use for it', async () => {
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.posts)
      .values({ id: 'p1', userId: 'other', commentCount: 0, likeCount: 0, createdAt: ts } as any);
    await call('reader', 'addComment', { targetType: 'posts', targetId: 'p1', text: 'hi' });
    const res = await readThread(null, 'targetType=posts&targetId=p1');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBeUndefined();
  });
});

// --- admin moderation -------------------------------------------------------
describe('admin moderation of blog comments', () => {
  it('lists them with the article title, separately from app comments', async () => {
    await call('reader', 'addComment', { targetType: 'blog', targetId: 'a1', text: 'blog one' });
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.posts)
      .values({ id: 'p1', userId: 'other', commentCount: 0, likeCount: 0, createdAt: ts } as any);
    await call('reader', 'addComment', { targetType: 'posts', targetId: 'p1', text: 'app one' });

    const blog = await admin('GET', '/comments?target=blog');
    expect(blog.body.map((r: any) => r.text)).toEqual(['blog one']);
    expect(blog.body[0]).toMatchObject({ postTitle: 'Article a1', postSlug: 'a1', username: 'reader' });

    const appList = await admin('GET', '/comments');
    expect(appList.body.map((r: any) => r.text)).toEqual(['app one']);
  });

  it('deletes with ?target=blog and busts the public cache', async () => {
    const add = await call('reader', 'addComment', { targetType: 'blog', targetId: 'a1', text: 'spam' });
    // Warm the public thread cache first — a moderator delete that leaves the
    // comment on the page for another 30s is the failure that matters here.
    expect((await readThread(null, 'targetType=blog&targetId=a1')).body.items).toHaveLength(1);

    const res = await admin('DELETE', `/comments/${add.body.commentId}?target=blog`);
    expect(res.status).toBe(200);
    expect(await blogRows()).toHaveLength(0);
    expect((await readThread(null, 'targetType=blog&targetId=a1')).body.items).toEqual([]);
  });
});

// --- likes ------------------------------------------------------------------
describe('liking a blog comment', () => {
  it('updates the blog row, so the count reads back instead of staying 0', async () => {
    const add = await call('reader', 'addComment', { targetType: 'blog', targetId: 'a1', text: 'likeable' });
    const id = add.body.commentId;

    const on = await call('other', 'likeComment', { targetType: 'blog', commentId: id });
    expect(on.body).toMatchObject({ liked: true, likeCount: 1 });

    const off = await call('other', 'likeComment', { targetType: 'blog', commentId: id });
    expect(off.body).toMatchObject({ liked: false, likeCount: 0 });
  });

  it('reports likedByMe to the signed-in viewer only', async () => {
    const add = await call('reader', 'addComment', { targetType: 'blog', targetId: 'a1', text: 'likeable' });
    await call('other', 'likeComment', { targetType: 'blog', commentId: add.body.commentId });

    const mine = await readThread('other', 'targetType=blog&targetId=a1');
    expect(mine.body.items[0].likedByMe).toBe(true);
    // A signed-out read is publicly cacheable, so it must never carry a
    // per-viewer flag.
    const guest = await readThread(null, 'targetType=blog&targetId=a1');
    expect(guest.body.items[0].likedByMe).toBe(false);
  });
});
