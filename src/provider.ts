import { resolve } from 'node:path';
import { tool } from '@openrouter/sdk';
import { z } from 'zod';
import { discoverSkills } from './parser.js';
import { executeScript } from './executor.js';

// --- Types ---

/** Parsed content of a SKILL.md file */
export interface SkillDefinition {
  name: string;
  description: string;
  content: string;
  dirPath: string;
  scripts: string[];
}

/** Result from executing a skill script */
export interface SkillExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

/** Error types for structured error reporting */
export type SkillErrorType =
  | 'SkillNotFound'
  | 'ScriptNotFound'
  | 'ScriptNotAllowed'
  | 'InvalidArgs'
  | 'ExecutionTimeout'
  | 'ExecutionFailed';

/** Options for createSkillsProvider / createSkillsTools */
export interface SkillsProviderOptions {
  include?: string[];
  exclude?: string[];
  timeout?: number;
  maxOutput?: number;
  cwd?: string;
  env?: Record<string, string>;
}

/** The provider returned by createSkillsProvider */
export interface SkillsProvider {
  handleToolCall(name: string, args: Record<string, unknown>): Promise<SkillExecutionResult>;
  skillNames: string[];
  skills: Map<string, SkillDefinition>;
}

// --- Shared Zod schema for tool results ---

const executionResultSchema = z.object({
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  error: z.string().optional(),
});

// --- Error helper ---

function fail(error: string, stderr = ''): SkillExecutionResult {
  return { success: false, stdout: '', stderr, exitCode: -1, error };
}

// --- Provider ---

/**
 * Create a SkillsProvider by scanning a directory for skills.
 *
 * For most use cases, prefer `createSkillsTools()` which returns SDK tools directly.
 * Use this when you need access to the skills map or handleToolCall for custom integrations.
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
      const skillName = String(args.skill ?? '');
      const skill = skillsMap.get(skillName);
      if (!skill) {
        return fail('SkillNotFound', `"${skillName}" not found. Available: ${skillNames.join(', ')}`);
      }
      return { success: true, stdout: skill.content, stderr: '', exitCode: 0 };
    }

    if (name === 'use_skill') {
      const skillName = String(args.skill ?? '');
      const script = String(args.script ?? '');
      const rawArgs = args.args;

      let scriptArgs: string[] = [];
      if (Array.isArray(rawArgs)) {
        scriptArgs = rawArgs.map(String);
      } else if (rawArgs !== undefined && rawArgs !== null) {
        return fail('InvalidArgs', `args must be an array of strings, got ${typeof rawArgs}`);
      }

      const skill = skillsMap.get(skillName);
      if (!skill) {
        return fail('SkillNotFound');
      }

      if (!skill.scripts.includes(script)) {
        return fail('ScriptNotAllowed', `"${script}" not registered for "${skillName}". Available: ${skill.scripts.join(', ') || 'none'}`);
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

    return fail('UnknownTool', `Unknown tool: ${name}. Available: load_skill, use_skill`);
  }

  return { handleToolCall, skillNames, skills: skillsMap };
}

// --- SDK Tools ---

/**
 * Create SDK-compatible tools from a SkillsProvider.
 *
 * Returns tools ready for `client.callModel({ tools })`. The `load_skill` tool
 * uses `nextTurnParams` to inject skill instructions into the model's context.
 */
export function createSdkTools(provider: SkillsProvider) {
  const { skills, skillNames } = provider;

  const loadSkillTool = tool({
    name: 'load_skill',
    description:
      'Load the full instructions for a skill. Call this before using a skill to understand what scripts are available and how to use them.',
    inputSchema: z.object({
      skill: z.string().describe(
        `The name of the skill to load. Available: ${skillNames.join(', ')}`
      ),
    }),
    outputSchema: executionResultSchema,
    nextTurnParams: {
      instructions: (params, context) => {
        const marker = `[Skill: ${params.skill}]`;
        const current = context.instructions ?? '';
        if (current.includes(marker)) return current;
        const s = skills.get(params.skill);
        if (!s) return current;
        return `${current}\n\n${marker}\n${s.content}`;
      },
    },
    execute: async ({ skill }) => {
      return provider.handleToolCall('load_skill', { skill });
    },
  });

  const useSkillTool = tool({
    name: 'use_skill',
    description:
      'Run a script provided by a skill. You must load the skill first to know which scripts are available and what arguments they accept.',
    inputSchema: z.object({
      skill: z.string().describe('The name of the skill that provides the script.'),
      script: z.string().describe('The filename of the script to run.'),
      args: z.array(z.string()).default([]).describe('Arguments to pass to the script.'),
    }),
    outputSchema: executionResultSchema,
    execute: async ({ skill, script, args }) => {
      return provider.handleToolCall('use_skill', { skill, script, args });
    },
  });

  return [loadSkillTool, useSkillTool];
}

/**
 * Discover skills and return SDK tools in one step.
 *
 * This is the primary API for most users:
 * ```ts
 * const tools = await createSkillsTools('./skills');
 * const result = client.callModel({ tools, ... });
 * ```
 */
export async function createSkillsTools(
  skillsDir: string,
  options: SkillsProviderOptions = {},
) {
  const provider = await createSkillsProvider(skillsDir, options);
  return createSdkTools(provider);
}
