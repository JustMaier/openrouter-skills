import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSkillsProvider, createSdkTools, createManualTools, processTurn } from './provider.js';

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
      assert.equal(result.error, 'SkillNotFound');
      assert.ok(result.stderr.includes('nonexistent'));
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

    it('use_skill defaults to empty args when omitted', async () => {
      const provider = await createSkillsProvider(skillsDir);
      const result = await provider.handleToolCall('use_skill', {
        skill: 'weather',
        script: 'weather.mjs',
        // args omitted entirely
      });

      assert.equal(result.success, true);
    });

    it('use_skill rejects string args with error', async () => {
      const provider = await createSkillsProvider(skillsDir);
      const result = await provider.handleToolCall('use_skill', {
        skill: 'discord',
        script: 'discord.mjs',
        args: 'channels list',  // string instead of array
      });

      assert.equal(result.success, false);
      assert.equal(result.error, 'InvalidArgs');
    });

    it('use_skill returns SkillNotFound for unknown skill', async () => {
      const provider = await createSkillsProvider(skillsDir);
      const result = await provider.handleToolCall('use_skill', {
        skill: 'nonexistent',
        script: 'foo.mjs',
      });

      assert.equal(result.success, false);
      assert.equal(result.error, 'SkillNotFound');
      assert.equal(result.stderr, '');
    });

    it('use_skill blocks unregistered scripts', async () => {
      const provider = await createSkillsProvider(skillsDir);
      const result = await provider.handleToolCall('use_skill', {
        skill: 'discord',
        script: 'missing.mjs',
      });

      assert.equal(result.success, false);
      assert.equal(result.error, 'ScriptNotAllowed');
      assert.ok(result.stderr.includes('missing.mjs'));
    });

    it('returns error for unknown tool name', async () => {
      const provider = await createSkillsProvider(skillsDir);
      const result = await provider.handleToolCall('unknown_tool', {});

      assert.equal(result.success, false);
      assert.equal(result.error, 'UnknownTool');
      assert.ok(result.stderr.includes('unknown_tool'));
    });
  });
});

// --- Multiple directories tests ---

describe('createSkillsProvider with multiple directories', () => {
  let dirA: string;
  let dirB: string;

  before(async () => {
    dirA = await createTempDir();
    dirB = await createTempDir();

    // dirA: discord + weather
    const discordDir = join(dirA, 'discord');
    await mkdir(discordDir);
    await writeFile(join(discordDir, 'SKILL.md'), [
      '---', 'name: discord', 'description: Discord from dirA.', '---', '', 'DirA discord.',
    ].join('\n'));
    await writeFile(join(discordDir, 'discord.mjs'), '#!/usr/bin/env node\nconsole.log("dirA");');

    const weatherDir = join(dirA, 'weather');
    await mkdir(weatherDir);
    await writeFile(join(weatherDir, 'SKILL.md'), [
      '---', 'name: weather', 'description: Weather from dirA.', '---', '', 'DirA weather.',
    ].join('\n'));

    // dirB: discord (duplicate) + calendar (unique)
    const discordDir2 = join(dirB, 'discord');
    await mkdir(discordDir2);
    await writeFile(join(discordDir2, 'SKILL.md'), [
      '---', 'name: discord', 'description: Discord from dirB.', '---', '', 'DirB discord.',
    ].join('\n'));
    await writeFile(join(discordDir2, 'discord.mjs'), '#!/usr/bin/env node\nconsole.log("dirB");');

    const calendarDir = join(dirB, 'calendar');
    await mkdir(calendarDir);
    await writeFile(join(calendarDir, 'SKILL.md'), [
      '---', 'name: calendar', 'description: Calendar from dirB.', '---', '', 'DirB calendar.',
    ].join('\n'));
  });

  after(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it('discovers skills from both directories', async () => {
    const provider = await createSkillsProvider([dirA, dirB]);
    assert.ok(provider.skillNames.includes('discord'));
    assert.ok(provider.skillNames.includes('weather'));
    assert.ok(provider.skillNames.includes('calendar'));
    assert.equal(provider.skills.size, 3);
  });

  it('first directory wins for duplicates', async () => {
    const provider = await createSkillsProvider([dirA, dirB]);
    const discord = provider.skills.get('discord')!;
    assert.ok(discord.description.includes('dirA'));
    assert.ok(discord.dirPath.startsWith(dirA));
  });

  it('single string still works (backwards compat)', async () => {
    const provider = await createSkillsProvider(dirA);
    assert.ok(provider.skillNames.includes('discord'));
    assert.ok(provider.skillNames.includes('weather'));
    assert.equal(provider.skills.size, 2);
  });

  it('handles empty array gracefully', async () => {
    const provider = await createSkillsProvider([]);
    assert.equal(provider.skills.size, 0);
    assert.deepEqual(provider.skillNames, []);
  });

  it('handles non-existent directory in array gracefully', async () => {
    const bogus = join(dirA, 'does-not-exist');
    const provider = await createSkillsProvider([dirA, bogus]);
    // Skills from dirA should still be available
    assert.ok(provider.skillNames.includes('discord'));
    assert.ok(provider.skillNames.includes('weather'));
  });
});

// --- Hot reload tests ---

describe('skill hot reload', () => {
  let hotDir: string;

  before(async () => {
    hotDir = await createTempDir();

    const alphaDir = join(hotDir, 'alpha');
    await mkdir(alphaDir);
    await writeFile(join(alphaDir, 'SKILL.md'), [
      '---', 'name: alpha', 'description: Alpha v1.', '---', '', 'Alpha version 1.',
    ].join('\n'));
    await writeFile(join(alphaDir, 'run.mjs'), '#!/usr/bin/env node\nconsole.log("v1");');
  });

  after(async () => {
    await rm(hotDir, { recursive: true, force: true });
  });

  it('returns updated content after SKILL.md changes', async () => {
    const provider = await createSkillsProvider(hotDir);

    // Initial load
    const r1 = await provider.handleToolCall('load_skill', { skill: 'alpha' });
    assert.ok(r1.stdout.includes('Alpha version 1'));

    // Mutate SKILL.md — need a small delay so mtime actually differs
    await new Promise(r => setTimeout(r, 50));
    await writeFile(join(hotDir, 'alpha', 'SKILL.md'), [
      '---', 'name: alpha', 'description: Alpha v2.', '---', '', 'Alpha version 2.',
    ].join('\n'));

    // Next load should pick up the change
    const r2 = await provider.handleToolCall('load_skill', { skill: 'alpha' });
    assert.ok(r2.stdout.includes('Alpha version 2'));
  });

  it('picks up new scripts added after creation', async () => {
    const provider = await createSkillsProvider(hotDir);
    const skill1 = provider.skills.get('alpha')!;
    const hadNew = skill1.scripts.includes('new.mjs');
    assert.equal(hadNew, false);

    // Add a new script and touch SKILL.md so mtime changes
    await new Promise(r => setTimeout(r, 50));
    await writeFile(join(hotDir, 'alpha', 'new.mjs'), '#!/usr/bin/env node\nconsole.log("new");');
    await writeFile(join(hotDir, 'alpha', 'SKILL.md'), [
      '---', 'name: alpha', 'description: Alpha v3.', '---', '', 'Alpha version 3.',
    ].join('\n'));

    // use_skill triggers refresh, so scripts list should update
    await provider.handleToolCall('load_skill', { skill: 'alpha' });
    const skill2 = provider.skills.get('alpha')!;
    assert.ok(skill2.scripts.includes('new.mjs'));
  });

  it('discovers newly added skills on load_skill miss', async () => {
    const provider = await createSkillsProvider(hotDir);
    assert.equal(provider.skills.has('beta'), false);

    // Add a new skill directory
    const betaDir = join(hotDir, 'beta');
    await mkdir(betaDir);
    await writeFile(join(betaDir, 'SKILL.md'), [
      '---', 'name: beta', 'description: Beta skill.', '---', '', 'Beta content.',
    ].join('\n'));

    // load_skill for unknown name triggers rediscovery
    const r = await provider.handleToolCall('load_skill', { skill: 'beta' });
    assert.equal(r.success, true);
    assert.ok(r.stdout.includes('Beta content'));
    assert.ok(provider.skillNames.includes('beta'));
  });

  it('does not re-parse when mtime is unchanged', async () => {
    const provider = await createSkillsProvider(hotDir);

    // Load twice — second call should be cheap (no re-parse)
    const r1 = await provider.handleToolCall('load_skill', { skill: 'alpha' });
    const r2 = await provider.handleToolCall('load_skill', { skill: 'alpha' });
    assert.equal(r1.stdout, r2.stdout);
  });

  it('picks up new script on use_skill miss without SKILL.md change', async () => {
    const provider = await createSkillsProvider(hotDir);

    // Add a script file without touching SKILL.md
    const scriptPath = join(hotDir, 'alpha', 'added.mjs');
    await writeFile(scriptPath, '#!/usr/bin/env node\nconsole.log("added");');

    // First use_skill should miss, force re-parse, then find the script
    const r = await provider.handleToolCall('use_skill', {
      skill: 'alpha', script: 'added.mjs', args: [],
    });
    assert.equal(r.success, true);
    assert.ok(r.stdout.includes('added'));

    // Clean up so other tests aren't affected
    const { unlink } = await import('node:fs/promises');
    await unlink(scriptPath);
  });
});

// --- SDK tools tests (uses example skills on disk) ---

const exampleSkillsDir = join(import.meta.dirname, '..', 'example', 'skills');

describe('createSdkTools', () => {
  it('returns two tools', async () => {
    const provider = await createSkillsProvider(exampleSkillsDir);
    const tools = createSdkTools(provider);
    assert.equal(tools.length, 2);
  });

  it('tools have SDK structure (type + function)', async () => {
    const provider = await createSkillsProvider(exampleSkillsDir);
    const tools = createSdkTools(provider);

    for (const t of tools) {
      assert.equal(t.type, 'function');
      assert.ok(t.function);
      assert.ok(t.function.name);
      assert.ok(t.function.description);
    }
  });

  it('load_skill tool has correct name', async () => {
    const provider = await createSkillsProvider(exampleSkillsDir);
    const tools = createSdkTools(provider);
    assert.equal(tools[0].function.name, 'load_skill');
  });

  it('use_skill tool has correct name', async () => {
    const provider = await createSkillsProvider(exampleSkillsDir);
    const tools = createSdkTools(provider);
    assert.equal(tools[1].function.name, 'use_skill');
  });

  it('tools have inputSchema and execute', async () => {
    const provider = await createSkillsProvider(exampleSkillsDir);
    const tools = createSdkTools(provider);
    for (const t of tools) {
      assert.ok(t.function.inputSchema);
      assert.equal(typeof t.function.execute, 'function');
    }
  });

  it('load_skill execute returns ok with result', async () => {
    const provider = await createSkillsProvider(exampleSkillsDir);
    const tools = createSdkTools(provider);
    const loadTool = tools[0];

    const result = await loadTool.function.execute({ skill: 'discord' });
    assert.equal(result.ok, true);
    assert.ok(result.result && result.result.length > 0);
    assert.equal(result.error, undefined);
  });

  it('load_skill execute returns error for unknown skill', async () => {
    const provider = await createSkillsProvider(exampleSkillsDir);
    const tools = createSdkTools(provider);
    const loadTool = tools[0];

    const result = await loadTool.function.execute({ skill: 'nonexistent' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'SkillNotFound');
    assert.equal(result.result, undefined);
  });

  it('use_skill execute runs a script', async () => {
    const provider = await createSkillsProvider(exampleSkillsDir);
    const tools = createSdkTools(provider);
    const useTool = tools[1];

    const result = await useTool.function.execute({
      skill: 'weather',
      script: 'weather.mjs',
      args: ['forecast', 'Paris'],
    });
    assert.equal(result.ok, true);
    assert.ok(result.result && result.result.length > 0);
  });

  it('load_skill has nextTurnParams for instructions injection', async () => {
    const provider = await createSkillsProvider(exampleSkillsDir);
    const tools = createSdkTools(provider);
    const loadTool = tools[0];

    assert.ok(loadTool.function.nextTurnParams);
    assert.ok(loadTool.function.nextTurnParams.instructions);
  });

  it('nextTurnParams injects skill content into instructions', async () => {
    const provider = await createSkillsProvider(exampleSkillsDir);
    const tools = createSdkTools(provider);
    const loadTool = tools[0];

    const inject = loadTool.function.nextTurnParams!.instructions!;
    const result = await inject(
      { skill: 'discord' },
      { instructions: 'You are helpful.', input: '', model: '', models: [], temperature: null, maxOutputTokens: null, topP: null },
    );

    assert.ok(typeof result === 'string');
    assert.ok(result.startsWith('You are helpful.'));
    assert.ok(result.includes('[Skill: discord]'));
  });

  it('nextTurnParams is idempotent (skips duplicate loads)', async () => {
    const provider = await createSkillsProvider(exampleSkillsDir);
    const tools = createSdkTools(provider);
    const loadTool = tools[0];

    const inject = loadTool.function.nextTurnParams!.instructions!;
    const first = await inject(
      { skill: 'discord' },
      { instructions: 'Base.', input: '', model: '', models: [], temperature: null, maxOutputTokens: null, topP: null },
    );
    const second = await inject(
      { skill: 'discord' },
      { instructions: first as string, input: '', model: '', models: [], temperature: null, maxOutputTokens: null, topP: null },
    );

    assert.equal(first, second);
  });

  it('nextTurnParams returns current instructions for unknown skill', async () => {
    const provider = await createSkillsProvider(exampleSkillsDir);
    const tools = createSdkTools(provider);
    const loadTool = tools[0];

    const inject = loadTool.function.nextTurnParams!.instructions!;
    const result = await inject(
      { skill: 'nonexistent' },
      { instructions: 'Base.', input: '', model: '', models: [], temperature: null, maxOutputTokens: null, topP: null },
    );

    assert.equal(result, 'Base.');
  });

  it('use_skill has remember parameter defaulting to true', async () => {
    const provider = await createSkillsProvider(exampleSkillsDir);
    const tools = createSdkTools(provider);
    const useTool = tools[1];

    const result = await useTool.function.execute({
      skill: 'weather',
      script: 'weather.mjs',
      args: ['forecast', 'Paris'],
      remember: true,
    });
    assert.equal(result.ok, true);
  });
});

// --- createManualTools tests ---

describe('createManualTools', () => {
  it('disables execute and removes nextTurnParams', async () => {
    const provider = await createSkillsProvider(exampleSkillsDir);
    const sdkTools = createSdkTools(provider);
    const manual = createManualTools(sdkTools);

    assert.equal(manual.length, sdkTools.length);
    for (const t of manual) {
      assert.equal(t.function.execute, false);
      assert.equal(t.function.nextTurnParams, undefined);
    }
  });

  it('preserves tool names and descriptions', async () => {
    const provider = await createSkillsProvider(exampleSkillsDir);
    const sdkTools = createSdkTools(provider);
    const manual = createManualTools(sdkTools);

    for (let i = 0; i < sdkTools.length; i++) {
      assert.equal(manual[i].function.name, sdkTools[i].function.name);
      assert.equal(manual[i].function.description, sdkTools[i].function.description);
    }
  });
});

// --- processTurn tests ---

function fakeResult(items: Record<string, unknown>[], text: string) {
  return {
    async *getItemsStream() { for (const i of items) yield i; },
    async getText() { return text; },
  };
}

describe('processTurn', () => {
  it('collects history items and returns text', async () => {
    const items = [
      { type: 'function_call', callId: 'c1', name: 'load_skill', arguments: '{"skill":"weather"}', status: 'completed' },
      { type: 'function_call_output', callId: 'c1', output: '{"ok":true,"result":"..."}' },
    ];

    const { text, history } = await processTurn(fakeResult(items, 'Sunny today.'));

    assert.equal(text, 'Sunny today.');
    assert.equal(history.length, 2);
    assert.deepEqual(history[0], { type: 'function_call', callId: 'c1', name: 'load_skill', arguments: '{"skill":"weather"}' });
    assert.deepEqual(history[1], { type: 'function_call_output', callId: 'c1', output: '{"ok":true,"result":"..."}' });
  });

  it('emits events via callback', async () => {
    const items = [
      { type: 'function_call', callId: 'c1', name: 'load_skill', arguments: '{"skill":"weather"}', status: 'completed' },
      { type: 'function_call_output', callId: 'c1', output: '{"ok":true}' },
    ];

    const events: { type: string; name: string }[] = [];
    await processTurn(fakeResult(items, ''), (e) => events.push(e));

    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'tool_call');
    assert.equal(events[0].name, 'load_skill');
    assert.equal(events[1].type, 'tool_result');
    assert.equal(events[1].name, 'load_skill');
  });

  it('excludes use_skill with remember:false from history', async () => {
    const items = [
      { type: 'function_call', callId: 'c1', name: 'use_skill', arguments: '{"skill":"discord","script":"discord.mjs","args":["send","hi"],"remember":false}', status: 'completed' },
      { type: 'function_call_output', callId: 'c1', output: '{"ok":true,"result":"sent"}' },
    ];

    const events: { type: string }[] = [];
    const { history } = await processTurn(fakeResult(items, 'Done.'), (e) => events.push(e));

    assert.equal(history.length, 0);
    assert.equal(events.length, 2); // still emitted for UI
  });

  it('keeps use_skill with remember:true in history', async () => {
    const items = [
      { type: 'function_call', callId: 'c1', name: 'use_skill', arguments: '{"skill":"weather","script":"weather.mjs","args":["forecast","NYC"],"remember":true}', status: 'completed' },
      { type: 'function_call_output', callId: 'c1', output: '{"ok":true,"result":"20C"}' },
    ];

    const { history } = await processTurn(fakeResult(items, 'It is 20C.'));

    assert.equal(history.length, 2);
  });

  it('excludes use_skill with default remember (false) from history', async () => {
    const items = [
      { type: 'function_call', callId: 'c1', name: 'use_skill', arguments: '{"skill":"discord","script":"discord.mjs","args":["send","hi"]}', status: 'completed' },
      { type: 'function_call_output', callId: 'c1', output: '{"ok":true,"result":"sent"}' },
    ];

    const { history } = await processTurn(fakeResult(items, 'Sent.'));

    assert.equal(history.length, 0);
  });

  it('always keeps load_skill in history', async () => {
    const items = [
      { type: 'function_call', callId: 'c1', name: 'load_skill', arguments: '{"skill":"weather"}', status: 'completed' },
      { type: 'function_call_output', callId: 'c1', output: '{"ok":true,"result":"..."}' },
    ];

    const { history } = await processTurn(fakeResult(items, 'Loaded.'));

    assert.equal(history.length, 2);
  });

  it('handles multiple tool calls with mixed remember flags', async () => {
    const items = [
      { type: 'function_call', callId: 'c1', name: 'load_skill', arguments: '{"skill":"discord"}', status: 'completed' },
      { type: 'function_call_output', callId: 'c1', output: '{"ok":true,"result":"loaded"}' },
      { type: 'function_call', callId: 'c2', name: 'use_skill', arguments: '{"skill":"discord","script":"discord.mjs","args":["send","hi"]}', status: 'completed' },
      { type: 'function_call_output', callId: 'c2', output: '{"ok":true,"result":"sent"}' },
      { type: 'function_call', callId: 'c3', name: 'use_skill', arguments: '{"skill":"discord","script":"discord.mjs","args":["channels","list"],"remember":true}', status: 'completed' },
      { type: 'function_call_output', callId: 'c3', output: '{"ok":true,"result":"[...]"}' },
    ];

    const events: { type: string }[] = [];
    const { history } = await processTurn(fakeResult(items, 'Done.'), (e) => events.push(e));

    assert.equal(history.length, 4); // load_skill(2) + remembered use_skill(2), skipped default(0)
    assert.equal(events.length, 6); // all events emitted for UI
  });

  it('deduplicates repeated items', async () => {
    const items = [
      { type: 'function_call', callId: 'c1', name: 'load_skill', arguments: '{"skill":"weather"}', status: 'completed' },
      { type: 'function_call', callId: 'c1', name: 'load_skill', arguments: '{"skill":"weather"}', status: 'completed' },
      { type: 'function_call_output', callId: 'c1', output: '{"ok":true}' },
      { type: 'function_call_output', callId: 'c1', output: '{"ok":true}' },
    ];

    const { history } = await processTurn(fakeResult(items, ''));

    assert.equal(history.length, 2);
  });

  it('skips non-completed function_call items', async () => {
    const items = [
      { type: 'function_call', callId: 'c1', name: 'load_skill', arguments: '{"skill":"weather"}', status: 'in_progress' },
      { type: 'function_call', callId: 'c1', name: 'load_skill', arguments: '{"skill":"weather"}', status: 'completed' },
      { type: 'function_call_output', callId: 'c1', output: '{"ok":true}' },
    ];

    const events: unknown[] = [];
    const { history } = await processTurn(fakeResult(items, ''), (e) => events.push(e));

    assert.equal(history.length, 2);
    assert.equal(events.length, 2); // only the completed call + output
  });

  it('emits orphaned function_call_output without matching call', async () => {
    const items = [
      // Output arrives without a prior function_call
      { type: 'function_call_output', callId: 'orphan1', output: '{"ok":true}' },
    ];

    const events: { type: string; name?: string }[] = [];
    const { history } = await processTurn(fakeResult(items, 'OK'), (e) => events.push(e));

    // Should still emit the event (name falls back to 'unknown')
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'tool_result');
    assert.equal(events[0].name, 'unknown');
    // Should be included in history (no skipCallIds entry)
    assert.equal(history.length, 1);
  });

  it('works with no onEvent callback', async () => {
    const items = [
      { type: 'function_call', callId: 'c1', name: 'load_skill', arguments: '{"skill":"weather"}', status: 'completed' },
      { type: 'function_call_output', callId: 'c1', output: '{"ok":true}' },
    ];

    const { text, history } = await processTurn(fakeResult(items, 'OK'));

    assert.equal(text, 'OK');
    assert.equal(history.length, 2);
  });

  it('streams text deltas from message items', async () => {
    const items: Record<string, unknown>[] = [
      { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'Hello world!' }] },
    ];

    const events: { type: string; delta?: string }[] = [];
    const { text } = await processTurn(fakeResult(items, 'Hello world!'), (e) => events.push(e));

    assert.equal(text, 'Hello world!');
    const textEvents = events.filter(e => e.type === 'text_delta');
    assert.equal(textEvents.length, 3);
    assert.equal(textEvents[0].delta, 'Hello');
    assert.equal(textEvents[1].delta, ' world');
    assert.equal(textEvents[2].delta, '!');
  });

  it('handles message items with string content', async () => {
    const items: Record<string, unknown>[] = [
      { type: 'message', content: 'Hello' },
      { type: 'message', content: 'Hello world' },
    ];

    const events: { type: string; delta?: string }[] = [];
    const { text } = await processTurn(fakeResult(items, 'Hello world'), (e) => events.push(e));

    assert.equal(text, 'Hello world');
    const textEvents = events.filter(e => e.type === 'text_delta');
    assert.equal(textEvents.length, 2);
    assert.equal(textEvents[0].delta, 'Hello');
    assert.equal(textEvents[1].delta, ' world');
  });

  it('falls back to getText() when no message items are present', async () => {
    const items: Record<string, unknown>[] = [];

    const { text } = await processTurn(fakeResult(items, 'Fallback text'));

    assert.equal(text, 'Fallback text');
  });

  it('emits text_delta events alongside tool events', async () => {
    const items: Record<string, unknown>[] = [
      { type: 'function_call', callId: 'c1', name: 'load_skill', arguments: '{"skill":"weather"}', status: 'completed' },
      { type: 'function_call_output', callId: 'c1', output: '{"ok":true}' },
      { type: 'message', content: [{ type: 'output_text', text: 'Sunny' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'Sunny today.' }] },
    ];

    const events: { type: string }[] = [];
    const { text } = await processTurn(fakeResult(items, 'Sunny today.'), (e) => events.push(e));

    assert.equal(text, 'Sunny today.');
    assert.ok(events.some(e => e.type === 'tool_call'));
    assert.ok(events.some(e => e.type === 'tool_result'));
    assert.ok(events.some(e => e.type === 'text_delta'));
  });
});
