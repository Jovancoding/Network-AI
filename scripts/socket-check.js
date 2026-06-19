#!/usr/bin/env node
/**
 * socket-check.js — Socket.dev score monitor for network-ai
 *
 * Usage:
 *   node scripts/socket-check.js                   # scan published npm package (current version)
 *   node scripts/socket-check.js --version 5.12.4  # scan a specific published version
 *   node scripts/socket-check.js --local            # scan the local project directory
 *   npm run socket:check                            # alias for default mode
 *
 * Exit codes:
 *   0 — all fixable alerts absent (gptSecurity, debugAccess gone)
 *   1 — one or more fixable alerts still present, or scan failed
 *
 * Requires: npx @socketsecurity/cli (installed on first run via npx -y)
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Config ─────────────────────────────────────────────────────────────────

/**
 * Alerts we are actively trying to eliminate.
 * Any of these present → exit 1.
 */
const FIXABLE_ALERTS = ['gptSecurity', 'debugAccess'];

/**
 * Alerts that are expected for this class of tool and are NOT considered
 * failures by this script. Document them here so the output is informative.
 */
const EXPECTED_ALERTS = {
  networkAccess:      'Expected — MCP/HTTP server + A2A adapter (product feature)',
  shellAccess:        'Expected — AgentRuntime shell sandbox (opt-in, policy-gated)',
  shellExec:          'Expected — AgentRuntime shell sandbox (opt-in, policy-gated)',
  recentlyPublished:  'Expected — auto-clears ~30 days after publish',
  envVars:            'Expected — API key reading in adapters (operator-supplied)',
  filesystemAccess:   'Expected — LockedBlackboard file I/O (product feature)',
  urlStrings:         'Expected — comes from commander dependency, not network-ai',
};

// ANSI colours (safe to use in any modern terminal)
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};

// ── Argument parsing ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const localMode   = args.includes('--local');
const versionFlag = args.indexOf('--version');
const forceVersion = versionFlag !== -1 ? args[versionFlag + 1] : null;

// ── Resolve version ─────────────────────────────────────────────────────────

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const version = forceVersion || pkg.version;
const packageName = pkg.name;

// ── Run Socket CLI ──────────────────────────────────────────────────────────

console.log(`\n${c.bold}${c.cyan}Socket.dev Score Check${c.reset}`);
console.log(`${c.gray}${'─'.repeat(50)}${c.reset}`);

let raw;
try {
  if (localMode) {
    console.log(`${c.gray}Mode: local scan (${process.cwd()})${c.reset}\n`);
    raw = execSync(
      'npx -y @socketsecurity/cli scan . --json 2>/dev/null || npx -y @socketsecurity/cli scan . 2>&1',
      { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } else {
    const purl = `npm ${packageName}@${version}`;
    console.log(`${c.gray}Mode: published package — ${purl}${c.reset}\n`);
    raw = execSync(
      `npx -y @socketsecurity/cli package shallow ${purl} 2>&1`,
      { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
  }
} catch (err) {
  // execSync throws on non-zero exit; capture output anyway
  raw = err.stdout || err.message || '';
}

// ── Parse output ─────────────────────────────────────────────────────────────

/** Strip ANSI escape codes from CLI output so regex matching works reliably. */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '').replace(/[✔✖ℹ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '');
}

const clean = stripAnsi(raw);

/**
 * Extract supply-chain score from CLI output.
 * Looks for: "- Supply Chain Risk:   75"
 */
function parseScore(text) {
  const m = text.match(/Supply Chain(?:\s+Risk)?:\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Extract alert list from the Alerts line:
 *   "- Alerts (0/4/4):  [middle] gptSecurity, [middle] networkAccess, ..."
 */
function parseAlerts(text) {
  const alerts = [];
  const tokenRe = /\[(middle|low|high|critical)\]\s+(\w+)/g;
  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    alerts.push({ severity: m[1], name: m[2] });
  }
  // Deduplicate
  const seen = new Set();
  return alerts.filter(a => {
    const key = a.severity + ':' + a.name;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const score  = parseScore(clean);
const alerts = parseAlerts(clean);

// ── Display ──────────────────────────────────────────────────────────────────

if (score !== null) {
  const colour = score >= 85 ? c.green : score >= 70 ? c.yellow : c.red;
  console.log(`${c.bold}Supply Chain Score:${c.reset} ${colour}${c.bold}${score}/100${c.reset}`);
} else {
  console.log(`${c.gray}(score not found in output — may need auth or package not yet published)${c.reset}`);
}

if (alerts.length > 0) {
  console.log(`\n${c.bold}Alerts (${alerts.length}):${c.reset}`);
  const sevOrder = { critical: 0, high: 1, middle: 2, low: 3 };
  const sorted = [...alerts].sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9));

  for (const alert of sorted) {
    const isFixable  = FIXABLE_ALERTS.includes(alert.name);
    const isExpected = Object.prototype.hasOwnProperty.call(EXPECTED_ALERTS, alert.name);

    let tag;
    if (isFixable) {
      tag = `${c.red}[FIXABLE]${c.reset}`;
    } else if (isExpected) {
      tag = `${c.gray}[expected]${c.reset}`;
    } else {
      tag = `${c.yellow}[review] ${c.reset}`;
    }

    const sevColour = alert.severity === 'middle' ? c.yellow : alert.severity === 'low' ? c.gray : c.red;
    const note = isExpected ? `  ${c.gray}${EXPECTED_ALERTS[alert.name]}${c.reset}` : '';
    console.log(`  ${tag} ${sevColour}[${alert.severity}]${c.reset} ${c.bold}${alert.name}${c.reset}${note}`);
  }
} else if (clean.includes('Alerts')) {
  console.log(`\n${c.green}${c.bold}No alerts found.${c.reset}`);
} else {
  console.log(`\n${c.gray}(alert list not parsed — raw output below)${c.reset}`);
  console.log(clean.split('\n').slice(0, 20).join('\n'));
}

// ── Pass/fail judgment ───────────────────────────────────────────────────────

const remainingFixable = alerts.filter(a => FIXABLE_ALERTS.includes(a.name));

console.log(`\n${c.gray}${'─'.repeat(50)}${c.reset}`);

if (remainingFixable.length === 0 && alerts.length > 0) {
  console.log(`${c.green}${c.bold}PASS${c.reset} — no fixable alerts present.`);
  if (score !== null && score < 85) {
    console.log(`${c.gray}Score ${score} is below 85 but remaining alerts are all expected.${c.reset}`);
    console.log(`${c.gray}The gap is 'recentlyPublished' (auto-expires ~30 days) + download count (grows organically).${c.reset}`);
  }
  process.exit(0);
} else if (remainingFixable.length === 0) {
  console.log(`${c.yellow}${c.bold}INCONCLUSIVE${c.reset} — no alerts parsed. Run with a published version or check auth.`);
  process.exit(1);
} else {
  console.log(`${c.red}${c.bold}FAIL${c.reset} — ${remainingFixable.length} fixable alert(s) still present:`);
  for (const a of remainingFixable) {
    console.log(`  ${c.red}✗${c.reset} ${a.name} [${a.severity}]`);
  }
  process.exit(1);
}
