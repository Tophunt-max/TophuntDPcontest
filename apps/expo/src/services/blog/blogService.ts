import { readApi } from '../api';

export interface BlogPost {
  id: string;
  slug: string;
  title: string;
  excerpt?: string;
  content?: string;
  coverImageUrl?: string;
  category?: string;
  tags?: string[];
  author?: string;
  viewCount?: number;
  publishedAt?: number;
  createdAt: number;
}

export interface BlogListResult {
  posts: BlogPost[];
  nextCursor: number | null;
}

export interface BlogCategory {
  category: string;
  count: number;
}

/**
 * Blog reads hit the Cloudflare Worker /read/blog endpoints (D1). These are
 * public — no auth required — but readApi still attaches a token if signed in.
 */
export const blogService = {
  /**
   * Paginated list of published posts. Pass the previous nextCursor to load more.
   *
   * THROWS on failure, deliberately. This used to catch everything and return
   * `{ posts: [], nextCursor: null }`, which the screen renders as "No posts
   * yet." — so an unreachable API, a DNS failure, a CORS rejection and a
   * genuinely empty blog all produced the same confident, wrong statement that
   * the blog has no content. That cost real debugging time when the API host
   * changed: the page looked like a data problem and the only evidence was a
   * console line nobody sees on a phone.
   *
   * "I could not load this" and "there is nothing here" are different facts and
   * only the caller can render them differently.
   */
  getPosts: async (opts: { cursor?: number | null; category?: string; q?: string; limit?: number } = {}): Promise<BlogListResult> => {
    const res = (await readApi('/read/blog', {
      cursor: opts.cursor ?? undefined,
      category: opts.category,
      q: opts.q,
      limit: opts.limit ?? 12,
    })) as BlogListResult;
    // A 200 with an unexpected body is still a successful, empty read.
    return res && Array.isArray(res.posts) ? res : { posts: [], nextCursor: null };
  },

  /**
   * Distinct categories with counts, for the filter chips.
   *
   * Stays tolerant, unlike `getPosts`: the chips are a filter over content that
   * is fetched separately, so losing them degrades the screen instead of
   * emptying it. Failing here must not stop the posts from loading.
   */
  getCategories: async (): Promise<BlogCategory[]> => {
    try {
      const res = (await readApi('/read/blog/categories')) as BlogCategory[];
      return Array.isArray(res) ? res : [];
    } catch (error) {
      console.error('Error fetching blog categories:', error);
      return [];
    }
  },

  /** Single post by slug (or id). Returns null if not found / unpublished. */
  getPost: async (slugOrId: string): Promise<BlogPost | null> => {
    try {
      return (await readApi(`/read/blog/${encodeURIComponent(slugOrId)}`)) as BlogPost | null;
    } catch (error) {
      console.error('Error fetching blog post:', error);
      return null;
    }
  },
};
