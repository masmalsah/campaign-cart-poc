// Splices dist/preload-manifest.json (emitted by the loader-preload-manifest
// plugin in vite.config.ts) into dist/loader.js. Runs as its own build step
// because Vite copies public/ into dist/ after plugin hooks, so a hook-time
// patch of dist/loader.js gets overwritten by the pristine public/ copy.
import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const placeholder = '/*__NEXT_PRELOAD_LIST__*/[]';

const manifest = JSON.parse(
  await readFile(resolve(dist, 'preload-manifest.json'), 'utf8')
);
const loaderPath = resolve(dist, 'loader.js');
const src = await readFile(loaderPath, 'utf8');
if (!src.includes(placeholder)) {
  throw new Error(`patch-loader-preload: placeholder missing in ${loaderPath}`);
}
await writeFile(loaderPath, src.replace(placeholder, JSON.stringify(manifest)));
console.log(
  `patch-loader-preload: injected ${manifest.length} chunk paths into dist/loader.js`
);
