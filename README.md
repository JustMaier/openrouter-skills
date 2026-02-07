# openrouter-skills

Give OpenRouter-powered agents skills through directory-based `SKILL.md` files and executable scripts.

The agent sees skill summaries in its system prompt, loads full instructions on demand, and executes skill scripts — all through standard OpenRouter tool calling.

## Install

```bash
npm install openrouter-skills
```

## Quick Start

```typescript
import { createSkillsProvider } from 'openrouter-skills';

const skills = await createSkillsProvider('./skills');

// Inject into your system prompt
const systemPrompt = `You are a helpful assistant.\n\n${skills.systemPrompt}`;

// Add skill tools alongside your own
const allTools = [...myTools, ...skills.chatCompletionsTools];

// Handle tool calls in your agentic loop
async function handleToolCall(name, args) {
  if (skills.isSkillToolCall(name)) {
    return await skills.handleToolCall(name, args);
  }
  // ...your other tools
}
```

## How It Works

1. **Discovery** — scans a directory for subdirectories containing `SKILL.md` files
2. **System prompt** — generates a summary listing each skill's name and description
3. **Two tools** — registers `load_skill` (read instructions) and `use_skill` (run scripts)
4. **Agentic loop** — the agent loads a skill, reads its instructions, then calls scripts as directed

```
User: "Send Hello World to #dev on Discord"

Agent → load_skill({ skill: "discord" })        # reads SKILL.md
Agent → use_skill(discord, discord.mjs, ["channels", "list"])  # gets channel IDs
Agent → use_skill(discord, discord.mjs, ["send", "Hello World", "--channel=1002"])
Agent → "Done. Sent 'Hello World' to #dev."
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

The `description` appears in the agent's system prompt. The markdown body is returned when the agent calls `load_skill`.

## API

### `createSkillsProvider(skillsDir, options?)`

Returns a `SkillsProvider` with everything needed to wire skills into an OpenRouter agent.

```typescript
const skills = await createSkillsProvider('./skills', {
  include: ['discord'],    // only load these skills
  exclude: ['internal'],   // skip these skills
  timeout: 30000,          // script timeout in ms (default 30s)
  maxOutput: 20480,        // max stdout/stderr bytes (default 20KB)
  cwd: process.cwd(),      // working directory for scripts
});
```

**Returns:**

| Property | Type | Description |
|----------|------|-------------|
| `systemPrompt` | `string` | Inject into your system message |
| `tools` | `ResponsesToolDefinition[]` | Responses API format (flat) |
| `chatCompletionsTools` | `ChatCompletionsToolDefinition[]` | Chat Completions format (nested) |
| `isSkillToolCall(name)` | `function` | Check if a tool call belongs to this provider |
| `handleToolCall(name, args)` | `async function` | Execute `load_skill` or `use_skill` |
| `skillNames` | `string[]` | Discovered skill names |
| `skills` | `Map<string, SkillDefinition>` | Full skill definitions |

## Security

- **No shell execution** — scripts run via `execFile`, not `exec`. No shell expansion or command injection.
- **Path containment** — script names are validated as simple filenames. No `../`, no absolute paths, no traversal.
- **Timeout enforcement** — runaway scripts are killed after the configured timeout.
- **Output caps** — stdout/stderr are capped to prevent context window overflow.

## Example App

A working chat app that wires the library to OpenRouter with streaming:

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
npm test         # run 43 tests (parser, executor, prompt, provider)
npm run lint     # type-check without emitting
```

## License

MIT
