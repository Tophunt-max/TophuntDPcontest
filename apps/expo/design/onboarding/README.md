# Onboarding art

Sources for `assets/images/onBordingLight4.webp` and `onBordingLight5.webp`. They use the same palette as slides 1–3: pink `#FF4D67`/`#FF6584`, navy `#2F2E41`/`#3F3D56`, grey `#F2F2F2`.

Export a source at 1200 px wide with any SVG renderer (resvg, Inkscape, Figma), convert it to WebP, then replace the file. Metro resolves the exact filename, so keep the `.webp` extension or update the `require()` calls in `app/onboarding/index.tsx` and `assets/images/index.js` in the same commit.

For a one-off change without a release, upload the image from the admin panel (System → Onboarding) instead.
