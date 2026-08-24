// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', '.expo/*'],
  },
  {
    // The Firebase messaging service worker runs in a ServiceWorkerGlobalScope,
    // not in React Native — `importScripts` and the `firebase` global that
    // importScripts defines are legitimate there, so the default browser globals
    // flag them as undefined.
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        importScripts: 'readonly',
        firebase: 'readonly',
        self: 'readonly',
        clients: 'readonly',
      },
    },
  },
  {
    // The SEO worker is Cloudflare Workers code that happens to live in this
    // package, so it has the Workers runtime globals rather than RN's.
    files: ['seo/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        HTMLRewriter: 'readonly',
        caches: 'readonly',
        addEventListener: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
      },
    },
  },
]);
