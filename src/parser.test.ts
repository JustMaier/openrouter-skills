import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSkillFile, discoverSkills } from './parser.js';

let tempDir: string;

async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'skills-test-'));
}

describe('parseSkillFile', () => {
  before(async () => {
    tempDir = await createTempDir();
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('parses frontmatter name and description', async () => {
    const file = join(tempDir, 'skill-a.md');
    await writeFile(file, [
      '---',
      'name: discord',
      'description: Post messages on Discord.',
      '---',
      '',
      '## Usage',
      'Run `discord.mjs send "hi"`',
    ].join('\n'));

    const result = await parseSkillFile(file);
    assert.equal(result.name, 'discord');
    assert.equal(result.description, 'Post messages on Discord.');
    assert.ok(result.content.includes('## Usage'));
    assert.ok(!result.content.includes('---'));
  });

  it('handles quoted frontmatter values', async () => {
    const file = join(tempDir, 'skill-b.md');
    await writeFile(file, [
      '---',
      'name: "my-skill"',
      "description: 'A quoted description.'",
      '---',
      '',
      'Body content here.',
    ].join('\n'));

    const result = await parseSkillFile(file);
    assert.equal(result.name, 'my-skill');
    assert.equal(result.description, 'A quoted description.');
  });

  it('falls back to first paragraph when no description in frontmatter', async () => {
    const file = join(tempDir, 'skill-c.md');
    await writeFile(file, [
      '---',
      'name: minimal',
      '---',
      '',
      '# Heading',
      '',
      'This is the first paragraph.',
      '',
      'This is the second paragraph.',
    ].join('\n'));

    const result = await parseSkillFile(file);
    assert.equal(result.name, 'minimal');
    assert.equal(result.description, 'This is the first paragraph.');
  });

  it('handles files with no frontmatter at all', async () => {
    const file = join(tempDir, 'skill-d.md');
    await writeFile(file, [
      '# My Skill',
      '',
      'Just a plain markdown file with no frontmatter.',
    ].join('\n'));

    const result = await parseSkillFile(file);
    assert.equal(result.name, '');
    assert.equal(result.description, 'Just a plain markdown file with no frontmatter.');
    assert.ok(result.content.includes('# My Skill'));
  });

  it('handles empty frontmatter', async () => {
    const file = join(tempDir, 'skill-e.md');
    await writeFile(file, [
      '---',
      '---',
      '',
      'Body only.',
    ].join('\n'));

    const result = await parseSkillFile(file);
    assert.equal(result.name, '');
    assert.equal(result.description, 'Body only.');
  });
});

describe('discoverSkills', () => {
  let skillsDir: string;

  before(async () => {
    skillsDir = await createTempDir();

    // Create discord skill with a script
    const discordDir = join(skillsDir, 'discord');
    await mkdir(discordDir);
    await writeFile(join(discordDir, 'SKILL.md'), [
      '---',
      'name: discord',
      'description: Discord integration.',
      '---',
      '',
      'Send messages.',
    ].join('\n'));
    await writeFile(join(discordDir, 'discord.mjs'), '#!/usr/bin/env node\nconsole.log("ok");\n');

    // Create weather skill with scripts subfolder
    const weatherDir = join(skillsDir, 'weather');
    await mkdir(weatherDir);
    await writeFile(join(weatherDir, 'SKILL.md'), [
      '---',
      'name: weather',
      'description: Weather data.',
      '---',
      '',
      'Get forecasts.',
    ].join('\n'));
    await writeFile(join(weatherDir, 'weather.mjs'), '#!/usr/bin/env node\nconsole.log("sunny");\n');
    const scriptsSubdir = join(weatherDir, 'scripts');
    await mkdir(scriptsSubdir);
    await writeFile(join(scriptsSubdir, 'helper.js'), 'console.log("helper");\n');

    // Create a directory without SKILL.md (should be skipped)
    const emptyDir = join(skillsDir, 'no-skill');
    await mkdir(emptyDir);
    await writeFile(join(emptyDir, 'readme.md'), 'Not a skill.\n');

    // Create a plain file at root level (should be skipped)
    await writeFile(join(skillsDir, 'stray-file.txt'), 'ignored');
  });

  after(async () => {
    await rm(skillsDir, { recursive: true, force: true });
  });

  it('discovers all valid skills', async () => {
    const skills = await discoverSkills(skillsDir);
    const names = skills.map((s) => s.name).sort();
    assert.deepEqual(names, ['discord', 'weather']);
  });

  it('populates skill fields correctly', async () => {
    const skills = await discoverSkills(skillsDir);
    const discord = skills.find((s) => s.name === 'discord');
    assert.ok(discord);
    assert.equal(discord.description, 'Discord integration.');
    assert.ok(discord.content.includes('Send messages.'));
    assert.ok(discord.dirPath.endsWith('discord'));
    assert.deepEqual(discord.scripts, ['discord.mjs']);
  });

  it('collects scripts from scripts/ subfolder', async () => {
    const skills = await discoverSkills(skillsDir);
    const weather = skills.find((s) => s.name === 'weather');
    assert.ok(weather);
    assert.ok(weather.scripts.includes('weather.mjs'));
    assert.ok(weather.scripts.includes('scripts/helper.js'));
  });

  it('skips directories without SKILL.md', async () => {
    const skills = await discoverSkills(skillsDir);
    const names = skills.map((s) => s.name);
    assert.ok(!names.includes('no-skill'));
  });

  it('filters with include option', async () => {
    const skills = await discoverSkills(skillsDir, { include: ['discord'] });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'discord');
  });

  it('filters with exclude option', async () => {
    const skills = await discoverSkills(skillsDir, { exclude: ['discord'] });
    const names = skills.map((s) => s.name);
    assert.ok(!names.includes('discord'));
    assert.ok(names.includes('weather'));
  });

  it('returns empty array for nonexistent directory', async () => {
    const skills = await discoverSkills('/nonexistent/path/xyz');
    assert.deepEqual(skills, []);
  });
});
