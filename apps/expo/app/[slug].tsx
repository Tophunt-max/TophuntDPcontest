import BlogDetailScreen from '@/src/screens/BlogDetailScreen';

/**
 * Root-level permalink for the original tophunt.in blog URLs, e.g.
 *   https://tophunt.in/amazon-cadbury-vday-quiz-answers
 *
 * Those posts lived at the site root (not `/blog/<slug>`), so a bare
 * single-segment path is resolved to a blog post here. Static routes (home,
 * splash, auth, blog, contest, legal, setting, …) take precedence, so this only
 * catches slugs no real route claimed.
 *
 * The consequence worth knowing: this route swallows EVERY unknown one-segment
 * path, so `/settings` or any typo arrives here and never reaches
 * `app/+not-found.tsx`. `permalink` tells the screen that, so an unresolved slug
 * renders a real 404 and gets reported, instead of claiming a blog post is
 * missing and reporting nothing.
 */
export default function BlogPermalinkScreen() {
  return <BlogDetailScreen permalink />;
}
