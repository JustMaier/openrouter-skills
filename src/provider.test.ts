import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSkillsProvider } from './provider.js';

let skillsDir: string;

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'provider-test-'));
}

describe('createSkillsProvider', () => {
  before(async () => {
    skillsDir = await createTempDir();

    // Create discord skill
    const discordDir = join(skillsDir, 'discord');
    await mkdir(discordDir);
    await writeFile(join(discordDir, 'SKILL.md'), [
      '---',
      'name: discord',
      'description: Discord integration.',
      '---',
      '',
      '## Usage',
      'Run `discord.mjs channels list`',
    ].join('\n'));
    await writeFile(join(discordDir, 'discord.mjs'), [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      'if (args[0] === "channels" && args[1] === "list") {',
      '  console.log(JSON.stringify([{ id: "1", name: "general" }]));',
      '} else if (args[0] === "send") {',
      '  console.log(JSON.stringify({ sent: true, message: args[1] }));',
      '} else {',
      '  console.error("unknown command");',
      '  process.exit(1);',
      '}',
    ].join('\n'));

    // Create weather skill
    const weatherDir = join(skillsDir, 'weather');
    await mkdir(weatherDir);
    await writeFile(join(weatherDir, 'SKILL.md'), [
      '---',
      'name: weather',
      'description: Weather data.',
      '---',
      '',
      'Get forecasts with `weather.mjs forecast <city>`.',
    ].join('\n'));
    await writeFile(join(weatherDir, 'weather.mjs'), [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ city: process.argv[3], temp: 20 }));',
    ].join('\n'));

    // Create a skill to be excluded
    const excludedDir = join(skillsDir, 'internal');
    await mkdir(excludedDir);
    await writeFile(join(excludedDir, 'SKILL.md'), [
      '---',
      'name: internal',
      'description: Internal only.',
      '---',
      '',
      'Should not appear when excluded.',
    ].join('\n'));
  });

  after(async () => {
    await rm(skillsDir, { recursive: true, force: true });
  });

  it('discovers all skills and populates skillNames', async () => {
    const provider = await createSkillsProvider(skillsDir);
    assert.ok(provider.skillNames.includes('discord'));
    assert.ok(provider.skillNames.includes('weather'));
    assert.ok(provider.skillNames.includes('internal'));
    assert.equal(provider.skillNames.length, 3);
  });

  it('exposes skills map', async () => {
    const provider = await createSkillsProvider(skillsDir);
    assert.equal(provider.skills.size, 3);
    assert.ok(provider.skills.has('discord'));
    assert.ok(provider.skills.has('weather'));
  });

  it('respects include filter', async () => {
    const provider = await createSkillsProvider(skillsDir, {
      include: ['discord'],
    });
    assert.deepEqual(provider.skillNames, ['discord']);
  });

  it('respects exclude filter', async () => {
    const provider = await createSkillsProvider(skillsDir, {
      exclude: ['internal'],
    });
    assert.ok(!provider.skillNames.includes('internal'));
    assert.ok(provider.skillNames.includes('discord'));
    assert.ok(provider.skillNames.includes('weather'));
  });

  describe('handleToolCall', () => {
    it('load_skill returns structured result with content in stdout', async () => {
      const provider = await createSkillsProvider(skillsDir);
      const result = await provider.handleToolCall('load_skill', { skill: 'discord' });
      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      assert.ok(result.stdout.includes('## Usage'));
      assert.ok(result.stdout.includes('discord.mjs channels list'));
    });

    it('load_skill returns structured error for unknown skill', async () => {
      const provider = await createSkillsProvider(skillsDir);
      const result = await provider.handleToolCall('load_skill', { skill: 'nonexistent' });
      assert.equal(result.success, false);
      assert.ok(result.error?.includes('SkillNotFound'));
      assert.ok(result.error?.includes('nonexistent'));
    });

    it('use_skill executes a script successfully', async () => {
      const provider = await createSkillsProvider(skillsDir);
      const result = await provider.handleToolCall('use_skill', {
        skill: 'discord',
        script: 'discord.mjs',
        args: ['channels', 'list'],
      });

      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      const parsed = JSON.parse(result.stdout);
      assert.deepEqual(parsed, [{ id: '1', name: 'general' }]);
    });

    it('use_skill rejects string args with error', async () => {
      const provider = await createSkillsProvider(skillsDir);
      const result = await provider.handleToolCall('use_skill', {
        skill: 'discord',
        script: 'discord.mjs',
        args: 'channels list',  // string instead of array
      });

      assert.equal(result.success, false);
      assert.ok(result.error?.includes('InvalidArgs'));
    });

    it('use_skill returns SkillNotFound for unknown skill', async () => {
      const provider = await createSkillsProvider(skillsDir);
      const result = await provider.handleToolCall('use_skill', {
        skill: 'nonexistent',
        script: 'foo.mjs',
      });

      assert.equal(result.success, false);
      assert.equal(result.error, 'SkillNotFound');
    });

    it('use_skill blocks unregistered scripts', async () => {
      const provider = await createSkillsProvider(skillsDir);
      const result = await provider.handleToolCall('use_skill', {
        skill: 'discord',
        script: 'missing.mjs',
      });

      assert.equal(result.success, false);
      assert.ok(result.error?.includes('ScriptNotAllowed'));
    });

    it('returns error for unknown tool name', async () => {
      const provider = await createSkillsProvider(skillsDir);
      const result = await provider.handleToolCall('unknown_tool', {});

      assert.equal(result.success, false);
      assert.ok(result.error?.includes('Unknown tool'));
    });
  });
});
