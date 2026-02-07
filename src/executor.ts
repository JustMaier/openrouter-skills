import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import type { SkillExecutionResult } from './types.js';

/** Options for executeScript */
export interface ExecuteScriptOptions {
  /** Absolute path to the skill folder */
  skillDir: string;
  /** Script filename (e.g. "discord.mjs") */
  script: string;
  /** Arguments array passed to the script */
  args?: string[];
  /** Execution timeout in ms (default 30000) */
  timeout?: number;
  /** Max bytes for stdout/stderr (default 20480 = 20KB) */
  maxOutput?: number;
  /** Working directory for the child process (default skillDir) */
  cwd?: string;
  /** Environment variables for the child process. If set, replaces process.env. */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_OUTPUT = 20_480;

/**
 * Truncate a string to a byte-length limit.
 * If truncated, appends "\n[output truncated]".
 */
function capOutput(output: string, maxBytes: number): string {
  const buf = Buffer.from(output, 'utf-8');
  if (buf.length <= maxBytes) {
    return output;
  }
  // Truncate at byte boundary, then decode back to string (may lose partial char)
  const truncated = buf.subarray(0, maxBytes).toString('utf-8');
  return truncated + '\n[output truncated]';
}

/**
 * Validate that a script name is a simple filename with no path traversal.
 * Returns true if the name is safe, false otherwise.
 */
function isSimpleFilename(script: string): boolean {
  // Must not be empty
  if (!script || script.trim().length === 0) {
    return false;
  }

  // Must not contain path separators or traversal sequences
  if (script.includes('..') || script.includes('/') || script.includes('\\')) {
    return false;
  }

  // Must not be an absolute path (Windows or Unix)
  if (path.isAbsolute(script)) {
    return false;
  }

  return true;
}

/**
 * Determine the command and arguments for executing a script based on its extension.
 */
function resolveCommand(
  scriptPath: string,
  args: string[]
): { command: string; execArgs: string[] } {
  const ext = path.extname(scriptPath).toLowerCase();

  switch (ext) {
    case '.mjs':
    case '.js':
      return { command: 'node', execArgs: [scriptPath, ...args] };
    case '.sh':
      return { command: 'bash', execArgs: [scriptPath, ...args] };
    default:
      // For unknown extensions, attempt direct execution
      return { command: scriptPath, execArgs: args };
  }
}

/**
 * Check if a file exists and is accessible.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a script inside a skill directory with strict containment.
 *
 * Security measures:
 * - Path traversal prevention (no `..`, `/`, `\` in script name)
 * - Containment validation (resolved path must be within skillDir)
 * - No shell execution (uses execFile, not exec)
 * - Output capping to prevent memory exhaustion
 * - Timeout enforcement
 */
export async function executeScript(
  options: ExecuteScriptOptions
): Promise<SkillExecutionResult> {
  const {
    skillDir,
    script,
    args = [],
    timeout = DEFAULT_TIMEOUT,
    maxOutput = DEFAULT_MAX_OUTPUT,
    cwd,
    env,
  } = options;

  // --- Security: validate script name ---
  if (!isSimpleFilename(script)) {
    return {
      success: false,
      stdout: '',
      stderr: '',
      exitCode: -1,
      error: 'ScriptNotAllowed',
    };
  }

  // --- Resolve script path ---
  // Check skill root first, then scripts/ subfolder
  const resolvedSkillDir = path.resolve(skillDir);
  const candidateRoot = path.resolve(resolvedSkillDir, script);
  const candidateScripts = path.resolve(resolvedSkillDir, 'scripts', script);

  let scriptPath: string | null = null;

  if (await fileExists(candidateRoot)) {
    scriptPath = candidateRoot;
  } else if (await fileExists(candidateScripts)) {
    scriptPath = candidateScripts;
  }

  if (scriptPath === null) {
    return {
      success: false,
      stdout: '',
      stderr: '',
      exitCode: -1,
      error: 'ScriptNotFound',
    };
  }

  // --- Security: containment validation ---
  // The resolved script path must start with the skill directory
  const normalizedSkillDir = resolvedSkillDir + path.sep;
  if (
    scriptPath !== resolvedSkillDir &&
    !scriptPath.startsWith(normalizedSkillDir)
  ) {
    return {
      success: false,
      stdout: '',
      stderr: '',
      exitCode: -1,
      error: 'ScriptNotAllowed',
    };
  }

  // --- Build command ---
  const { command, execArgs } = resolveCommand(scriptPath, args);

  // --- Execute ---
  return new Promise<SkillExecutionResult>((resolve) => {
    const child = execFile(
      command,
      execArgs,
      {
        cwd: cwd ?? skillDir,
        timeout,
        maxBuffer: maxOutput * 2, // Give some headroom; we cap manually
        windowsHide: true,
        ...(env !== undefined && { env }),
      },
      (error, stdout, stderr) => {
        const cappedStdout = capOutput(stdout ?? '', maxOutput);
        const cappedStderr = capOutput(stderr ?? '', maxOutput);

        if (error) {
          // Timeout detection: Node sets error.killed when the process
          // is killed due to timeout, and error.code is 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          // or error.signal is 'SIGTERM'. The most reliable check is error.killed + signal.
          if (error.killed || (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
            resolve({
              success: false,
              stdout: '',
              stderr: '',
              exitCode: -1,
              error: 'ExecutionTimeout',
            });
            return;
          }

          // Non-zero exit code or other execution failure
          const exitCode = child.exitCode ?? (error as unknown as { status?: number }).status ?? -1;
          resolve({
            success: false,
            stdout: cappedStdout,
            stderr: cappedStderr,
            exitCode: typeof exitCode === 'number' ? exitCode : -1,
            error: 'ExecutionFailed',
          });
          return;
        }

        // Success
        resolve({
          success: true,
          stdout: cappedStdout,
          stderr: cappedStderr,
          exitCode: 0,
        });
      }
    );
  });
}
