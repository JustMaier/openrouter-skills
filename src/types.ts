// --- Skill Definition ---

/** Parsed content of a SKILL.md file */
export interface SkillDefinition {
  /** Skill name (from frontmatter or folder name) */
  name: string;
  /** Description for system prompt (from frontmatter) */
  description: string;
  /** Full markdown content below frontmatter */
  content: string;
  /** Absolute path to the skill directory */
  dirPath: string;
  /** List of script filenames found in the skill directory */
  scripts: string[];
}

// --- Execution ---

/** Result from executing a skill script */
export interface SkillExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set on failure: SkillNotFound, ScriptNotFound, ScriptNotAllowed, ExecutionTimeout, ExecutionFailed */
  error?: string;
}

/** Error types for structured error reporting */
export type SkillErrorType =
  | 'SkillNotFound'
  | 'ScriptNotFound'
  | 'ScriptNotAllowed'
  | 'ExecutionTimeout'
  | 'ExecutionFailed';

// --- Tool Definitions (Responses API format) ---

/** OpenRouter Responses API tool definition (flat, no function wrapper) */
export interface ResponsesToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
}

/** JSON Schema property for tool parameters */
export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string };
}

/** OpenRouter Chat Completions tool definition (nested function wrapper) */
export interface ChatCompletionsToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, JsonSchemaProperty>;
      required?: string[];
    };
  };
}

// --- Provider ---

/** Options for createSkillsProvider */
export interface SkillsProviderOptions {
  /** Only load these skills (by folder name) */
  include?: string[];
  /** Skip these skills (by folder name) */
  exclude?: string[];
  /** Script execution timeout in ms (default 30000) */
  timeout?: number;
  /** Max bytes per stdout/stderr (default 20480 = 20KB) */
  maxOutput?: number;
  /** Working directory for script execution (default process.cwd()) */
  cwd?: string;
}

/** The main interface returned by createSkillsProvider */
export interface SkillsProvider {
  /** System prompt section listing all discovered skills */
  systemPrompt: string;

  /** Tool definitions in Responses API format (flat) */
  tools: ResponsesToolDefinition[];

  /** Tool definitions in Chat Completions format (nested function) */
  chatCompletionsTools: ChatCompletionsToolDefinition[];

  /**
   * Handle a tool call from the agent.
   * For load_skill: returns the skill's markdown content (string).
   * For use_skill: returns a SkillExecutionResult.
   */
  handleToolCall(name: string, args: Record<string, unknown>): Promise<SkillExecutionResult | string>;

  /** List of discovered skill names */
  skillNames: string[];

  /** Map of skill name to full definition (for advanced use) */
  skills: Map<string, SkillDefinition>;
}
