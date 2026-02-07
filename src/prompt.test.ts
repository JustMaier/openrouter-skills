import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SkillDefinition } from './types.js';
import {
  generateSystemPrompt,
  getToolDefinitions,
  getChatCompletionsToolDefinitions,
} from './prompt.js';

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: 'test-skill',
    description: 'A test skill.',
    content: '## Usage\nDo things.',
    dirPath: '/tmp/skills/test-skill',
    scripts: ['test.mjs'],
    ...overrides,
  };
}

describe('generateSystemPrompt', () => {
  it('returns empty string for no skills', () => {
    assert.equal(generateSystemPrompt([]), '');
  });

  it('includes header and instructions', () => {
    const prompt = generateSystemPrompt([makeSkill()]);
    assert.ok(prompt.includes('## Available Skills'));
    assert.ok(prompt.includes('load_skill'));
    assert.ok(prompt.includes('use_skill'));
  });

  it('lists each skill with name and description', () => {
    const skills = [
      makeSkill({ name: 'discord', description: 'Send messages.' }),
      makeSkill({ name: 'weather', description: 'Get forecasts.' }),
    ];
    const prompt = generateSystemPrompt(skills);
    assert.ok(prompt.includes('### discord'));
    assert.ok(prompt.includes('Send messages.'));
    assert.ok(prompt.includes('### weather'));
    assert.ok(prompt.includes('Get forecasts.'));
  });
});

describe('getToolDefinitions', () => {
  it('returns two tool definitions', () => {
    const tools = getToolDefinitions();
    assert.equal(tools.length, 2);
  });

  it('defines load_skill tool correctly', () => {
    const tools = getToolDefinitions();
    const loadSkill = tools.find((t) => t.name === 'load_skill');
    assert.ok(loadSkill);
    assert.equal(loadSkill.type, 'function');
    assert.ok(loadSkill.description.length > 0);
    assert.deepEqual(loadSkill.parameters.required, ['skill']);
    assert.ok(loadSkill.parameters.properties['skill']);
  });

  it('defines use_skill tool correctly', () => {
    const tools = getToolDefinitions();
    const useSkill = tools.find((t) => t.name === 'use_skill');
    assert.ok(useSkill);
    assert.equal(useSkill.type, 'function');
    assert.deepEqual(useSkill.parameters.required, ['skill', 'script']);
    assert.ok(useSkill.parameters.properties['skill']);
    assert.ok(useSkill.parameters.properties['script']);
    assert.ok(useSkill.parameters.properties['args']);
    assert.equal(useSkill.parameters.properties['args'].type, 'array');
  });
});

describe('getChatCompletionsToolDefinitions', () => {
  it('wraps tools in function property', () => {
    const tools = getChatCompletionsToolDefinitions();
    assert.equal(tools.length, 2);

    for (const tool of tools) {
      assert.equal(tool.type, 'function');
      assert.ok(tool.function);
      assert.ok(tool.function.name);
      assert.ok(tool.function.description);
      assert.ok(tool.function.parameters);
    }
  });

  it('has same content as Responses API format', () => {
    const responsesTools = getToolDefinitions();
    const chatTools = getChatCompletionsToolDefinitions();

    for (let i = 0; i < responsesTools.length; i++) {
      assert.equal(chatTools[i].function.name, responsesTools[i].name);
      assert.equal(chatTools[i].function.description, responsesTools[i].description);
      assert.deepEqual(chatTools[i].function.parameters, responsesTools[i].parameters);
    }
  });
});
