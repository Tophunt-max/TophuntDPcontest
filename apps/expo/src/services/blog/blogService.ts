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
  /** Paginated list of published posts. Pass the previous nextCursor to load more. */
  getPosts: async (opts: { cursor?: number | null; category?: string; q?: string; limit?: number } = {}): Promise<BlogListResult> => {
    try {
      const res = (await readApi('/read/blog', {
        cursor: opts.cursor ?? undefined,
        category: opts.category,
        q: opts.q,
        limit: opts.limit ?? 12,
      })) as BlogListResult;
      return res && Array.isArray(res.posts) ? res : { posts: [], nextCursor: null };
    } catch (error) {
      console.error('Error fetching blog posts:', error);
      return { posts: [], nextCursor: null };
    }
  },

  /** Distinct categories with counts, for the filter chips. */
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
