import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';

const root = resolve(process.argv[2] || 'client-app/dist');
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]));
  return nested.flat();
}
const paths = (await files(root)).filter(path => !path.endsWith('/sw.js') && !path.endsWith('.map')).sort();
const hash = createHash('sha256');
for (const path of paths) hash.update(relative(root, path)).update(await readFile(path));
const assets = paths.map(path => `/app/${relative(root, path).split('/').map(encodeURIComponent).join('/')}`);
const worker = await readFile(resolve(root, 'sw.js'), 'utf8');
await writeFile(resolve(root, 'sw.js'), worker
  .replace('__BUILD_VERSION__', hash.digest('hex').slice(0, 16))
  .replace(/\/\* OFFLINE_ASSETS \*\/ \[[^;]+\]/, JSON.stringify(assets)));
console.log(`Offline shell: ${assets.length} public build assets`);
