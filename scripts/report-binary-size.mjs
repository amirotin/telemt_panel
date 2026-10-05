import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Release enforcement and reporting read the same literal limits.
const makefile = readFileSync(new URL('../Makefile', import.meta.url), 'utf8');
const limits = Object.fromEntries(['full', 'lite'].map(profile => {
  const match = makefile.match(new RegExp(`^${profile.toUpperCase()}_SIZE_LIMIT := (\\d+)$`, 'm'));
  if (!match) throw new Error(`missing size limit for ${profile}`);
  return [profile, Number(match[1])];
}));

export function measureBinarySizes(stageDir, distDir, metadata = {}) {
  const targets = [];
  for (const profile of ['full', 'lite']) {
    for (const arch of ['x86_64', 'aarch64']) {
      const path = join(stageDir, profile, arch, 'telemt-panel');
      let info;
      try { info = statSync(path); } catch { throw new Error(`missing binary: ${profile}/${arch}`); }
      if (!info.isFile()) throw new Error(`missing binary: ${profile}/${arch}`);
      const bytes = info.size;
      targets.push({ profile, arch, bytes, mib: bytes / 1048576, limit: limits[profile], headroom: limits[profile] - bytes });
    }
  }
  const assets = [];
  function walk(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${name}/`);
      else if (entry.isFile()) assets.push({ name, bytes: statSync(join(dir, entry.name)).size });
    }
  }
  walk(distDir);
  assets.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  return { schemaVersion: 1, revision: metadata.revision ?? 'unknown', toolchain: metadata.toolchain ?? 'unknown', buildVersion: metadata.buildVersion ?? '0.0.0-dev', targets, dist: { bytes: assets.reduce((n, a) => n + a.bytes, 0), files: assets.length, largest: assets.slice(0, 15) } };
}

export function renderSizeSummary(report, previous) {
  const comparable = previous?.toolchain === report.toolchain && previous?.buildVersion === report.buildVersion;
  const lines = ['### Binary sizes', '', `Revision: ${report.revision}; ${report.toolchain}`, '', '| Target | Bytes | MiB | Limit | Headroom | Delta |', '|---|---:|---:|---:|---:|---:|'];
  for (const row of report.targets) {
    const before = comparable && previous.targets?.find(t => t.profile === row.profile && t.arch === row.arch);
    const delta = before ? row.bytes - before.bytes : null;
    lines.push(`| ${row.profile}/${row.arch} | ${row.bytes} | ${row.mib.toFixed(3)} | ${row.limit} | ${row.headroom} | ${delta === null ? 'not calculated' : `${delta >= 0 ? '+' : ''}${delta}`} |`);
  }
  lines.push('', `Embedded SPA: ${report.dist.bytes} bytes (${report.dist.files} files).`, '');
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [stageDir, distDir, baselinePath] = process.argv.slice(2);
    if (!stageDir || !distDir) throw new Error('usage: report-binary-size.mjs <stage-dir> <dist-dir> [baseline.json]');
    const go = spawnSync('go', ['version'], { encoding: 'utf8' });
    if (go.status !== 0) throw new Error('could not identify Go toolchain');
    const report = measureBinarySizes(stageDir, distDir, { revision: process.env.SIZE_REVISION, toolchain: go.stdout.trim(), buildVersion: process.env.SIZE_BUILD_VERSION });
    const previous = baselinePath ? JSON.parse(readFileSync(baselinePath, 'utf8')) : undefined;
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderSizeSummary(report, previous));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
