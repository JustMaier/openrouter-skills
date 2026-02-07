import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeScript } from './executor.js';

let skillDir: string;

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'exec-test-'));
}

describe('executeScript', () => {
  before(async () => {
    skillDir = await createTempDir();

    // A script that echoes args as JSON
    await writeFile(join(skillDir, 'echo.mjs'), [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      'console.log(JSON.stringify({ args }));',
    ].join('\n'));

    // A script that writes to stderr and exits non-zero
    await writeFile(join(skillDir, 'fail.mjs'), [
      '#!/usr/bin/env node',
      'console.error("something went wrong");',
      'process.exit(1);',
    ].join('\n'));

    // A script that produces output exceeding maxOutput but within maxBuffer
    await writeFile(join(skillDir, 'big-output.mjs'), [
      '#!/usr/bin/env node',
      'console.log("x".repeat(1500));',
    ].join('\n'));

    // A script that sleeps forever (for timeout testing)
    await writeFile(join(skillDir, 'hang.mjs'), [
      '#!/usr/bin/env node',
      'setTimeout(() => {}, 999999);',
    ].join('\n'));

    // A script in a scripts/ subfolder
    const scriptsSubdir = join(skillDir, 'scripts');
    await mkdir(scriptsSubdir);
    await writeFile(join(scriptsSubdir, 'helper.js'), [
      '#!/usr/bin/env node',
      'console.log("from subfolder");',
    ].join('\n'));
  });

  after(async () => {
    await rm(skillDir, { recursive: true, force: true });
  });

  it('executes a script and returns stdout', async () => {
    const result = await executeScript({
      skillDir,
      script: 'echo.mjs',
      args: ['hello', 'world'],
    });
    assert.equal(result.success, true);
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.args, ['hello', 'world']);
    assert.equal(result.stderr, '');
  });

  it('returns failure for non-zero exit code', async () => {
    const result = await executeScript({
      skillDir,
      script: 'fail.mjs',
    });
    assert.equal(result.success, false);
    assert.equal(result.error, 'ExecutionFailed');
    assert.ok(result.stderr.includes('something went wrong'));
  });

  it('returns ScriptNotFound for missing script', async () => {
    const result = await executeScript({
      skillDir,
      script: 'nonexistent.mjs',
    });
    assert.equal(result.success, false);
    assert.equal(result.error, 'ScriptNotFound');
  });

  it('blocks path traversal with ../', async () => {
    const result = await executeScript({
      skillDir,
      script: '../etc/passwd',
    });
    assert.equal(result.success, false);
    assert.equal(result.error, 'ScriptNotAllowed');
  });

  it('blocks absolute paths', async () => {
    const result = await executeScript({
      skillDir,
      script: '/usr/bin/env',
    });
    assert.equal(result.success, false);
    assert.equal(result.error, 'ScriptNotAllowed');
  });

  it('blocks backslash traversal', async () => {
    const result = await executeScript({
      skillDir,
      script: '..\\windows\\system32\\cmd.exe',
    });
    assert.equal(result.success, false);
    assert.equal(result.error, 'ScriptNotAllowed');
  });

  it('blocks empty script name', async () => {
    const result = await executeScript({
      skillDir,
      script: '',
    });
    assert.equal(result.success, false);
    assert.equal(result.error, 'ScriptNotAllowed');
  });

  it('caps large output', async () => {
    const result = await executeScript({
      skillDir,
      script: 'big-output.mjs',
      maxOutput: 1024,
    });
    assert.equal(result.success, true);
    assert.ok(result.stdout.length <= 1024 + 30); // 30 chars buffer for truncation message
    assert.ok(result.stdout.includes('[output truncated]'));
  });

  it('times out on long-running scripts', async () => {
    const result = await executeScript({
      skillDir,
      script: 'hang.mjs',
      timeout: 500,
    });
    assert.equal(result.success, false);
    assert.equal(result.error, 'ExecutionTimeout');
  });

  it('finds scripts in scripts/ subfolder', async () => {
    const result = await executeScript({
      skillDir,
      script: 'helper.js',
    });
    assert.equal(result.success, true);
    assert.ok(result.stdout.includes('from subfolder'));
  });
});
