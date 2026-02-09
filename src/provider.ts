import { resolve, join } from 'node:path';
import { stat } from 'node:fs/promises';
import { tool } from '@openrouter/sdk';
import { z } from 'zod';
import { discoverSkills, loadSkill } from './parser.js';
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

/** Event emitted by processTurn for UI display */
export interface TurnEvent {
  type: 'tool_call' | 'tool_result' | 'text_delta';
  name?: string;
  arguments?: string;
  result?: string;
  delta?: string;
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

/** Result shape returned to the model from SDK tools */
export type SkillToolResult = z.infer<typeof toolResultSchema>;

// --- Helpers ---

function fail(error: string, stderr = ''): SkillExecutionResult {
  return { success: false, stdout: '', stderr, exitCode: -1, error };
}

/** Reshape internal execution result to the thin format returned to models */
export function toToolResult(r: SkillExecutionResult): SkillToolResult {
  if (r.success) {
    return { ok: true, result: r.stdout };
  }
  const out: SkillToolResult = { ok: false, error: r.error };
  if (r.stderr) out.message = r.stderr;
  return out;
}

// --- Provider ---

/**
 * Create a SkillsProvider by scanning one or more directories for skills.
 *
 * When multiple directories are provided, all are scanned and their skills are merged.
 * If the same skill name appears in multiple directories, the first directory wins.
 *
 * For most use cases, prefer `createSkillsTools()` which returns SDK tools directly.
 * Use this when you need access to the skills map or handleToolCall for custom integrations.
 */
export async function createSkillsProvider(
  skillsDirs: string | string[],
  options: SkillsProviderOptions = {},
): Promise<SkillsProvider> {
  const dirs = Array.isArray(skillsDirs) ? skillsDirs : [skillsDirs];
  const resolvedDirs = dirs.map(d => resolve(d));

  const filterOpts = { include: options.include, exclude: options.exclude };
  const nested = await Promise.all(resolvedDirs.map(d => discoverSkills(d, filterOpts)));
  const skillsList = nested.flat();

  const skillsMap = new Map<string, SkillDefinition>();
  const mtimes = new Map<string, number>(); // skillName → SKILL.md mtimeMs

  /** Add skills to the map, skipping duplicates (first wins). */
  async function addSkills(list: SkillDefinition[], warnDup = true) {
    for (const skill of list) {
      if (skillsMap.has(skill.name)) {
        if (warnDup) {
          const existing = skillsMap.get(skill.name)!;
          console.warn(
            `[openrouter-skills] Duplicate skill "${skill.name}" ` +
            `(keeping ${existing.dirPath}, skipping ${skill.dirPath}).`
          );
        }
        continue;
      }
      skillsMap.set(skill.name, skill);
      try {
        const s = await stat(join(skill.dirPath, 'SKILL.md'));
        mtimes.set(skill.name, s.mtimeMs);
      } catch { /* skill without stat — won't auto-refresh */ }
    }
  }

  await addSkills(skillsList);

  /** Re-parse a single skill if its SKILL.md mtime changed. */
  async function refreshIfStale(skillName: string): Promise<void> {
    const skill = skillsMap.get(skillName);
    if (!skill) return;

    try {
      const s = await stat(join(skill.dirPath, 'SKILL.md'));
      const cached = mtimes.get(skillName);
      if (cached !== undefined && s.mtimeMs === cached) return;

      const updated = await loadSkill(skill.dirPath, skillName);
      skillsMap.set(skillName, updated);
      mtimes.set(skillName, s.mtimeMs);
    } catch { /* stat/parse failed — keep existing */ }
  }

  /** Re-discover all dirs to find newly added skills. */
  async function rediscover(): Promise<void> {
    const nested = await Promise.all(resolvedDirs.map(d => discoverSkills(d, filterOpts)));
    await addSkills(nested.flat(), false);
  }

  // skillNames is a live getter so it reflects newly discovered skills
  const provider: SkillsProvider = {
    get skillNames() { return [...skillsMap.keys()]; },
    skills: skillsMap,
    handleToolCall: async (name, args) => {
      if (name === 'load_skill') {
        const skillName = String(args.skill ?? '');

        let skill = skillsMap.get(skillName);
        if (skill) {
          await refreshIfStale(skillName);
          skill = skillsMap.get(skillName)!;
        } else {
          // Not found — maybe it was added since startup
          await rediscover();
          skill = skillsMap.get(skillName);
        }
        if (!skill) {
          return fail('SkillNotFound', `"${skillName}" not found. Available: ${provider.skillNames.join(', ')}`);
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

        await refreshIfStale(skillName);

        let skill = skillsMap.get(skillName);
        if (!skill) {
          return fail('SkillNotFound');
        }

        // If script not found, force a full re-parse (script may have been added
        // without touching SKILL.md, so mtime check alone won't catch it)
        if (!skill.scripts.includes(script)) {
          mtimes.delete(skillName); // force re-parse
          await refreshIfStale(skillName);
          skill = skillsMap.get(skillName)!;
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
    },
  };

  return provider;
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
      script: z.string().describe('The script filename to run as outlined in the skill (ex. skill.mjs, cli.js, run.sh).'),
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
  skillsDirs: string | string[],
  options: SkillsProviderOptions = {},
) {
  const provider = await createSkillsProvider(skillsDirs, options);
  return createSdkTools(provider);
}

/**
 * Create manual tools (execute: false) from SDK tools.
 *
 * Use these with a custom multi-turn loop for real streaming between turns.
 * The SDK's auto-execution batches items across turns; manual tools let you
 * call `callModel` per turn and stream each turn independently.
 */
export function createManualTools(sdkTools: ReturnType<typeof createSdkTools>) {
  return sdkTools.map(t => ({
    ...t,
    function: { ...t.function, execute: false, nextTurnParams: undefined },
  }));
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
  result: {
    getItemsStream(): AsyncIterable<Record<string, unknown>>;
    getText(): Promise<string>;
  },
  onEvent?: (event: TurnEvent) => void,
): Promise<TurnOutput> {
  const seenCalls = new Set<string>();
  const seenResults = new Set<string>();
  const callNames = new Map<string, string>();
  const skipCallIds = new Set<string>();
  const history: unknown[] = [];

  // Track cumulative text from message items to compute deltas
  let streamedText = '';

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
    } else if (item.type === 'message') {
      // Extract text from cumulative message content and emit deltas
      const content = item.content;
      let text = '';
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part === 'object' && 'text' in part) {
            text += (part as { text: string }).text;
          }
        }
      } else if (typeof content === 'string') {
        text = content;
      }
      if (text.length > streamedText.length) {
        const delta = text.slice(streamedText.length);
        streamedText = text;
        onEvent?.({ type: 'text_delta', delta });
      }
    }
  }

  // Fall back to getText() if no text was streamed from message items
  const text = streamedText || await result.getText();
  return { text, history };
}
