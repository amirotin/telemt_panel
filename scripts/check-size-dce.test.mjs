import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('detects real dynamic reflection and rejects malformed input and failed analyzer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-dce-test-'));
  try {
    const analyzer = join(dir, 'whydeadcode');
    const tool = spawnSync('go', ['build', '-mod=readonly', '-o', analyzer, 'github.com/aarzilli/whydeadcode'], { cwd: resolve('tools'), encoding: 'utf8' });
    assert.equal(tool.status, 0, tool.stderr);
    const source = join(dir, 'main.go');
    const graph = join(dir, 'deps.txt');
    const run = () => spawnSync('sh', ['scripts/check-size-dce.sh', analyzer, graph], { encoding: 'utf8' });
    for (const [body, passes] of [
      ['package main\nfunc main() {}', true],
      ['package main\nimport("reflect";"os")\ntype value struct{}\nfunc(value)Example(){}\nfunc main(){reflect.ValueOf(value{}).MethodByName(os.Args[1]).Call(nil)}', false],
    ]) {
      writeFileSync(source, body);
      const build = spawnSync('go', ['build', '-ldflags=-dumpdep', '-o', join(dir, 'fixture'), source], { encoding: 'utf8', maxBuffer: 20000000 });
      assert.equal(build.status, 0, build.stderr);
      writeFileSync(graph, build.stdout + build.stderr);
      assert.equal(run().status === 0, passes);
    }
    for (const bad of ['garbage\n', '', '# package\ngarbage\n']) {
      writeFileSync(graph, bad);
      assert.notEqual(run().status, 0);
    }
    writeFileSync(graph, '_ -> main.main\n');
    writeFileSync(analyzer, '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    assert.equal(run().status, 7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
