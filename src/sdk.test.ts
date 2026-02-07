import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createSkillsProvider } from './provider.js';
import { createSdkTools } from './sdk.js';

const skillsDir = join(import.meta.dirname, '..', 'example', 'skills');

describe('createSdkTools', () => {
  it('returns two tools', async () => {
    const provider = await createSkillsProvider(skillsDir);
    const tools = createSdkTools(provider);
    assert.equal(tools.length, 2);
  });

  it('tools have SDK structure (type + function)', async () => {
    const provider = await createSkillsProvider(skillsDir);
    const tools = createSdkTools(provider);

    for (const t of tools) {
      assert.equal(t.type, 'function');
      assert.ok(t.function);
      assert.ok(t.function.name);
      assert.ok(t.function.description);
    }
  });

  it('load_skill tool has correct name', async () => {
    const provider = await createSkillsProvider(skillsDir);
    const tools = createSdkTools(provider);
    assert.equal(tools[0].function.name, 'load_skill');
  });

  it('use_skill tool has correct name', async () => {
    const provider = await createSkillsProvider(skillsDir);
    const tools = createSdkTools(provider);
    assert.equal(tools[1].function.name, 'use_skill');
  });

  it('tools have inputSchema and execute', async () => {
    const provider = await createSkillsProvider(skillsDir);
    const tools = createSdkTools(provider);
    for (const t of tools) {
      assert.ok(t.function.inputSchema);
      assert.equal(typeof t.function.execute, 'function');
    }
  });

  it('load_skill execute returns skill content', async () => {
    const provider = await createSkillsProvider(skillsDir);
    const tools = createSdkTools(provider);
    const loadTool = tools[0];

    const result = await loadTool.function.execute({ skill: 'discord' });
    assert.equal(result.success, true);
    assert.ok(result.stdout.length > 0);
  });

  it('load_skill execute returns error for unknown skill', async () => {
    const provider = await createSkillsProvider(skillsDir);
    const tools = createSdkTools(provider);
    const loadTool = tools[0];

    const result = await loadTool.function.execute({ skill: 'nonexistent' });
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('SkillNotFound'));
  });

  it('use_skill execute runs a script', async () => {
    const provider = await createSkillsProvider(skillsDir);
    const tools = createSdkTools(provider);
    const useTool = tools[1];

    const result = await useTool.function.execute({
      skill: 'weather',
      script: 'weather.mjs',
      args: ['forecast', 'Paris'],
    });
    assert.equal(result.success, true);
    assert.ok(result.stdout.length > 0);
  });

  it('load_skill has nextTurnParams for instructions injection', async () => {
    const provider = await createSkillsProvider(skillsDir);
    const tools = createSdkTools(provider);
    const loadTool = tools[0];

    assert.ok(loadTool.function.nextTurnParams);
    assert.ok(loadTool.function.nextTurnParams.instructions);
  });

  it('nextTurnParams injects skill content into instructions', async () => {
    const provider = await createSkillsProvider(skillsDir);
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
    const provider = await createSkillsProvider(skillsDir);
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
    const provider = await createSkillsProvider(skillsDir);
    const tools = createSdkTools(provider);
    const loadTool = tools[0];

    const inject = loadTool.function.nextTurnParams!.instructions!;
    const result = await inject(
      { skill: 'nonexistent' },
      { instructions: 'Base.', input: '', model: '', models: [], temperature: null, maxOutputTokens: null, topP: null },
    );

    assert.equal(result, 'Base.');
  });
});
