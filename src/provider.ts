import { resolve } from 'node:path';
import type {
  SkillDefinition,
  SkillExecutionResult,
  SkillsProvider,
  SkillsProviderOptions,
} from './types.js';
import { discoverSkills } from './parser.js';
import { executeScript } from './executor.js';
import { generateSystemPrompt, getToolDefinitions, getChatCompletionsToolDefinitions } from './prompt.js';

/**
 * Create a SkillsProvider by scanning a directory for skills.
 *
 * Returns an object with everything needed to wire skills into an
 * OpenRouter agent: system prompt, tool definitions, and a handler
 * for tool calls.
 */
export async function createSkillsProvider(
  skillsDir: string,
  options: SkillsProviderOptions = {},
): Promise<SkillsProvider> {
  const resolvedDir = resolve(skillsDir);

  const skillsList = await discoverSkills(resolvedDir, {
    include: options.include,
    exclude: options.exclude,
  });

  const skillsMap = new Map<string, SkillDefinition>();
  for (const skill of skillsList) {
    skillsMap.set(skill.name, skill);
  }

  const systemPrompt = generateSystemPrompt(skillsList);
  const tools = getToolDefinitions();
  const chatCompletionsTools = getChatCompletionsToolDefinitions();
  const skillNames = skillsList.map((s) => s.name);

  async function handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<SkillExecutionResult | string> {
    if (name === 'load_skill') {
      return handleLoadSkill(args);
    }
    if (name === 'use_skill') {
      return handleUseSkill(args);
    }
    return {
      success: false,
      stdout: '',
      stderr: '',
      exitCode: -1,
      error: `Unknown tool: ${name}. Available tools: load_skill, use_skill`,
    };
  }

  function handleLoadSkill(args: Record<string, unknown>): string {
    const skillName = String(args.skill ?? '');
    const skill = skillsMap.get(skillName);
    if (!skill) {
      return `Error: Skill "${skillName}" not found. Available skills: ${skillNames.join(', ')}`;
    }
    return skill.content;
  }

  async function handleUseSkill(
    args: Record<string, unknown>,
  ): Promise<SkillExecutionResult> {
    const skillName = String(args.skill ?? '');
    const script = String(args.script ?? '');
    const rawArgs = args.args;

    // Normalize args to string[]
    let scriptArgs: string[] = [];
    if (Array.isArray(rawArgs)) {
      scriptArgs = rawArgs.map(String);
    } else if (typeof rawArgs === 'string') {
      // Fallback: if model sends a string instead of array, split on spaces
      scriptArgs = rawArgs.split(/\s+/).filter(Boolean);
    }

    const skill = skillsMap.get(skillName);
    if (!skill) {
      return {
        success: false,
        stdout: '',
        stderr: '',
        exitCode: -1,
        error: 'SkillNotFound',
      };
    }

    return executeScript({
      skillDir: skill.dirPath,
      script,
      args: scriptArgs,
      timeout: options.timeout,
      maxOutput: options.maxOutput,
      cwd: options.cwd,
    });
  }

  return {
    systemPrompt,
    tools,
    chatCompletionsTools,
    handleToolCall,
    skillNames,
    skills: skillsMap,
  };
}
