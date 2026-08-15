import { Platform } from 'react-native';
import { useEffect } from 'react';

/**
 * Client-side <head> management for the web SPA.
 *
 * The edge Worker (seo/worker.js) sets correct meta in the *initial* HTML for
 * crawlers. This hook keeps the tab title + meta in sync during *client-side*
 * navigation (when React Router swaps screens without a full page load), so the
 * title/description/canonical/OG stay accurate for users and for crawlers that
 * re-read the DOM after hydration. No-op on native.
 */

const SITE_NAME = 'TopHunt';

export interface WebSeo {
  title?: string;
  description?: string;
  canonical?: string;
  image?: string;
  type?: 'article' | 'website';
}

function setMeta(attr: 'name' | 'property', key: string, content?: string) {
  if (!content) return;
  let el = document.head.querySelector(`meta[${attr}="${key}"]`) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function setCanonical(href?: string) {
  if (!href) return;
  let el = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', 'canonical');
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

export function applyWebSeo(seo: WebSeo) {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return;
  const fullTitle = seo.title
    ? /tophunt/i.test(seo.title)
      ? seo.title
      : `${seo.title} | ${SITE_NAME}`
    : SITE_NAME;
  document.title = fullTitle;
  setMeta('name', 'description', seo.description);
  setCanonical(seo.canonical);
  setMeta('property', 'og:title', fullTitle);
  setMeta('property', 'og:description', seo.description);
  setMeta('property', 'og:type', seo.type || 'website');
  if (seo.canonical) setMeta('property', 'og:url', seo.canonical);
  if (seo.image) setMeta('property', 'og:image', seo.image);
  setMeta('name', 'twitter:card', seo.image ? 'summary_large_image' : 'summary');
  setMeta('name', 'twitter:title', fullTitle);
  setMeta('name', 'twitter:description', seo.description);
  if (seo.image) setMeta('name', 'twitter:image', seo.image);
}

/** Hook wrapper: applies SEO whenever the given values change. */
export function useWebSeo(seo: WebSeo) {
  useEffect(() => {
    applyWebSeo(seo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seo.title, seo.description, seo.canonical, seo.image, seo.type]);
}
