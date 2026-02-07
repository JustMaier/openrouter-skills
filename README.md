# openrouter-skills

Give OpenRouter agents skills through directory-based `SKILL.md` files and executable scripts.

Built on the [OpenRouter TypeScript SDK](https://github.com/OpenRouterTeam/typescript-sdk). The agent discovers skills at startup, loads instructions on demand via `nextTurnParams`, and executes scripts securely — all through `callModel`.

## Install

```bash
npm install openrouter-skills @openrouter/sdk zod
```

## Quick Start

```typescript
import OpenRouter, { stepCountIs } from '@openrouter/sdk';
import { createSkillsProvider, createSdkTools } from 'openrouter-skills';

const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY });
const skills = await createSkillsProvider('./skills');

const result = client.callModel({
  model: 'anthropic/claude-sonnet-4',
  instructions: 'You are a helpful assistant.',
  input: 'Send "Hello World" to #dev on Discord',
  tools: createSdkTools(skills),
  stopWhen: stepCountIs(10),
});

const text = await result.getText();
```

No manual agentic loop. No tool call parsing. The SDK handles multi-turn execution automatically, and `nextTurnParams` injects skill instructions into the model's context when `load_skill` is called.

## How It Works

1. **Discovery** — scans a directory for subdirectories containing `SKILL.md` files
2. **`load_skill`** — model reads a skill's full instructions; `nextTurnParams` injects them into context for subsequent turns
3. **`use_skill`** — model executes scripts via the secure executor

```
User: "Send Hello World to #dev on Discord"

Agent -> load_skill({ skill: "discord" })        # reads SKILL.md, injects into context
Agent -> use_skill(discord, discord.mjs, ["channels", "list"])
Agent -> use_skill(discord, discord.mjs, ["send", "Hello World", "--channel=1002"])
Agent -> "Done. Sent 'Hello World' to #dev."
```

## Skill Folder Layout

```
skills/
  discord/
    SKILL.md          # frontmatter + instructions
    discord.mjs       # executable script
  weather/
    SKILL.md
    weather.mjs
    scripts/          # optional subfolder
      helper.js
```

Scripts are discovered automatically by file extension: `.mjs`, `.js`, `.sh`. The library looks in both the skill root and a `scripts/` subfolder. Only discovered scripts can be executed.

### SKILL.md Format

```yaml
---
name: discord
description: Post messages and manage channels on Discord.
---

## Usage

List channels:
```
discord.mjs channels list
```

Send a message:
```
discord.mjs send "Your message" --channel=CHANNEL_ID
```
```

The `name` defaults to the folder name if omitted. The `description` is used in tool schemas. The markdown body is injected into the model's context when `load_skill` is called.

## API

### `createSkillsProvider(skillsDir, options?)`

Discovers skills and prepares the execution layer.

```typescript
const skills = await createSkillsProvider('./skills', {
  include: ['discord'],    // only load these skills
  exclude: ['internal'],   // skip these skills
  timeout: 30000,          // script timeout in ms (default 30s)
  maxOutput: 20480,        // max stdout/stderr bytes (default 20KB)
  cwd: process.cwd(),      // working directory for scripts
  env: { PATH: '...' },   // environment for scripts (replaces process.env if set)
});
```

### `createSdkTools(skills)`

Creates SDK-compatible tools from a provider. Pass the result to `callModel({ tools })`.

```typescript
const sdkTools = createSdkTools(skills);

const result = client.callModel({
  model: 'anthropic/claude-sonnet-4',
  input: 'Check the weather in Paris',
  tools: sdkTools,
});
```

### Error Codes

Tool execution returns a `SkillExecutionResult`. On failure, `result.error` contains one of:

| Error | Meaning |
|-------|---------|
| `SkillNotFound` | No skill with that name was discovered |
| `ScriptNotFound` | Script file does not exist in the skill directory |
| `ScriptNotAllowed` | Script is not in the skill's discovered scripts list |
| `InvalidArgs` | `args` was not an array of strings |
| `ExecutionTimeout` | Script exceeded the configured timeout |
| `ExecutionFailed` | Script exited with a non-zero code |

## Security

- **No shell execution** — scripts run via `execFile`, not `exec`. No shell expansion or command injection.
- **Script allowlist** — only scripts discovered during initialization (by extension) can be executed.
- **Path containment** — script names are validated as simple filenames. No `../`, no absolute paths, no traversal.
- **Timeout enforcement** — runaway scripts are killed after the configured timeout.
- **Output caps** — stdout/stderr are capped to prevent context window overflow.
- **Environment isolation** — pass `env` to restrict which environment variables scripts can see.

## Example App

A working chat app using the SDK with streaming:

```bash
cd example
cp .env.example .env     # set your OPENROUTER_API_KEY
node --env-file=.env server.mjs
```

Or from the project root:

```bash
npm run example
```

Open http://localhost:3000. The UI includes a model selector — type any OpenRouter model ID or pick from the dropdown.

## Development

```bash
npm install
npm run build    # compile TypeScript
npm test         # run 45 tests (parser, executor, provider, sdk)
npm run lint     # type-check without emitting
```

## License

MIT
