#!/usr/bin/env node
/**
 * codeql-check.js — GitHub CodeQL alert monitor for network-ai
 *
 * Fetches open Code Scanning alerts via the GitHub API and categorises them
 * by severity. Exits 1 if any blocking (error / warning) alerts are open.
 * Note-level alerts are reported but do not fail the check.
 *
 * Usage:
 *   node scripts/codeql-check.js
 *   npm run codeql:check
 *
 * Requires: gh CLI authenticated (gh auth login)
 *
 * Exit codes:
 *   0 — no blocking (error/warning) alerts open
 *   1 — one or more blocking alerts open, or API call failed
 */

'use strict';

const { spawnSync } = require('child_process');

const REPO = 'Jovancoding/Network-AI';

// Severity levels that must be zero before publishing
const BLOCKING_SEVERITIES = new Set(['error', 'warning']);

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};

console.log(`\n${c.bold}${c.cyan}CodeQL Alert Check${c.reset}`);
console.log(`${c.gray}${'─'.repeat(50)}${c.reset}`);
console.log(`${c.gray}Repo: ${REPO}${c.reset}\n`);

// ── Fetch open alerts via GitHub CLI ────────────────────────────────────────

const result = spawnSync(
  'gh',
  ['api', `repos/${REPO}/code-scanning/alerts?state=open&per_page=100`],
  { encoding: 'utf8', shell: false }
);

if (result.error) {
  console.error(`${c.red}gh CLI not found or not authenticated.${c.reset}`);
  console.error('Run: gh auth login');
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`${c.red}GitHub API call failed (exit ${result.status}).${c.reset}`);
  console.error(result.stderr || '(no stderr)');
  process.exit(1);
}

let alerts;
try {
  alerts = JSON.parse(result.stdout);
} catch {
  console.error(`${c.red}Failed to parse API response.${c.reset}`);
  console.error(result.stdout.slice(0, 200));
  process.exit(1);
}

if (!Array.isArray(alerts)) {
  // GitHub returns {"message":"..."} for auth errors
  const msg = alerts && alerts.message ? alerts.message : JSON.stringify(alerts).slice(0, 100);
  console.error(`${c.red}Unexpected API response: ${msg}${c.reset}`);
  process.exit(1);
}

// ── Categorise ───────────────────────────────────────────────────────────────

const blocking      = [];
const informational = [];

for (const alert of alerts) {
  const sev  = (alert.rule && alert.rule.severity) || 'unknown';
  const item = {
    number:   alert.number,
    rule:     (alert.rule && alert.rule.id)   || '?',
    desc:     (alert.rule && alert.rule.description) || '',
    severity: sev,
    file:     (alert.most_recent_instance && alert.most_recent_instance.location &&
               alert.most_recent_instance.location.path) || '?',
    line:     (alert.most_recent_instance && alert.most_recent_instance.location &&
               alert.most_recent_instance.location.start_line) || '?',
  };
  if (BLOCKING_SEVERITIES.has(sev)) {
    blocking.push(item);
  } else {
    informational.push(item);
  }
}

// ── Display ──────────────────────────────────────────────────────────────────

console.log(`Open alerts: ${alerts.length}  (blocking: ${blocking.length}, note: ${informational.length})`);

if (informational.length > 0) {
  console.log(`\n${c.gray}Informational (note — does not fail the check):${c.reset}`);
  for (const a of informational) {
    console.log(`  ${c.gray}#${a.number} [${a.severity}] ${a.rule} — ${a.file}:${a.line}${c.reset}`);
    if (a.desc) console.log(`    ${c.gray}${a.desc}${c.reset}`);
  }
}

if (blocking.length > 0) {
  console.log(`\n${c.bold}${c.yellow}Blocking alerts (must be zero before publishing):${c.reset}`);
  for (const a of blocking) {
    console.log(`  ${c.red}#${a.number} [${a.severity}] ${a.rule}${c.reset}`);
    console.log(`    ${c.gray}${a.file}:${a.line}${c.reset}`);
    if (a.desc) console.log(`    ${a.desc}`);
    console.log(`    https://github.com/${REPO}/security/code-scanning/${a.number}`);
  }
}

// ── Pass / Fail ───────────────────────────────────────────────────────────────

console.log(`\n${c.gray}${'─'.repeat(50)}${c.reset}`);

if (blocking.length === 0) {
  if (informational.length > 0) {
    console.log(`${c.green}${c.bold}PASS${c.reset} — no blocking alerts. ${informational.length} note-level alert(s) — review but not required to fix before publishing.`);
  } else {
    console.log(`${c.green}${c.bold}PASS${c.reset} — no open CodeQL alerts.`);
  }
  process.exit(0);
} else {
  console.log(`${c.red}${c.bold}FAIL${c.reset} — ${blocking.length} blocking CodeQL alert(s) must be resolved before publishing.`);
  console.log(`Fix the code, push, and wait for "CodeQL Security Analysis" CI to re-run.\n`);
  process.exit(1);
}
