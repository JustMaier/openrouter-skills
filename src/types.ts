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
  /** Set on failure: SkillNotFound, ScriptNotFound, ScriptNotAllowed, InvalidArgs, ExecutionTimeout, ExecutionFailed */
  error?: string;
}

/** Error types for structured error reporting */
export type SkillErrorType =
  | 'SkillNotFound'
  | 'ScriptNotFound'
  | 'ScriptNotAllowed'
  | 'InvalidArgs'
  | 'ExecutionTimeout'
  | 'ExecutionFailed';

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
  /** Environment variables for script execution. If set, scripts see only these vars (plus PATH). */
  env?: Record<string, string>;
}

/** The main interface returned by createSkillsProvider */
export interface SkillsProvider {
  /**
   * Handle a tool call from the agent.
   * Returns a SkillExecutionResult for both load_skill and use_skill.
   * For load_skill, the skill content is in stdout.
   */
  handleToolCall(name: string, args: Record<string, unknown>): Promise<SkillExecutionResult>;

  /** List of discovered skill names */
  skillNames: string[];

  /** Map of skill name to full definition (for advanced use) */
  skills: Map<string, SkillDefinition>;
}
