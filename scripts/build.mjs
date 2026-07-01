// @ts-nocheck
/**
 * Build the extension with esbuild into dist/.
 *
 * Why not @crxjs/vite-plugin? Its content scripts load the real code via a
 * dynamic import(), which is subject to the *page's* CSP. Crunchyroll's player
 * lives in a cross-origin iframe (static.crunchyroll.com/.../player.html) whose
 * CSP (`default-src 'self' ... *.crunchyroll.com`) has no chrome-extension:
 * source, so the dynamic import is blocked and the content script never runs
 * where the video actually is.
 *
 * Instead we bundle each entry as a single self-contained IIFE and list the
 * content script directly in the manifest. Manifest-declared content scripts are
 * injected by Chrome itself and bypass the page CSP, so they run inside the
 * locked-down player iframe.
 */
import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const r = (...p) => resolve(root, ...p);

// Single source of truth for the version: package.json.
const { version } = JSON.parse(await readFile(r('package.json'), 'utf8'));

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// Drop console.* in production builds; keep them when DEBUG=1 for local dev.
const debug = process.env.DEBUG === '1';

const common = {
  bundle: true,
  format: 'iife',
  target: 'es2021',
  logLevel: 'info',
  alias: { '@': r('src') },
  drop: debug ? [] : ['console'],
  minify: !debug, // keep dev builds readable; prod ships minified
};

// Bundle each entry to a single self-contained file (no code-splitting, no
// dynamic import -> nothing the page CSP can block).
await Promise.all([
  build({ ...common, entryPoints: [r('src/content/index.ts')], outfile: r('dist/content.js') }),
  build({ ...common, entryPoints: [r('src/background/service-worker.ts')], outfile: r('dist/service-worker.js') }),
  build({ ...common, entryPoints: [r('src/sidepanel/sidepanel.ts')], outfile: r('dist/sidepanel.js') }),
  build({ ...common, entryPoints: [r('src/options/options.ts')], outfile: r('dist/options.js') }),
]);

// HTML + CSS: copy and rewrite the dev script/style references to built files.
async function emitHtml(name) {
  let html = await readFile(r(`src/${name}/${name}.html`), 'utf8');
  html = html
    .replace(/<script[^>]*src="\.\/\w+\.ts"[^>]*><\/script>/, `<script src="./${name}.js"></script>`)
    .replace(/href="\.\/(\w+\.css)"/, 'href="./$1"')
    .replaceAll('__APP_VERSION__', version);
  await writeFile(r(`dist/${name}.html`), html);
  await cp(r(`src/${name}/${name}.css`), r(`dist/${name}.css`));
}
await emitHtml('sidepanel');
await emitHtml('options');

// Icons.
await mkdir(r('dist/icons'), { recursive: true });
for (const size of [16, 48, 128]) {
  await cp(r(`src/assets/icons/icon-${size}.png`), r(`dist/icons/icon-${size}.png`));
}

// Fonts: bundled locally (no runtime Google Fonts request — privacy + offline).
await cp(r('src/assets/fonts'), r('dist/fonts'), { recursive: true });

// Manifest (MV3, Chrome/Edge).
const manifest = {
  manifest_version: 3,
  name: 'Crunchyroll Companion',
  description:
    'Crunchyroll side panel: auto-skip intro/recap/outro/preview, auto-play next, and optional MyAnimeList sync.',
  version,
  minimum_chrome_version: '114',
  // Pins the local unpacked build to the PRODUCTION extension ID
  // (jbmbolipkbppndjookmhmpceipfekhmi) — this is the publisher public key from
  // the published .crx. Matching prod's ID keeps the OAuth redirect URL
  // (https://jbmbolipkbppndjookmhmpceipfekhmi.chromiumapp.org/) identical in dev
  // and prod, so MAL/Google sign-in works the same locally. The store re-signs
  // with this same key, and package.mjs strips `key` from the uploaded zip.
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvEvkXRomdtDoW+F2h6u2Klun8tT+5IkvkOkxwnPL5fDOedFEEZxwH9WbwbzbgFJrk258lLrRBO/RhSyywDG4WTEYJRheldrn2cxckxPtczm0BdokDas+ePjgI4o37oeC1XHm2edNCz+lQ0js7CThAH2SSCHVcy9fr1UHo6ETdvkjVxuDIAT6sKGeFABcVivjt5RlJUspxD+azhhc0AIlOcMhyz/JL3ogbadhGC4DMG8LerzqnjOgMG0pAQzQikQ0ncoV8FHE1RJmt0Eol95pd5j/OIqa1cVXgs1m8FqAgUic4bGFiORVs5pK8uyMiQn+UfhJzh+XtmYLhTJoJl0g3QIDAQAB',
  icons: { 16: 'icons/icon-16.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  action: {
    default_title: 'Crunchyroll Companion',
    default_icon: { 16: 'icons/icon-16.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  },
  side_panel: { default_path: 'sidepanel.html' },
  options_page: 'options.html',
  background: { service_worker: 'service-worker.js' },
  content_scripts: [
    {
      matches: ['*://*.crunchyroll.com/*'],
      js: ['content.js'],
      run_at: 'document_idle',
      all_frames: true,
    },
  ],
  permissions: ['storage', 'identity', 'sidePanel', 'alarms'],
  host_permissions: [
    '*://*.crunchyroll.com/*',
    '*://static.crunchyroll.com/*',
    'https://myanimelist.net/*',
    'https://api.myanimelist.net/*',
    'https://api.jikan.moe/*',
    'https://yoerrzzznpfcbsrrbocs.supabase.co/*',
  ],
};
await writeFile(r('dist/manifest.json'), JSON.stringify(manifest, null, 2));

console.log('Built extension to dist/');
