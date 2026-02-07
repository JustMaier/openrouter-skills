# Gemini 3 Pro Review

## Summary
The proposal is directionally correct and aligns well with the "Skills" mental model (lazy-loaded context + executable scripts). However, the `use_skill` argument passing mechanism is brittle, and the security model relies too heavily on "trusting the script."

## 1. Two-Tool Approach (load_skill/use_skill)
**Yes, but with a caveat regarding latency.**

- **Pros:** Correct pattern for token efficiency. Mimics the "Retrieval" pattern. Avoids blowing up the context window.
- **Cons:** Forces a multi-turn loop (User -> Agent -> load_skill -> Agent -> use_skill -> Agent). Adds latency and cost.
- **Recommendation:** Keep two-tool as default, but add an **`eager: true`** flag for small skill sets to inject all instructions immediately and save a round-trip.

## 2. SKILL.md Format Gaps

1. **`argument-hint` (Frontmatter):** Agent only sees description initially. Add `arguments: [arg1, arg2]` so system prompt can say: "Discord (requires: message, channel_id)".
2. **`environment` / `secrets` (Frontmatter):** Scripts need tokens. SKILL.md should declare required env vars so the library can validate at startup.
3. **Structured Examples:** LLMs follow few-shot examples better than prose. Allow `examples/` folder or `## Examples` section parsed separately.

## 3. SkillsProvider API Ergonomics
**The `use_skill` signature is the weak point.**

Current `args` is a single string. LLMs are bad at escaping shell strings (nested quotes, JSON payloads). Change to array:

```typescript
args: {
  type: 'array',
  items: { type: 'string' },
  description: 'List of arguments. Do not use quotes for individual items.'
}
```

This maps directly to `child_process.execFile` and bypasses shell interpretation.

## 4. Security Concerns

1. **Environment Variable Leakage:** `child_process` inherits `process.env`. API keys, AWS credentials exposed to every script. Fix: strip `process.env`, only pass explicit allowlist.
2. **Output Flooding:** 10MB stdout will crash the agent's context window. Fix: hard cap on stdout (e.g., 20KB), truncate with `...[output truncated]`.
3. **Dependency Isolation:** Scripts run in host's node environment. If `discord.mjs` imports `discord.js`, it must be in root `node_modules`. Recommend skills be self-contained or use standard libraries only.

## 5. SDK Integration
Return structured objects, not just strings. The SDK and LLM benefit from knowing if a tool "failed" vs "succeeded":

```typescript
const useSkillTool = tool({
  name: 'use_skill',
  execute: async ({ skill, script, args }) => {
    const { stdout, stderr, exitCode } = await executeScript(skill, script, args);
    if (exitCode !== 0) {
      return `Error (Exit Code ${exitCode}): ${stderr || stdout}`;
    }
    return stdout;
  },
});
```

## 6. Claude Code Patterns

- **Adopt: `!` Pre-processing (Dynamic Context).** Allows skills to be context-aware without the model running a get_context script first. Makes load_skill return value dynamic.
- **Avoid: `context: fork` (Sub-agents).** Requires recursive agent loops, complicates state machine. Stick to single linear conversation for V1.
- **Adopt: `allowed-tools`.** Even without a permission system yet, add the field now for future "Safe Mode" where scripts not in allowed-tools require human confirmation.

## Required Changes

1. Change `use_skill` args from `string` to `string[]`
2. Add output truncation to prevent context window overflow
3. Sanitize `process.env` passed to child scripts
4. Add `argument-hint` to SKILL.md frontmatter
5. Return structured errors from tool execution
