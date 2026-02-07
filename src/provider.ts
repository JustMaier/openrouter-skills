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

/** Internal result from script execution */
export interface SkillExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

/** Result shape returned to the model from SDK tools */
export interface SkillToolResult {
  ok: boolean;
  result?: string;
  error?: string;
  message?: string;
}

/** Error types for structured error reporting */
export type SkillErrorType =
  | 'SkillNotFound'
  | 'ScriptNotFound'
  | 'ScriptNotAllowed'
  | 'InvalidArgs'
  | 'ExecutionTimeout'
  | 'ExecutionFailed';

/** Event emitted by processTurn for UI display */
export interface TurnEvent {
  type: 'tool_call' | 'tool_result';
  name: string;
  arguments?: string;
  result?: string;
}

/** Output from processTurn */
export interface TurnOutput {
  text: string;
  history: unknown[];
}

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

const toolResultSchema = z.object({
  ok: z.boolean(),
  result: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

// --- Helpers ---

function fail(error: string, stderr = ''): SkillExecutionResult {
  return { success: false, stdout: '', stderr, exitCode: -1, error };
}

/** Reshape internal execution result to the thin format returned to models */
function toToolResult(r: SkillExecutionResult): SkillToolResult {
  if (r.success) {
    return { ok: true, result: r.stdout };
  }
  const out: SkillToolResult = { ok: false, error: r.error };
  if (r.stderr) out.message = r.stderr;
  return out;
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
      'Load a skill\'s instructions once to learn what scripts and commands it provides. ' +
      'Only call this once per skill — the instructions stay in context for the rest of the conversation.',
    inputSchema: z.object({
      skill: z.string().describe(
        `The skill to load. Available: ${skillNames.join(', ')}`
      ),
    }),
    outputSchema: toolResultSchema,
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
      return toToolResult(await provider.handleToolCall('load_skill', { skill }));
    },
  });

  const useSkillTool = tool({
    name: 'use_skill',
    description:
      'Run a script from a previously loaded skill. ' +
      'Refer to the skill instructions already in your context for available scripts and arguments.',
    inputSchema: z.object({
      skill: z.string().describe('The skill that provides the script.'),
      script: z.string().describe('The script filename to run.'),
      args: z.array(z.string()).default([]).describe('Arguments to pass to the script.'),
      remember: z.boolean().default(false).describe(
        'Set to true if you want to reference the result of this request as you continue to perform your work - be conservative.'
      ),
    }),
    outputSchema: toolResultSchema,
    execute: async ({ skill, script, args }) => {
      return toToolResult(await provider.handleToolCall('use_skill', { skill, script, args }));
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

// --- Turn processing helper ---

/**
 * Process a callModel result: stream tool events, collect history, and return final text.
 *
 * Handles the common pattern of iterating `getItemsStream()` for UI display while
 * collecting SDK-format items for session history. Respects the `remember` flag on
 * `use_skill` calls — when `false`, the tool call and its result are emitted to the
 * callback for display but excluded from the returned history.
 *
 * ```ts
 * const tools = await createSkillsTools('./skills');
 * const result = client.callModel({ input: messages, tools, ... });
 *
 * const { text, history } = await processTurn(result, (event) => {
 *   // stream event to UI (SSE, WebSocket, etc.)
 * });
 *
 * messages.push(...history);
 * messages.push({ role: 'assistant', content: text });
 * ```
 */
export async function processTurn(
  result: { getItemsStream(): AsyncIterable<Record<string, unknown>>; getText(): Promise<string> },
  onEvent?: (event: TurnEvent) => void,
): Promise<TurnOutput> {
  const seenCalls = new Set<string>();
  const seenResults = new Set<string>();
  const callNames = new Map<string, string>();
  const skipCallIds = new Set<string>();
  const history: unknown[] = [];

  for await (const item of result.getItemsStream()) {
    if (item.type === 'function_call') {
      const callId = item.callId as string;
      const name = item.name as string;
      callNames.set(callId, name);

      if (item.status === 'completed' && !seenCalls.has(callId)) {
        seenCalls.add(callId);

        // Check remember flag on use_skill calls (default: don't persist)
        let persist = true;
        if (name === 'use_skill') {
          try {
            const args = JSON.parse(item.arguments as string);
            if (args.remember !== true) persist = false;
          } catch { /* don't persist if args can't be parsed */ }
        }

        if (persist) {
          history.push({ type: 'function_call', callId, name, arguments: item.arguments });
        } else {
          skipCallIds.add(callId);
        }

        onEvent?.({
          type: 'tool_call',
          name,
          arguments: item.arguments as string,
        });
      }
    } else if (item.type === 'function_call_output') {
      const callId = item.callId as string;
      if (!seenResults.has(callId)) {
        seenResults.add(callId);

        if (!skipCallIds.has(callId)) {
          history.push({ type: 'function_call_output', callId, output: item.output });
        }

        onEvent?.({
          type: 'tool_result',
          name: callNames.get(callId) ?? 'unknown',
          result: item.output as string,
        });
      }
    }
  }

  const text = await result.getText();
  return { text, history };
}
