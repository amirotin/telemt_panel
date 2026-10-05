import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, truncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { measureBinarySizes, renderSizeSummary } from './report-binary-size.mjs';

test('measures all targets, byte limits and actual dist contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-size-test-'));
  try {
    const stage = join(dir, 'stage');
    const dist = join(dir, 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'index.html'), '12345');
    writeFileSync(join(dist, 'assets', 'index.js.gz'), '1234567890');
    for (const profile of ['full', 'lite']) {
      for (const arch of ['x86_64', 'aarch64']) {
        const path = join(stage, profile, arch, 'telemt-panel');
        mkdirSync(join(stage, profile, arch), { recursive: true });
        writeFileSync(path, '');
        truncateSync(path, profile === 'lite' ? 16777217 : 33554432);
      }
    }
    const report = measureBinarySizes(stage, dist, { revision: 'abc123', toolchain: 'go1.27.0' });
    assert.equal(report.targets.length, 4);
    assert.equal(report.dist.bytes, 15);
    assert.equal(report.targets.find(t => t.profile === 'lite').headroom, -1);
    assert.equal(report.targets.find(t => t.profile === 'full').headroom, 0);
    assert.equal(report.targets.find(t => t.profile === 'full').mib, 32);
    const summary = renderSizeSummary(report);
    assert.match(summary, /lite\/x86_64/);
    assert.match(summary, /-1/);
    assert.match(summary, /not calculated/i);
    const previous = structuredClone(report);
    previous.targets.forEach(t => t.bytes -= 512);
    assert.match(renderSizeSummary(report, previous), /\+512/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses incomplete stage and missing dist instead of reporting zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-size-incomplete-'));
  try {
    assert.throws(() => measureBinarySizes(dir, dir), /missing binary/);
    for (const profile of ['full', 'lite']) for (const arch of ['x86_64', 'aarch64']) {
      mkdirSync(join(dir, profile, arch), { recursive: true });
      writeFileSync(join(dir, profile, arch, 'telemt-panel'), 'binary');
    }
    assert.throws(() => measureBinarySizes(dir, join(dir, 'missing-dist')), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
