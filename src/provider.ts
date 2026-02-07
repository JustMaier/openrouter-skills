import { resolve } from 'node:path';
import type {
  SkillDefinition,
  SkillExecutionResult,
  SkillsProvider,
  SkillsProviderOptions,
} from './types.js';
import { discoverSkills } from './parser.js';
import { executeScript } from './executor.js';

/**
 * Create a SkillsProvider by scanning a directory for skills.
 *
 * Returns an object with the skill map and a handler for tool calls.
 * Pass the result to `createSdkTools()` to get tools for `callModel`.
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
    if (skillsMap.has(skill.name)) {
      const existing = skillsMap.get(skill.name)!;
      console.warn(
        `[openrouter-skills] Duplicate skill name "${skill.name}" ` +
        `(${existing.dirPath} and ${skill.dirPath}). Using the latter.`
      );
    }
    skillsMap.set(skill.name, skill);
  }

  const skillNames = skillsList.map((s) => s.name);

  async function handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<SkillExecutionResult> {
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

  function handleLoadSkill(args: Record<string, unknown>): SkillExecutionResult {
    const skillName = String(args.skill ?? '');
    const skill = skillsMap.get(skillName);
    if (!skill) {
      return {
        success: false,
        stdout: '',
        stderr: '',
        exitCode: -1,
        error: `SkillNotFound: "${skillName}" not found. Available skills: ${skillNames.join(', ')}`,
      };
    }
    return {
      success: true,
      stdout: skill.content,
      stderr: '',
      exitCode: 0,
    };
  }

  async function handleUseSkill(
    args: Record<string, unknown>,
  ): Promise<SkillExecutionResult> {
    const skillName = String(args.skill ?? '');
    const script = String(args.script ?? '');
    const rawArgs = args.args;

    // Args must be an array of strings
    let scriptArgs: string[] = [];
    if (Array.isArray(rawArgs)) {
      scriptArgs = rawArgs.map(String);
    } else if (rawArgs !== undefined && rawArgs !== null) {
      return {
        success: false,
        stdout: '',
        stderr: '',
        exitCode: -1,
        error: 'InvalidArgs: args must be an array of strings, got ' + typeof rawArgs,
      };
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

    // Validate script is in the skill's discovered scripts list
    if (!skill.scripts.includes(script)) {
      return {
        success: false,
        stdout: '',
        stderr: '',
        exitCode: -1,
        error: `ScriptNotAllowed: "${script}" is not a registered script for skill "${skillName}". Available: ${skill.scripts.join(', ') || 'none'}`,
      };
    }

    return executeScript({
      skillDir: skill.dirPath,
      script,
      args: scriptArgs,
      timeout: options.timeout,
      maxOutput: options.maxOutput,
      cwd: options.cwd,
      env: options.env,
    });
  }

  return {
    handleToolCall,
    skillNames,
    skills: skillsMap,
  };
}
