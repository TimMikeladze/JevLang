import { fileURLToPath } from 'node:url';

// jevlang is symlinked from the repo root (file:../..), so the bundler root has
// to include it. An app that installs jevlang from npm can drop this file.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // Load jevlang from node_modules at runtime rather than bundling its CLI providers.
  serverExternalPackages: ['jevlang'],
  agentRules: false,
  // The landing page and reference are static files from site/build.js
  // (copied into public/ by scripts/site.js); the examples live under /examples.
  async rewrites() {
    return { beforeFiles: [
      { source: '/', destination: '/index.html' },
      { source: '/reference', destination: '/reference.html' },
    ] };
  },
  async redirects() {
    // No examples index: the nav's Examples dropdown is the way in.
    return [
      { source: '/examples', destination: '/examples/maintenance', permanent: false },
      ...['maintenance', 'reservation', 'doorstep'].map(name => ({ source: `/${name}`, destination: `/examples/${name}`, permanent: true })),
    ];
  },
};
