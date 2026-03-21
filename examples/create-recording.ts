/**
 * create-recording.ts — Generates an asciinema v2 cast file, then renders
 * to animated SVG via svg-term-cli.
 *
 * Run:  npx ts-node examples/create-recording.ts
 * Produces: assets/demo.svg (animated)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// ANSI color codes used in gif-demo
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

interface Event {
  time: number; // seconds from start
  text: string;
}

const events: Event[] = [];
let t = 0;

function addLine(text: string, delayMs: number) {
  t += delayMs / 1000;
  events.push({ time: t, text: text + '\r\n' });
}

function type(text: string, charDelayMs: number) {
  for (const ch of text) {
    t += charDelayMs / 1000;
    events.push({ time: t, text: ch });
  }
}

// ── Build the recording ──────────────────────────

// Type the command
type('npx ts-node examples/gif-demo.ts', 35);
t += 0.1;
events.push({ time: t, text: '\r\n' });

// Compilation delay
t += 1.5;

// Output
addLine('', 50);
addLine(`${BOLD}${CYAN}${'━'.repeat(52)}${RESET}`, 50);
addLine(`${BOLD}${CYAN}  Network-AI — Multi-Agent Coordination Demo${RESET}`, 50);
addLine(`${BOLD}${CYAN}${'━'.repeat(52)}${RESET}`, 50);
addLine('', 200);

addLine(`${BOLD}  ▸ Atomic Blackboard${RESET}`, 300);
addLine(`  ${DIM}● agent-A wrote  priority=0  status=queued${RESET}`, 250);
addLine(`  ${YELLOW}● agent-B wrote  priority=3  status=approved${RESET}`, 250);
addLine(`  ${GREEN}✓ final value: ${BOLD}{"status":"approved"}${RESET}  (priority wins)`, 400);
addLine('', 200);

addLine(`${BOLD}  ▸ AuthGuardian Permission Gate${RESET}`, 300);
addLine(`  ${RED}✗ weak justification → ${BOLD}BLOCKED${RESET}`, 350);
addLine(`  ${GREEN}✓ strong justification → ${BOLD}GRANTED${RESET}  token=grant_4aed38…`, 350);
addLine('', 200);

addLine(`${BOLD}  ▸ FederatedBudget${RESET}`, 300);
addLine(`  ${CYAN}● agent-A spent 1,200 tokens  remaining=3800${RESET}`, 200);
addLine(`  ${CYAN}● agent-B spent   800 tokens  remaining=3000${RESET}`, 200);
addLine(`  ${GREEN}✓ ceiling=5,000  total=2,000  ${BOLD}within budget${RESET}`, 350);
addLine('', 200);

addLine(`${BOLD}${GREEN}  ✓ Done — 3 primitives, 0 API calls, 0 race conditions.${RESET}`, 100);
addLine('', 100);

// Hold on final frame
t += 3;
events.push({ time: t, text: '' });

// ── Write asciinema v2 cast ─────────────────────

const header = JSON.stringify({
  version: 2,
  width: 80,
  height: 24,
  timestamp: Math.floor(Date.now() / 1000),
  title: 'Network-AI Demo',
  env: { SHELL: '/bin/bash', TERM: 'xterm-256color' },
});

const castLines = [header];
// Initial prompt
castLines.push(JSON.stringify([0, 'o', '$ ']));
for (const evt of events) {
  castLines.push(JSON.stringify([Number(evt.time.toFixed(3)), 'o', evt.text]));
}

const castPath = path.join(__dirname, '..', 'assets', 'demo.cast');
fs.writeFileSync(castPath, castLines.join('\n') + '\n', 'utf-8');
console.log(`✓ Wrote ${castPath}`);

// ── Render to animated SVG via svg-term ─────────

const outSvg = path.join(__dirname, '..', 'assets', 'demo.svg');
try {
  execSync(
    `svg-term --in "${castPath}" --out "${outSvg}" --no-cursor --padding 16 --height 24 --width 80 --window`,
    { stdio: 'inherit' },
  );
  console.log(`✓ Wrote ${outSvg}`);
} catch {
  console.error('svg-term failed — trying without --window');
  try {
    execSync(
      `svg-term --in "${castPath}" --out "${outSvg}" --no-cursor --padding 16 --height 24 --width 80`,
      { stdio: 'inherit' },
    );
    console.log(`✓ Wrote ${outSvg}`);
  } catch (e) {
    console.error('svg-term render failed:', e);
    console.log('Cast file is still available at:', castPath);
    console.log('You can render manually: svg-term --in assets/demo.cast --out assets/demo.svg --window');
  }
}

