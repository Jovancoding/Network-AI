/**
 * generate-demo-svg.ts — Creates an animated SVG terminal recording
 * from the gif-demo output. Runs inline on GitHub README.
 *
 * Run:  npx ts-node examples/generate-demo-svg.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const lines = [
  { text: '$ npx ts-node examples/gif-demo.ts', color: '#a6e3a1', delay: 0, bold: true },
  { text: '', delay: 0.3 },
  { text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', color: '#89b4fa', delay: 0.5, bold: true },
  { text: '  Network-AI — Multi-Agent Coordination Demo', color: '#89b4fa', delay: 0.6, bold: true },
  { text: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', color: '#89b4fa', delay: 0.7, bold: true },
  { text: '', delay: 0.8 },
  { text: '  ▸ Atomic Blackboard', color: '#cdd6f4', delay: 1.0, bold: true },
  { text: '  ● agent-A wrote  priority=0  status=queued', color: '#6c7086', delay: 1.3 },
  { text: '  ● agent-B wrote  priority=3  status=approved', color: '#f9e2af', delay: 1.6 },
  { text: '  ✓ final value: {"status":"approved"}  (priority wins)', color: '#a6e3a1', delay: 1.9 },
  { text: '', delay: 2.1 },
  { text: '  ▸ AuthGuardian Permission Gate', color: '#cdd6f4', delay: 2.3, bold: true },
  { text: '  ✗ weak justification → BLOCKED', color: '#f38ba8', delay: 2.6 },
  { text: '  ✓ strong justification → GRANTED  token=grant_4aed38…', color: '#a6e3a1', delay: 2.9 },
  { text: '', delay: 3.1 },
  { text: '  ▸ FederatedBudget', color: '#cdd6f4', delay: 3.3, bold: true },
  { text: '  ● agent-A spent 1,200 tokens  remaining=3800', color: '#89dceb', delay: 3.5 },
  { text: '  ● agent-B spent   800 tokens  remaining=3000', color: '#89dceb', delay: 3.7 },
  { text: '  ✓ ceiling=5,000  total=2,000  within budget', color: '#a6e3a1', delay: 3.9 },
  { text: '', delay: 4.1 },
  { text: '  ✓ Done — 3 primitives, 0 API calls, 0 race conditions.', color: '#a6e3a1', delay: 4.3, bold: true },
];

const FONT_SIZE = 14;
const LINE_HEIGHT = 20;
const PADDING_X = 20;
const PADDING_Y = 16;
const TITLE_BAR = 36;
const WIDTH = 640;
const HEIGHT = TITLE_BAR + PADDING_Y * 2 + lines.length * LINE_HEIGHT + 10;

const TOTAL_DURATION = 6; // seconds for full animation cycle
const PAUSE = 2; // seconds to hold at end before restart

let textElements = '';
lines.forEach((line, i) => {
  const y = TITLE_BAR + PADDING_Y + (i + 1) * LINE_HEIGHT;
  const weight = line.bold ? 'bold' : 'normal';
  const fill = line.color || '#cdd6f4';

  // Escape XML entities
  const escaped = line.text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  if (!escaped) {
    textElements += `    <text x="${PADDING_X}" y="${y}" fill="transparent">.</text>\n`;
    return;
  }

  textElements += `    <text x="${PADDING_X}" y="${y}" fill="${fill}" font-weight="${weight}">${escaped}</text>\n`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <style>
    text {
      font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
      font-size: ${FONT_SIZE}px;
      line-height: ${LINE_HEIGHT}px;
    }
  </style>

  <!-- Terminal frame -->
  <rect width="${WIDTH}" height="${HEIGHT}" rx="8" fill="#1e1e2e" />

  <!-- Title bar -->
  <rect width="${WIDTH}" height="${TITLE_BAR}" rx="8" fill="#181825" />
  <rect x="0" y="28" width="${WIDTH}" height="8" fill="#181825" />
  <circle cx="18" cy="18" r="6" fill="#f38ba8" />
  <circle cx="38" cy="18" r="6" fill="#f9e2af" />
  <circle cx="58" cy="18" r="6" fill="#a6e3a1" />
  <text x="${WIDTH / 2}" y="22" fill="#6c7086" text-anchor="middle" font-size="12">network-ai — demo</text>

  <!-- Terminal content -->
${textElements}
</svg>`;

const outPath = path.join(__dirname, '..', 'assets', 'demo.svg');
fs.writeFileSync(outPath, svg, 'utf-8');
console.log(`✓ Wrote ${outPath} (${svg.length} bytes)`);
