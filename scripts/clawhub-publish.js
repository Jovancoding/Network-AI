#!/usr/bin/env node
/**
 * clawhub-publish.js — ClawHub skill publisher for network-ai
 *
 * ClawHub CLI v0.23+ detects package.json in the repo root and refuses
 * `clawhub skill publish .` ("This looks like a plugin"). This script works
 * around that by staging the 12 bundle files into a temp directory (no
 * package.json) and publishing from there.
 *
 * Usage:   node scripts/clawhub-publish.js [--dry-run] [--changelog "text"]
 *          npm run clawhub:publish
 *          npm run clawhub:publish -- --dry-run
 *          npm run clawhub:publish -- --changelog "my changelog text"
 *
 * The version, slug, and name are read from skill.json automatically.
 * Source provenance (repo / commit / ref) is read from git automatically.
 * Exit: 0 = published   1 = error
 */

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// ── Files to stage (must match clawhub-check.js ALLOW_FILES) ─────────────────
const STAGE_FILES = [
  '.clawhubignore',
  '.clawignore',
  'SKILL.md',
  'requirements.txt',
  'skill.json',
  'swarm-blackboard.md',
  'scripts/blackboard.py',
  'scripts/check_permission.py',
  'scripts/context_manager.py',
  'scripts/revoke_token.py',
  'scripts/swarm_guard.py',
  'scripts/validate_token.py',
];

const SKILL_NAME = 'Network-AI';
const SKILL_SLUG = 'network-ai';

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', red: '\x1b[31m',
  green: '\x1b[32m', cyan: '\x1b[36m', gray: '\x1b[90m',
};

// ── Parse CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun   = args.includes('--dry-run');
const clIdx    = args.indexOf('--changelog');
const changelog = clIdx !== -1 ? args[clIdx + 1] : undefined;

// ── Read version from skill.json ──────────────────────────────────────────────
const skillJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'skill.json'), 'utf8'));
const version   = skillJson.version;
if (!version) { console.error(`${c.red}skill.json missing "version"${c.reset}`); process.exit(1); }

// ── Read git provenance ───────────────────────────────────────────────────────
function git(cmd) {
  try { return execSync(`git -C "${ROOT}" ${cmd}`, { stdio: ['pipe','pipe','pipe'] }).toString().trim(); }
  catch { return undefined; }
}
const sourceCommit = git('rev-parse --short HEAD');
const sourceRef    = git('describe --tags --exact-match HEAD') ? `refs/tags/${git('describe --tags --exact-match HEAD')}` : git('rev-parse --abbrev-ref HEAD');
const remoteUrl    = git('remote get-url origin') || '';
const repoMatch    = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
const sourceRepo   = repoMatch ? repoMatch[1] : undefined;

// ── Create staging directory ──────────────────────────────────────────────────
const stage = path.join(os.tmpdir(), 'network-ai-skill-publish');
if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true });
fs.mkdirSync(stage);
fs.mkdirSync(path.join(stage, 'scripts'));

for (const rel of STAGE_FILES) {
  const src = path.join(ROOT, rel);
  const dst = path.join(stage, rel);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  } else {
    console.warn(`${c.gray}  skipped (not found): ${rel}${c.reset}`);
  }
}

// ── Build clawhub command ─────────────────────────────────────────────────────
// NOTE: spawnSync(..., { shell: true }) does NOT auto-quote array elements —
// any argument containing a space is split into multiple shell tokens by
// cmd.exe, which the clawhub CLI then rejects as extra positional arguments.
// quoteArg() wraps any element that needs it so it survives the shell hop.
function quoteArg(arg) {
  const str = String(arg);
  if (str === '' || /[\s"()&|<>^]/.test(str)) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return str;
}

const cmd = ['clawhub', 'skill', 'publish', stage,
  '--slug',    SKILL_SLUG,
  '--name',    SKILL_NAME,
  '--version', version,
  '--tags',    'latest',
];
if (changelog)    cmd.push('--changelog',      changelog);
if (sourceRepo)   cmd.push('--source-repo',    sourceRepo);
if (sourceCommit) cmd.push('--source-commit',  sourceCommit);
if (sourceRef)    cmd.push('--source-ref',     sourceRef);
if (dryRun)       cmd.push('--dry-run');

console.log(`\n${c.bold}ClawHub Skill Publish${c.reset}`);
console.log(`${'─'.repeat(50)}`);
console.log(`  Skill  : ${SKILL_NAME}  (${SKILL_SLUG})`);
console.log(`  Version: ${version}${dryRun ? '  [dry-run]' : ''}`);
console.log(`  Commit : ${sourceCommit || '(unknown)'}`);
console.log(`  Ref    : ${sourceRef    || '(unknown)'}`);
console.log(`  Staged : ${STAGE_FILES.length} files → ${stage}`);
console.log(`${'─'.repeat(50)}\n`);

// ── Publish ───────────────────────────────────────────────────────────────────
const quotedCmd = process.platform === 'win32' ? cmd.map(quoteArg) : cmd;
const result = spawnSync('npx', quotedCmd, { cwd: ROOT, stdio: 'inherit', shell: true });

// ── Cleanup ───────────────────────────────────────────────────────────────────
fs.rmSync(stage, { recursive: true });

if (result.status !== 0) {
  console.error(`\n${c.red}✖ publish failed (exit ${result.status})${c.reset}`);
  process.exit(result.status ?? 1);
}
console.log(`\n${c.green}✔ Published ${SKILL_SLUG}@${version}${c.reset}\n`);
