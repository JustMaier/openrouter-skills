import { tool } from '@openrouter/sdk';
import { z } from 'zod';
import type { SkillsProvider } from './types.js';

const executionResultSchema = z.object({
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  error: z.string().optional(),
});

/**
 * Create SDK-compatible tools from a SkillsProvider.
 *
 * Returns tools ready for `client.callModel({ tools })`. The `load_skill` tool
 * uses `nextTurnParams` to inject skill instructions into the model's context
 * for subsequent turns — no manual system prompt wiring needed.
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
      args: z.array(z.string()).optional().describe('Optional arguments to pass to the script.'),
    }),
    outputSchema: executionResultSchema,
    execute: async ({ skill, script, args }) => {
      return provider.handleToolCall('use_skill', { skill, script, args });
    },
  });

  return [loadSkillTool, useSkillTool];
}
