import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export function compressCatalog(path, check = false) {
  const raw = readFileSync(path);
  JSON.parse(raw.toString('utf8'));
  const packed = gzipSync(raw, { level: 9 });
  packed.fill(0, 4, 8);
  packed[9] = 255;
  if (check) {
    let existing;
    try { existing = readFileSync(`${path}.gz`); } catch { throw new Error(`missing generated catalog: ${path}.gz`); }
    if (!packed.equals(existing)) throw new Error(`stale generated catalog: ${path}.gz`);
  } else {
    writeFileSync(`${path}.gz`, packed);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(a => a !== '--check') || args.length > 1) throw new Error('usage: compress-telemt-catalog.mjs [--check]');
    compressCatalog(fileURLToPath(new URL('../internal/httpapi/telemt_config_catalog_3_5_5.json', import.meta.url)), args.includes('--check'));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
