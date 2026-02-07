import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSkillsProvider, createSdkTools, processTurn } from './provider.js';

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

  it('works with no onEvent callback', async () => {
    const items = [
      { type: 'function_call', callId: 'c1', name: 'load_skill', arguments: '{"skill":"weather"}', status: 'completed' },
      { type: 'function_call_output', callId: 'c1', output: '{"ok":true}' },
    ];

    const { text, history } = await processTurn(fakeResult(items, 'OK'));

    assert.equal(text, 'OK');
    assert.equal(history.length, 2);
  });
});
