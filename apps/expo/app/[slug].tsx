// Root-level permalink for the original tophunt.in blog URLs, e.g.
//   https://tophunt.in/amazon-cadbury-vday-quiz-answers
// These posts were at the site root (not /blog/<slug>), so we resolve a bare
// single-segment path to a blog post here. Static routes (home, splash, auth,
// blog, contest, …) take precedence, so this only catches unknown slugs.
export { default } from '@/src/screens/BlogDetailScreen';
