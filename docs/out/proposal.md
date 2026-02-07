# Skills-as-Tools: Library Proposal (Final)

## Goal

Build a JavaScript library that lets you point OpenRouter-powered agents at a directory of skills. The agent receives skill summaries in its system prompt, can load full skill content on demand, and can execute skill scripts -- all through standard OpenRouter tool calling.

## Skill Folder Layout

```
skills/
  discord/
    SKILL.md            # frontmatter + instructions
    discord.mjs         # executable script
  deploy/
    SKILL.md
    scripts/
      deploy.sh
      verify.mjs
  code-review/
    SKILL.md
```

### SKILL.md Format

```yaml
---
name: discord
description: Post messages and manage channels on Discord. Use when the user asks to send messages, list channels, or manage Discord.
---

## Usage

To list channels:
```
discord.mjs channels list
```

To send a message:
```
discord.mjs send "Your message" --channel=CHANNEL_ID
```

## Channel IDs
Run `discord.mjs channels list` first to get IDs.
```

Frontmatter fields for v1: `name` and `description` only. The `description` is what the agent sees in its system prompt. The markdown body is what it gets when it loads the skill.

## API Choice: Responses API

The library targets the **OpenRouter Responses API** (`/api/v1/responses`) rather than the OpenAI-compatible Chat Completions endpoint. The Responses API provides native token counts, status tracking, `parallel_tool_calls` configuration, and `previous_response_id` for conversation chaining. See `openrouter-tool-calling.md` for the full comparison.

When used with the `@openrouter/sdk`, the library also works with `callModel()` and `chat.send()`.

## Tools Exposed to the Agent

The library registers two tools with OpenRouter. Definitions shown in Responses API format (flat, no `function` wrapper):

### `load_skill`

Retrieves the full SKILL.md content (minus frontmatter) for a named skill.

```typescript
{
  type: 'function',
  name: 'load_skill',
  description: 'Load the full instructions for a skill. Call this before using a skill for the first time.',
  parameters: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'Name of the skill to load (folder name)'
      }
    },
    required: ['skill']
  }
}
```

**Returns**: The markdown content of SKILL.md (everything below the frontmatter).

### `use_skill`

Executes a script inside a skill folder with the given arguments.

```typescript
{
  type: 'function',
  name: 'use_skill',
  description: 'Run a script from a skill folder. The skill instructions tell you which scripts to call and with what arguments.',
  parameters: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'Name of the skill (folder name)'
      },
      script: {
        type: 'string',
        description: 'Script filename to run (e.g. "discord.mjs")'
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments to pass to the script as individual items (e.g. ["channels", "list"] or ["send", "Hello World", "--channel=123"])'
      }
    },
    required: ['skill', 'script']
  }
}
```

**Returns**: Structured result:

```typescript
interface SkillExecutionResult {
  success: boolean;
  stdout: string;       // capped at 20KB, truncated with "[output truncated]" if exceeded
  stderr: string;       // capped at 20KB
  exitCode: number;
  error?: string;       // set on failure (timeout, script not found, etc.)
}
```

### SDK `tool()` equivalents

When used with the OpenRouter SDK, these are also available as Zod-typed tools:

```typescript
import { tool } from '@openrouter/sdk';
import { z } from 'zod';

const loadSkillTool = tool({
  name: 'load_skill',
  description: 'Load the full instructions for a skill.',
  inputSchema: z.object({ skill: z.string() }),
  execute: async ({ skill }) => skills.handleToolCall('load_skill', { skill }),
});

const useSkillTool = tool({
  name: 'use_skill',
  description: 'Run a script from a skill folder.',
  inputSchema: z.object({
    skill: z.string(),
    script: z.string(),
    args: z.array(z.string()).optional(),
  }),
  execute: async (params) => skills.handleToolCall('use_skill', params),
});
```

## System Prompt Injection

The library generates a system prompt section listing all discovered skills:

```
## Available Skills

You have access to skills that help you perform specific tasks. Each skill has instructions and scripts you can run.

To use a skill:
1. Call load_skill to read its instructions
2. Follow the instructions, calling use_skill to run scripts as directed

### discord
Post messages and manage channels on Discord. Use when the user asks to send messages, list channels, or manage Discord.

### deploy
Deploy applications to staging or production. Use when the user says "deploy", "ship", or "push to prod".

### code-review
Review code changes and provide feedback. Use when the user asks for a code review or PR review.
```

## Library API

### `createSkillsProvider(skillsDir, options?)`

Scans the skills directory, parses SKILL.md files, returns an object with everything needed to wire into an OpenRouter agent.

```typescript
import { createSkillsProvider } from 'openrouter-skills';

const skills = await createSkillsProvider('./skills', {
  include: ['discord', 'deploy'],  // optional: only load these skills
  exclude: ['code-review'],        // optional: skip these skills
  timeout: 30000,                  // script execution timeout (ms)
  maxOutput: 20480,                // max bytes per stdout/stderr (default 20KB)
  cwd: process.cwd(),              // working directory for scripts
});
```

Returns:

```typescript
interface SkillsProvider {
  /** System prompt section listing all skills */
  systemPrompt: string;

  /** Tool definitions for load_skill and use_skill */
  tools: ToolDefinition[];

  /** Execute a tool call from the agent. Returns structured result. */
  handleToolCall(name: string, args: Record<string, any>): Promise<SkillExecutionResult | string>;

  /** List of discovered skill names */
  skillNames: string[];
}
```

### Wiring Into an Agent

```typescript
import { createSkillsProvider } from 'openrouter-skills';

const skills = await createSkillsProvider('./skills');

// Add skills to your existing system prompt
const systemPrompt = `You are a helpful assistant.\n\n${skills.systemPrompt}`;

// Add skill tools alongside your other tools
const allTools = [...myOtherTools, ...skills.tools];

// In your agentic loop, handle skill tool calls
async function executeToolCall(name, args) {
  if (name === 'load_skill' || name === 'use_skill') {
    return await skills.handleToolCall(name, args);
  }
  // handle other tools...
}
```

### With the OpenRouter SDK

```typescript
import { createSkillsProvider } from 'openrouter-skills';
import { OpenRouter } from '@openrouter/sdk';

const skills = await createSkillsProvider('./skills');
const openrouter = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });

const result = openrouter.callModel({
  model: 'anthropic/claude-3.5-sonnet',
  input: 'Send Hello World to the #dev channel on Discord',
  instructions: `You are a helpful assistant.\n\n${skills.systemPrompt}`,
  tools: [...skills.sdkTools],   // pre-built tool() instances
  maxToolRounds: 10,
});

const text = await result.getText();
```

## Example Flow

User: "Send 'Hello World' to the #dev channel on Discord"

1. Agent sees `discord` in its skill list. Calls `load_skill({ skill: 'discord' })`.
2. Library reads `skills/discord/SKILL.md`, strips frontmatter, returns the instructions.
3. Agent reads the instructions, learns it needs channel IDs first. Calls `use_skill({ skill: 'discord', script: 'discord.mjs', args: ['channels', 'list'] })`.
4. Library validates `discord.mjs` exists inside `skills/discord/`. Spawns `node skills/discord/discord.mjs channels list` via `execFile`. Returns `{ success: true, stdout: "...", exitCode: 0 }`.
5. Agent finds the #dev channel ID. Calls `use_skill({ skill: 'discord', script: 'discord.mjs', args: ['send', 'Hello World', '--channel=1234567890'] })`.
6. Library spawns the script, returns structured result.
7. Agent responds: "Done. Sent 'Hello World' to #dev."

## Example App Structure (SvelteKit)

```
example/
  skills/
    discord/
      SKILL.md
      discord.mjs
    weather/
      SKILL.md
      weather.mjs
  src/
    lib/
      skills-provider.ts    # createSkillsProvider implementation
      skill-parser.ts       # SKILL.md frontmatter + content parsing
      skill-executor.ts     # script spawning with timeout/sandboxing
      types.ts              # shared types
    routes/
      +page.svelte          # chat UI
      api/
        chat/
          +server.ts        # agent endpoint wiring skills + OpenRouter
  package.json
  svelte.config.js
```

## Library Package Structure

```
openrouter-skills/
  src/
    index.ts                # main export: createSkillsProvider
    provider.ts             # SkillsProvider implementation
    parser.ts               # parse SKILL.md (frontmatter + markdown)
    executor.ts             # spawn scripts, collect output, cap size
    prompt.ts               # generate system prompt section
    types.ts                # TypeScript interfaces
  package.json
  tsconfig.json
```

## Security Model

1. **Script containment**: `use_skill` validates that the `script` file exists inside the named skill's directory. No path traversal (`../`), no absolute paths, no calling binaries outside the skill folder.
2. **No shell execution**: Args pass through `child_process.execFile` as an array, not through a shell. No shell expansion, no command injection.
3. **Timeout**: Configurable timeout kills runaway scripts (default 30s).
4. **Output caps**: stdout and stderr are each capped at a configurable size (default 20KB). Excess is truncated with `[output truncated]`.
5. **Structured errors**: Failures return typed errors (`SkillNotFound`, `ScriptNotFound`, `ScriptNotAllowed`, `ExecutionTimeout`, `ExecutionFailed`) so the agent can understand what went wrong and recover.

## Decisions Log

Decisions made after review by Gemini 3 Pro and GPT-5.1 Codex:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| `use_skill` args format | `string[]` (array) | Safer than single string. Maps directly to `execFile`. Avoids shell escaping issues. |
| Sanitize process.env | Skip for v1 | Scripts inherit host env. Revisit if needed. |
| Cap stdout/stderr | Yes, 20KB default | Prevents context window overflow from runaway output. |
| Additional frontmatter fields | Skip for v1 | `name` and `description` only. Keep it simple. |
| Structured errors | Yes | Agent needs to distinguish failure types to recover. |
| `!command` preprocessing | Skip for v1 | Would require skills to call arbitrary commands outside their directory. Conflicts with containment model. |
| Context fork / sub-agents | Skip for v1 | Too complex for initial version. |
| Script validation | Strict containment | Scripts must exist inside the skill folder. No external binaries, no path traversal. |
