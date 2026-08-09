/**
 * Static export, for GitHub Pages.
 *
 * Pages serves plain files — there is no Node process to render on demand — so
 * the whole site is emitted as HTML at build time. That suits what this site
 * is: every number on it was already decided when `capture.mjs` ran, so there
 * is nothing left for a server to compute.
 *
 * `basePath` is the one thing that cannot be hardcoded. A project page lives
 * under `/<repo>`, a user or organisation page and any custom domain live at
 * the root, and getting it wrong breaks every asset URL on the page rather
 * than failing loudly at build time. The deploy workflow sets it from the
 * repository it is actually deploying, so this file never has to guess.
 */

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  // GitHub Pages serves `/about` as `/about/index.html`; without this, every
  // route but the home page 404s once deployed while working perfectly in dev.
  trailingSlash: true,
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  // No Image Optimization server exists in a static export.
  images: { unoptimized: true },
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
