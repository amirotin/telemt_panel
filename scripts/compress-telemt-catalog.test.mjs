import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { compressCatalog } from './compress-telemt-catalog.mjs';

test('writes deterministic gzip and rejects missing or stale generated data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'catalog-gzip-'));
  try {
    const path = join(dir, 'catalog.json');
    writeFileSync(path, '{"version":"3.5.5","fields":[]}\n');
    assert.throws(() => compressCatalog(path, true), /missing|stale/);
    compressCatalog(path);
    const first = readFileSync(`${path}.gz`);
    assert.deepEqual(gunzipSync(first), readFileSync(path));
    assert.equal(first[9], 255);
    compressCatalog(path);
    assert.deepEqual(readFileSync(`${path}.gz`), first);
    compressCatalog(path, true);
    writeFileSync(path, '{"version":"3.5.6"}');
    assert.throws(() => compressCatalog(path, true), /stale/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
