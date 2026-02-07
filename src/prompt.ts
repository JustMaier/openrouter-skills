import type {
  SkillDefinition,
  ResponsesToolDefinition,
  ChatCompletionsToolDefinition,
} from './types.js';

/**
 * Generate a system prompt section listing all available skills.
 *
 * Each skill gets a ### heading followed by its description. Returns an empty
 * string when no skills are provided.
 */
export function generateSystemPrompt(skills: SkillDefinition[]): string {
  if (skills.length === 0) {
    return '';
  }

  const lines: string[] = [
    '## Available Skills',
    '',
    'You have access to skills that help you perform specific tasks. Each skill has instructions and scripts you can run.',
    '',
    'To use a skill:',
    '1. Call load_skill to read its full instructions',
    '2. Follow the instructions, calling use_skill to run scripts as directed',
  ];

  for (const skill of skills) {
    lines.push('', `### ${skill.name}`, skill.description);
  }

  return lines.join('\n');
}

/**
 * Return tool definitions in Responses API format (flat, no `function` wrapper).
 *
 * Two tools are defined:
 * - `load_skill`  -- read a skill's full instructions
 * - `use_skill`   -- execute a script provided by a skill
 */
export function getToolDefinitions(): ResponsesToolDefinition[] {
  return [
    {
      type: 'function',
      name: 'load_skill',
      description:
        'Load the full instructions for a skill. Call this before using a skill to understand what scripts are available and how to use them.',
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: 'The name of the skill to load.',
          },
        },
        required: ['skill'],
      },
    },
    {
      type: 'function',
      name: 'use_skill',
      description:
        'Run a script provided by a skill. You must load the skill first to know which scripts are available and what arguments they accept.',
      parameters: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: 'The name of the skill that provides the script.',
          },
          script: {
            type: 'string',
            description: 'The filename of the script to run.',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional arguments to pass to the script.',
          },
        },
        required: ['skill', 'script'],
      },
    },
  ];
}

/**
 * Return tool definitions in Chat Completions format (nested `function` wrapper).
 *
 * Produces the same two tools as {@link getToolDefinitions} but wrapped in the
 * `{ type: 'function', function: { ... } }` structure expected by the Chat
 * Completions API.
 */
export function getChatCompletionsToolDefinitions(): ChatCompletionsToolDefinition[] {
  const responsesTools = getToolDefinitions();

  return responsesTools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
