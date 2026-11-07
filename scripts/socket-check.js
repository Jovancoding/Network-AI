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
 * Requires: @socketsecurity/cli, pinned to SOCKET_CLI below (run via npx on first use).
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Exact Socket CLI version (never a floating tag: the scanner must not change under us). */
const SOCKET_CLI = '@socketsecurity/cli@1.14.0';

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
  pendingScan:        'Expected — Socket is still scanning a freshly-published version; re-run in a few minutes',
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

// Validate user-supplied version is safe semver (guards against shell injection)
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
if (forceVersion && !SEMVER_RE.test(forceVersion)) {
  console.error(`Invalid --version value: ${JSON.stringify(forceVersion)} — must be semver (e.g. 5.12.5)`);
  process.exit(1);
}

// Run npx through node itself: Node >= 18.20 / 20.12 / 22 refuse to spawn npx.cmd without a shell on
// Windows (CVE-2024-27980), and a shell is what we must avoid. npm sets npm_execpath under `npm run`.
function npxCommand(args) {
  const npmCli = process.env.npm_execpath;
  const npxCli = npmCli ? path.join(path.dirname(npmCli), 'npx-cli.js') : path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (fs.existsSync(npxCli)) return { cmd: process.execPath, args: [npxCli, ...args] };
  return { cmd: 'npx', args };
}

function runSocket(socketArgs) {
  const { cmd, args: argv } = npxCommand(['-y', SOCKET_CLI, ...socketArgs]);
  const r = spawnSync(cmd, argv, { cwd: path.join(__dirname, '..'), encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { stdout: '', all: `spawn failed: ${r.error.message}` };
  return { stdout: r.stdout || '', all: (r.stdout || '') + (r.stderr || '') };
}

// ── Run Socket CLI ──────────────────────────────────────────────────────────

console.log(`\n${c.bold}${c.cyan}Socket.dev Score Check${c.reset}`);
console.log(`${c.gray}${'─'.repeat(50)}${c.reset}`);

let raw;
let scoreJson = null;
if (localMode) {
  console.log(`${c.gray}Mode: local scan (${process.cwd()})${c.reset}\n`);
  raw = runSocket(['scan', '.']).all;
} else {
  const purl = `npm ${packageName}@${version}`;
  console.log(`${c.gray}Mode: published package — ${purl}${c.reset}\n`);
  // Arg array, no shell: immune to injection (version is semver-validated above).
  const out = runSocket(['package', 'score', 'npm', `${packageName}@${version}`, '--json']);
  raw = out.all;
  try {
    const parsed = JSON.parse(out.stdout.slice(out.stdout.indexOf('{')));
    scoreJson = (parsed && parsed.data) || parsed;
  } catch {
    scoreJson = null;
  }
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
 * Prefers the `package score --json` report (`self.score.supplyChain`, 0–100);
 * falls back to text: "- Supply Chain Risk:   75".
 */
function parseScore(text) {
  const fromJson = scoreJson && scoreJson.self && scoreJson.self.score && scoreJson.self.score.supplyChain;
  if (typeof fromJson === 'number') return fromJson <= 1 ? Math.round(fromJson * 100) : Math.round(fromJson);
  const m = text.match(/Supply Chain(?:\s+Risk)?:\s*(\d+)/i);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return v > 100 ? null : v; // guard against spurious matches during pending scan
}

/**
 * Extract alerts: from the JSON report (`self.alerts[].name/severity`), or the
 * text Alerts line: "- Alerts (0/4/4):  [middle] gptSecurity, [middle] networkAccess, ..."
 */
function parseAlerts(text) {
  const alerts = [];
  if (scoreJson && scoreJson.self && Array.isArray(scoreJson.self.alerts)) {
    for (const a of scoreJson.self.alerts) {
      if (a && typeof a.name === 'string') alerts.push({ severity: String(a.severity || 'low'), name: a.name });
    }
  } else {
    const tokenRe = /\[(middle|low|high|critical)\]\s+(\w+)/g;
    let m;
    while ((m = tokenRe.exec(text)) !== null) {
      alerts.push({ severity: m[1], name: m[2] });
    }
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
