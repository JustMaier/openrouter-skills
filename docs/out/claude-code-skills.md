# Claude Code Skills System

## What Skills Are

Skills are markdown files that inject instructions and context into Claude's prompt. They teach Claude *how* to do things -- coding conventions, analysis frameworks, step-by-step processes -- as opposed to MCP tools, which give Claude *access* to external systems.

## Directory Structure

Skills live at three levels, with higher levels taking priority:

```
~/.claude/skills/<name>/SKILL.md          # personal (user-level)
.claude/skills/<name>/SKILL.md            # project-level
<plugin>/skills/<name>/SKILL.md           # plugin-level
```

A skill folder contains:

```
discord/
  SKILL.md              # required: frontmatter + instructions
  scripts/
    discord.mjs         # scripts Claude can call
    validate.sh
  templates/
    message.md          # optional templates
  examples/
    sample.md           # optional reference examples
```

## SKILL.md Format

Every SKILL.md has YAML frontmatter and markdown content:

```yaml
---
name: deploy
description: Deploy to production. Use when the user says "deploy" or "ship it".
argument-hint: [environment]
allowed-tools: Bash(git *), Bash(npm *)
disable-model-invocation: false
user-invocable: true
---

Deploy $ARGUMENTS to production:

1. Run tests: `npm test`
2. Build: `npm run build`
3. Push to deploy branch
```

### Frontmatter Fields

| Field | Type | Purpose |
|-------|------|---------|
| `name` | string | Slash command name. Lowercase, hyphens. Max 64 chars. Defaults to folder name |
| `description` | string | What it does and when to use it. Claude reads this to decide when to load the skill |
| `argument-hint` | string | Shown in autocomplete, e.g. `[issue-number]` |
| `allowed-tools` | string | Comma-separated tools Claude can use without permission prompts |
| `disable-model-invocation` | bool | If true, only the user can invoke (not Claude automatically) |
| `user-invocable` | bool | If false, hidden from `/` menu. Only Claude can invoke it |
| `context` | string | Set to `fork` to run in an isolated subagent |
| `agent` | string | Subagent type when `context: fork`. Options: `Explore`, `Plan`, etc. |
| `model` | string | Model override for this skill |
| `hooks` | object | Lifecycle hooks scoped to this skill |

## How Skills Load

1. **At session start**: Claude receives a summary of all skill descriptions (not full content). This fits within a character budget (2% of context window, ~16KB default).

2. **On invocation**: When Claude decides a skill is relevant (or the user types `/skill-name`), the full SKILL.md content loads into context.

3. **Preprocessing**: Any `!`command`` syntax executes before Claude sees the content. The output replaces the placeholder:

```yaml
---
name: pr-summary
description: Summarize the current PR
---
PR diff:
!`gh pr diff`

Summarize the changes above.
```

Claude receives the actual diff output, not the command.

## String Substitutions

| Variable | Replaced With |
|----------|---------------|
| `$ARGUMENTS` | All arguments passed to the skill |
| `$ARGUMENTS[0]`, `$1` | First argument |
| `$ARGUMENTS[1]`, `$2` | Second argument |
| `${CLAUDE_SESSION_ID}` | Current session ID |

## Invocation Lifecycle

1. Session starts. Skill descriptions enter context.
2. User says something (or types `/skill-name args`).
3. Claude matches a skill by description (or direct invocation).
4. `!`command`` preprocessors execute. String substitutions apply.
5. Full skill content injects into conversation.
6. `allowed-tools` grant permission without prompts.
7. Claude follows the instructions. If scripts are referenced, Claude calls them via Bash.
8. Hooks fire at tool boundaries (`PreToolUse`, `PostToolUse`).
9. Skill completes. For `context: fork` skills, the subagent returns a summary.

## Script Conventions

Scripts live in the skill folder and are called via Bash. Any language works:

```bash
# From SKILL.md instructions:
Run `node ./scripts/discord.mjs send "Hello" --channel=general` to send the message.
```

Claude reads the instruction and executes it. Scripts receive arguments as CLI args. Environment variables available: `$CLAUDE_PROJECT_DIR`, `${CLAUDE_PLUGIN_ROOT}`.

## Skills vs. MCP Tools

| | Skills | MCP Tools |
|---|--------|-----------|
| Purpose | Inject instructions into prompt | Provide external tool access |
| Format | Markdown files in `.claude/` | Separate servers (HTTP, stdio) |
| Discovery | Description text in context | Tool definitions preloaded |
| Execution | Content injected, Claude follows instructions | Claude calls tool interface directly |
| State | Scoped to invocation | Persistent server connection |
| Latency | Instant (local files) | Network round-trip |

Skills teach Claude techniques. MCP tools give Claude capabilities. They compose well together.
