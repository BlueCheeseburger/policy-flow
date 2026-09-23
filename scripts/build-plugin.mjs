// Builds the CardMirror plugin into cardmirror-plugin/dist/: plugin.js (one
// self-contained bundle) plus the manifest, which are the two assets a GitHub
// release needs to attach for CardMirror to install it.
//
// Run:  npm run build:plugin
//
// Not minified on purpose: a plugin runs with full access to the user's
// documents, so anyone installing it should be able to read what it does.

import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'cardmirror-plugin');
const out = join(dir, 'dist');

// Same public values the web app ships to every browser (see .env.example).
const env = Object.fromEntries(
  readFileSync(join(root, '.env'), 'utf8').split('\n')
    .map((l) => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]),
);
const url = process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (.env or environment).');

const manifest = JSON.parse(readFileSync(join(dir, 'cardmirror-plugin.json'), 'utf8'));

mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(dir, 'src', 'plugin.ts')],
  outfile: join(out, 'plugin.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  legalComments: 'inline',
  banner: { js: `// Policy Flow plugin for CardMirror v${manifest.version} — https://github.com/BlueCheeseburger/policy-flow` },
  define: {
    __PF_SUPABASE_URL__: JSON.stringify(url),
    __PF_SUPABASE_ANON_KEY__: JSON.stringify(key),
    __PF_PLUGIN_VERSION__: JSON.stringify(manifest.version),
  },
});
copyFileSync(join(dir, 'cardmirror-plugin.json'), join(out, 'cardmirror-plugin.json'));
console.log(`built cardmirror-plugin/dist (v${manifest.version})`);
