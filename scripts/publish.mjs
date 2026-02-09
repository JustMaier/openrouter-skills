#!/usr/bin/env node

/**
 * Bump version, build, test, commit, tag, and publish to NPM.
 *
 * Usage:
 *   node scripts/publish.mjs patch    # 0.1.0 → 0.1.1
 *   node scripts/publish.mjs minor    # 0.1.0 → 0.2.0
 *   node scripts/publish.mjs major    # 0.1.0 → 1.0.0
 *   node scripts/publish.mjs 0.3.0    # explicit version
 *
 *   --dry-run    Skip the actual npm publish and git push
 *   --no-push    Publish to NPM but don't push to git remote
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pkgPath = join(root, 'package.json');

// --- Parse args ---

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');
const noPush = flags.has('--no-push');
const bump = positional[0];

if (!bump) {
  console.error('Usage: node scripts/publish.mjs <patch|minor|major|x.y.z> [--dry-run] [--no-push]');
  process.exit(1);
}

// --- Helpers ---

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { cwd: root, stdio: 'inherit', ...opts });
}

function runCapture(cmd) {
  return execSync(cmd, { cwd: root, encoding: 'utf-8' }).trim();
}

function bumpVersion(current, bump) {
  if (/^\d+\.\d+\.\d+/.test(bump)) return bump;

  const [major, minor, patch] = current.split('.').map(Number);
  switch (bump) {
    case 'patch': return `${major}.${minor}.${patch + 1}`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'major': return `${major + 1}.0.0`;
    default:
      console.error(`Invalid bump: "${bump}". Use patch, minor, major, or x.y.z`);
      process.exit(1);
  }
}

// --- Preflight checks ---

console.log('\n--- Preflight checks ---\n');

// Clean working tree (staged or unstaged changes would be problematic)
const status = runCapture('git status --porcelain');
if (status) {
  console.error('Working tree is not clean. Commit or stash changes first.\n');
  console.error(status);
  process.exit(1);
}

// Make sure we're on main
const branch = runCapture('git branch --show-current');
if (branch !== 'main') {
  console.error(`On branch "${branch}" — switch to main before publishing.`);
  process.exit(1);
}

// Check npm auth
try {
  runCapture('npm whoami');
} catch {
  console.error('Not logged in to npm. Run `npm login` first.');
  process.exit(1);
}

// --- Compute new version ---

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const oldVersion = pkg.version;
const newVersion = bumpVersion(oldVersion, bump);

console.log(`\n--- Version: ${oldVersion} → ${newVersion} ---\n`);

// --- Build & test ---

console.log('--- Build ---\n');
run('npx tsc');

console.log('\n--- Test ---\n');
run('npx tsx --test src/**/*.test.ts');

// --- Bump version in package.json ---

console.log('\n--- Bump package.json ---\n');
pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`  Updated package.json to ${newVersion}`);

// --- Commit, tag, publish ---

console.log('\n--- Git commit & tag ---\n');
run('git add package.json');
run(`git commit -m "v${newVersion}"`);
run(`git tag v${newVersion}`);

if (dryRun) {
  console.log('\n--- Dry run: skipping npm publish and git push ---\n');
  console.log(`  Would publish openrouter-skills@${newVersion}`);
  console.log('  Would push commit + tag to origin');
} else {
  console.log('\n--- Publish to NPM ---\n');
  run('npm publish --access public');

  if (!noPush) {
    console.log('\n--- Push to origin ---\n');
    run('git push && git push --tags');
  }
}

console.log(`\n--- Done: openrouter-skills@${newVersion} ---\n`);
