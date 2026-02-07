# GPT-5.1 Codex Review

## Summary
The proposal captures the spirit of "skills as tools," but several architectural, API, and safety gaps will limit real-world viability.

## 1. Two-Tool Approach

Good separation of concerns, but needs:

- **Caching + versioning**: Agents may reload same skill across rounds. Provide etag/version in load_skill responses.
- **Batch loading**: `load_skills(skillNames[])` variant for when a task needs multiple skills.
- **Skill metadata retrieval**: No tool for "tell me what fields/options this skill exposes." Either richer metadata in system prompt or a `get_skill_metadata` tool.

## 2. SKILL.md Format Gaps

| Missing Field | Why It Matters | Recommendation |
|---|---|---|
| `argument-hint` | Autocomplete + helps model craft arguments | Add, surface in system prompt |
| `allowed-tools` / `required-tools` | Lets agent know what shell/MCP tools the skill assumes | Adopt same semantics |
| `disable-model-invocation`, `user-invocable` | Helps host control auto-trigger | Include toggles |
| `context` / `agent` / `model` overrides | Lets skills force subagents or model switches | Plan for parity |
| `hooks` or pre/post scripts | Many skills need pre-processing | Support `!command` substitutions |
| Script manifest | Without metadata, agents guess paths. Add optional `scripts:` section listing names + descriptions |

## 3. SkillsProvider API Ergonomics

- **`systemPrompt` as pre-rendered string is limiting.** Provide structured object `{ heading, skills: [{ name, description, tags }] }` so callers can format/trim.
- **Type mismatch:** `def.function.name` doesn't exist in Responses API format. Need adapters for both Responses (flat) and Chat Completions (nested `function`).
- **`handleToolCall` returning string pushes serialization onto caller.** Provide helpers:
  - `executeLoadSkill(args) -> { content, version }`
  - `executeUseSkill(args) -> { stdout, stderr, exitCode, durationMs }`
  - `maybeHandleToolCall(toolCall) -> { handled: boolean, result }`
- **Missing watcher/reload story.** Real projects add/remove skills while server runs.
- **Need error taxonomy.** Differentiate `SkillNotFound`, `ScriptMissing`, `ExecutionTimeout` so agent can recover.

## 4. Security Concerns

- **Environment leakage**: Full process.env inherited. Provide per-skill env whitelists.
- **Resource exhaustion**: Limits on stdout/stderr size, CPU, memory. Cap output size.
- **Path traversal via args**: Accept `args: string[]` to avoid shell parsing.
- **Concurrency control**: Multiple simultaneous use_skill calls might stomp shared files. Per-skill mutex or queue.
- **Logging / audit**: No mention of logging invocations. Need structured logs for forensics.
- **Secrets in SKILL.md**: Provide substitution or secret references rather than inlining tokens in prompts.

## 5. SDK Integration

- Return `tool()` instances directly so consumers plug into `callModel`:
  ```ts
  const skills = await createSkillsProvider();
  const result = await openrouter.callModel({
    model,
    input,
    instructions: `${basePrompt}\n\n${skills.promptSection}`,
    tools: [...otherTools, ...skills.sdkTools],
  });
  ```
- Provide `skills.getChatCompletionTools()` helper for `chat.send()` users.
- Expose both `responsesTools` and `sdkTools` adapters.

## 6. Claude Code Patterns

**Adopt:**
- Multi-level skill directories (user-level, project-level) for overrides
- Instruction budgets (limit system prompt text, top N skills by priority)
- Preprocessors (`!command`) and substitution variables
- Allowed tool hints and permission gating

**Avoid / Clarify:**
- Claude ties skills to Bash; this proposal is JS-first. Either embrace "any language via Bash" or explicitly scope v1 to Node.
- `context: fork` -- skip for v1, document as out of scope
- Skill discovery budget -- provide truncation strategies (top K by priority)

**Key point:** Either aim for Claude SKILL.md compatibility or state the divergences. Half-aligned format will confuse users.

## Missed Opportunities

1. **Skill dependency graph**: `depends_on` field, auto-load dependent descriptions
2. **Script capability metadata**: Expose script names + descriptions via metadata
3. **Testing harness**: CLI to run `use_skill` manually (`npx openrouter-skills run discord send ...`)
4. **Streaming script output**: Long-running scripts benefit from streaming logs
5. **Skill packaging**: `skills.json` manifest or npm package loading for reuse
