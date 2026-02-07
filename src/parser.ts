import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SkillDefinition } from './types.js';

const SKILL_FILENAME = 'SKILL.md';
const SCRIPT_EXTENSIONS = new Set(['.mjs', '.js', '.sh', '.ts']);

/**
 * Parse simple YAML frontmatter from raw text.
 * Handles `key: value` lines only (no nested objects, arrays, etc.).
 * Values may be optionally quoted with single or double quotes.
 */
function parseFrontmatter(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    let value = trimmed.slice(colonIndex + 1).trim();
    // Strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Extract the first paragraph from markdown content.
 * Skips blank lines and headings, returns the first non-empty,
 * non-heading line (or block of lines) as a single string.
 */
function firstParagraph(markdown: string): string {
  const lines = markdown.split('\n');
  const paragraphLines: string[] = [];
  let started = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      // Skip blank lines and headings before the first paragraph
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      started = true;
      paragraphLines.push(trimmed);
    } else {
      // Stop at the first blank line or heading after starting
      if (trimmed === '' || trimmed.startsWith('#')) break;
      paragraphLines.push(trimmed);
    }
  }

  return paragraphLines.join(' ');
}

/**
 * Parse a SKILL.md file, extracting frontmatter metadata and body content.
 *
 * @param filePath - Absolute path to a SKILL.md file
 * @returns Parsed name, description, and markdown content below frontmatter
 */
export async function parseSkillFile(
  filePath: string,
): Promise<{ name: string; description: string; content: string }> {
  const raw = await readFile(filePath, 'utf-8');

  let name = '';
  let description = '';
  let content = raw;

  // Check for YAML frontmatter delimited by --- on its own line
  if (raw.startsWith('---')) {
    const endIndex = raw.indexOf('\n---', 3);
    if (endIndex !== -1) {
      const frontmatterRaw = raw.slice(3, endIndex);
      const meta = parseFrontmatter(frontmatterRaw);
      name = meta['name'] ?? '';
      description = meta['description'] ?? '';

      // Content is everything after the closing --- line
      // Skip past the closing "---" and the newline that follows it
      const afterClosing = endIndex + 4; // length of "\n---"
      content = raw.slice(afterClosing).replace(/^\r?\n/, '');
    }
  }

  // Fall back: if no description from frontmatter, use first paragraph
  if (!description) {
    description = firstParagraph(content);
  }

  return { name, description, content };
}

/**
 * Collect script filenames from a directory (non-recursive).
 * Returns only files whose extensions are in SCRIPT_EXTENSIONS.
 */
async function collectScripts(dir: string): Promise<string[]> {
  const scripts: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return scripts;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = entry.name.slice(entry.name.lastIndexOf('.'));
    if (SCRIPT_EXTENSIONS.has(ext)) {
      scripts.push(entry.name);
    }
  }
  return scripts;
}

/**
 * Discover all skills in a directory.
 *
 * Each skill is a subdirectory of `skillsDir` that contains a SKILL.md file.
 * Scripts are collected from the skill folder itself and an optional `scripts/`
 * subfolder.
 *
 * @param skillsDir - Absolute path to the skills root directory
 * @param options - Optional include/exclude filters (matched against folder name)
 * @returns Array of SkillDefinition objects with absolute paths
 */
export async function discoverSkills(
  skillsDir: string,
  options?: { include?: string[]; exclude?: string[] },
): Promise<SkillDefinition[]> {
  const resolvedDir = resolve(skillsDir);

  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(resolvedDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillDefinition[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const folderName = entry.name;

    // Apply include filter
    if (options?.include && options.include.length > 0) {
      if (!options.include.includes(folderName)) continue;
    }

    // Apply exclude filter
    if (options?.exclude && options.exclude.includes(folderName)) {
      continue;
    }

    const skillDir = join(resolvedDir, folderName);
    const skillFilePath = join(skillDir, SKILL_FILENAME);

    // Check that SKILL.md exists
    try {
      const fileStat = await stat(skillFilePath);
      if (!fileStat.isFile()) continue;
    } catch {
      continue;
    }

    // Parse the SKILL.md
    const parsed = await parseSkillFile(skillFilePath);

    // Collect scripts from the skill directory and scripts/ subfolder
    const topScripts = await collectScripts(skillDir);
    const scriptsSubdir = join(skillDir, 'scripts');
    const subScripts = await collectScripts(scriptsSubdir);

    // Prefix subfolder scripts with "scripts/" so callers know the relative path
    const allScripts = [
      ...topScripts,
      ...subScripts.map((s) => `scripts/${s}`),
    ];

    skills.push({
      name: parsed.name || folderName,
      description: parsed.description,
      content: parsed.content,
      dirPath: skillDir,
      scripts: allScripts,
    });
  }

  return skills;
}
