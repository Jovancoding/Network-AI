#!/usr/bin/env node
/**
 * clawhub-check.js — ClawHub bundle hygiene guard for network-ai
 *
 * Verifies that a `clawhub publish .` from the repo root would bundle ONLY the
 * intended Python-skill files — no draft notes, secrets, logs, TypeScript/npm
 * docs, or Node tooling.
 *
 * ClawHub honours `.clawhubignore` (gitignore-style denylist) — NOT `.clawignore`
 * and NOT `.gitignore`. This script replicates that exclusion against the repo,
 * then asserts the surviving set is exactly the allowlist below. Any extra file
 * is a leak that SkillSpector (NVIDIA, run by ClawHub on every publish) will
 * scan — so we fail BEFORE publishing, not after.
 *
 * Usage:   node scripts/clawhub-check.js   |   npm run clawhub:check
 * Exit:    0 = bundle clean   1 = leak, secret, or missing required file
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Files that SHOULD be in the published ClawHub skill bundle.
const ALLOW_FILES = new Set([
  'SKILL.md',
  'swarm-blackboard.md',
  'requirements.txt',
  'skill.json',
  '.clawhubignore',
  '.clawignore',
  'scripts/blackboard.py',
  'scripts/check_permission.py',
  'scripts/context_manager.py',
  'scripts/revoke_token.py',
  'scripts/swarm_guard.py',
  'scripts/validate_token.py',
]);

// Directories allowed in the bundle (descended into for per-file checks).
const ALLOW_DIRS = new Set(['scripts']);

// Files that MUST be present (and not excluded) for the skill to function.
const REQUIRED = [
  'SKILL.md',
  'swarm-blackboard.md',
  'requirements.txt',
  'scripts/blackboard.py',
  'scripts/check_permission.py',
  'scripts/context_manager.py',
  'scripts/revoke_token.py',
  'scripts/swarm_guard.py',
  'scripts/validate_token.py',
];

// Hard-deny: these must NEVER appear in a bundle, even if mis-allowlisted.
const SECRET_RE = /(^|\/)\.env(\.|$)|\.(log|pem|key|p12|pfx)$/i;

// Directories never walked (and excluded by .clawhubignore anyway).
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', red: '\x1b[31m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

// ── Load .clawhubignore ──────────────────────────────────────────────────────

const ignPath = path.join(ROOT, '.clawhubignore');
if (!fs.existsSync(ignPath)) {
  console.error(`${c.red}.clawhubignore not found — cannot verify bundle.${c.reset}`);
  process.exit(1);
}
const patterns = fs.readFileSync(ignPath, 'utf8')
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'));

/** Convert a simple glob (only `*` is special, no `/`) to an anchored RegExp. */
function globToRe(glob) {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += '[^/]*';
    else re += ch.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/** Mirror .clawhubignore (gitignore-style) exclusion for one repo-relative path. */
function isExcluded(relPath, isDir) {
  const base = relPath.split('/').pop();
  for (const pat of patterns) {
    const dirPat = pat.endsWith('/');
    const core = dirPat ? pat.slice(0, -1) : pat;
    if (core.includes('/')) {
      // Full-path pattern (e.g. "scripts/*.js")
      if (globToRe(core).test(relPath)) return true;
      if (relPath.startsWith(core + '/')) return true;
    } else {
      // Basename pattern (e.g. "*.ts", "comment.txt", "assets/")
      if (core === base || core === relPath) return true;
      if (core.includes('*') && globToRe(core).test(base)) return true;
      if (dirPat && isDir && core === base) return true;
    }
  }
  return false;
}

// ── Walk repo (root depth-1 + allowed subdirs) ───────────────────────────────

const bundle = [];
const leaks = [];

for (const name of fs.readdirSync(ROOT)) {
  if (SKIP_DIRS.has(name)) continue;
  const isDir = fs.statSync(path.join(ROOT, name)).isDirectory();

  if (isExcluded(name, isDir)) continue;

  if (isDir) {
    if (ALLOW_DIRS.has(name)) {
      for (const child of fs.readdirSync(path.join(ROOT, name))) {
        const crel = `${name}/${child}`;
        const cIsDir = fs.statSync(path.join(ROOT, name, child)).isDirectory();
        if (isExcluded(crel, cIsDir)) continue;
        bundle.push(crel);
        if (!ALLOW_FILES.has(crel)) leaks.push(crel);
      }
    } else {
      // A non-allowlisted directory survived exclusion → leak.
      bundle.push(name + '/');
      leaks.push(name + '/  (directory — exclude in .clawhubignore)');
    }
  } else {
    bundle.push(name);
    if (!ALLOW_FILES.has(name)) leaks.push(name);
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

console.log(`\n${c.bold}${c.cyan}ClawHub Bundle Hygiene Check${c.reset}`);
console.log(`${c.gray}${'─'.repeat(50)}${c.reset}`);
console.log(`Would publish ${bundle.length} item(s):`);
const leakSet = new Set(leaks.map(l => l.split('  ')[0]));
for (const b of [...bundle].sort()) {
  const ok = !leakSet.has(b);
  console.log(`  ${ok ? c.green + '✓' + c.reset : c.red + '✗' + c.reset} ${b}`);
}

const secretLeaks = bundle.filter(b => SECRET_RE.test(b));
const missing = REQUIRED.filter(r => !fs.existsSync(path.join(ROOT, r)) || isExcluded(r, false));

console.log(`\n${c.gray}${'─'.repeat(50)}${c.reset}`);
let fail = false;

if (leaks.length) {
  fail = true;
  console.log(`${c.red}${c.bold}LEAK${c.reset} — ${leaks.length} unintended item(s) would be published:`);
  for (const l of leaks) console.log(`  ${c.red}• ${l}${c.reset}`);
  console.log(`  ${c.gray}Add each to .clawhubignore (or to ALLOW_FILES here if genuinely intended).${c.reset}`);
}
if (secretLeaks.length) {
  fail = true;
  console.log(`${c.red}${c.bold}SECRET${c.reset} — secret/log file(s) in bundle: ${secretLeaks.join(', ')}`);
}
if (missing.length) {
  fail = true;
  console.log(`${c.red}${c.bold}MISSING${c.reset} — required skill file(s) absent or excluded: ${missing.join(', ')}`);
}

if (fail) process.exit(1);
console.log(`${c.green}${c.bold}PASS${c.reset} — bundle contains only the intended Python-skill files.`);
process.exit(0);
