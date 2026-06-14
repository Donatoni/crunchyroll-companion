// @ts-nocheck
/**
 * Package dist/ into a Chrome Web Store upload zip.
 *
 * The store assigns the extension ID itself, so the manifest `key` we use to pin
 * the ID for UNPACKED installs isn't needed here and is stripped. dist/ (with the
 * key, for local "Load unpacked") is left untouched — we stage a copy.
 *
 * Run after a build: `npm run package` (which builds first).
 */
import { cp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const r = (...p) => resolve(root, ...p);
const { version } = JSON.parse(await readFile(r('package.json'), 'utf8'));

const stage = r('.pkg');
await rm(stage, { recursive: true, force: true });
await cp(r('dist'), stage, { recursive: true });

const manifestPath = resolve(stage, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
delete manifest.key; // store-assigned ID; key only matters for unpacked installs
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

const zipName = `crunchy-companion-${version}.zip`;
await rm(r(zipName), { force: true });
execSync(`cd "${stage}" && zip -r -q "${r(zipName)}" .`);
await rm(stage, { recursive: true, force: true });

console.log(`Packaged ${zipName} for the Chrome Web Store (manifest key omitted).`);
