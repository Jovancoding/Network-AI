import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

type DemoId = '07' | '08' | 'both';

const DEMOS: Record<'07' | '08', { file: string; label: string }> = {
  '07': { file: 'examples/07-full-showcase.ts', label: 'Full Showcase (AI-powered)' },
  '08': { file: 'examples/08-control-plane-stress-demo.ts', label: 'Control Plane Stress (no API key)' },
};

function parseMode(args: string[]): DemoId | null {
  if (args.includes('--07') || args.includes('--full')) return '07';
  if (args.includes('--08') || args.includes('--control')) return '08';
  if (args.includes('--both') || args.includes('--all')) return 'both';
  return null;
}

function parseSilentSummary(args: string[]): boolean {
  return args.includes('--silent-summary') || args.includes('--summary');
}

function pickHighlights(log: string): string[] {
  const lines = log.split(/\r?\n/);
  const patterns = [
    /Deterministic Score:/i,
    /Deterministic Gate Result:/i,
    /Iteration\s+\d+\/\d+\s+score:/i,
    /Target reached/i,
    /violations total=/i,
    /byType=/i,
    /byAgent=/i,
    /demo complete\./i,
  ];

  const matched = lines.filter(line => patterns.some(re => re.test(line.trim())));
  const unique: string[] = [];
  for (const line of matched) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !unique.includes(trimmed)) unique.push(trimmed);
  }
  return unique;
}

function runTsDemo(file: string, silentSummary: boolean): Promise<{ code: number; log: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['ts-node', file], {
      stdio: silentSummary ? 'pipe' : 'inherit',
      shell: true,
    });

    let stdoutLog = '';
    let stderrLog = '';
    if (silentSummary) {
      child.stdout?.on('data', chunk => {
        stdoutLog += chunk.toString();
      });
      child.stderr?.on('data', chunk => {
        stderrLog += chunk.toString();
      });
    }

    child.on('error', reject);
    child.on('exit', code => {
      resolve({ code: code ?? 1, log: `${stdoutLog}\n${stderrLog}`.trim() });
    });
  });
}

async function askMode(): Promise<DemoId> {
  const rl = createInterface({ input, output });
  output.write('\nNetwork-AI Demo Runner\n');
  output.write('  [1] Full Showcase (07)\n');
  output.write('  [2] Control Plane Stress (08)\n');
  output.write('  [3] Both demos (07 then 08)\n\n');

  const answer = (await rl.question('Select demo [default: 3]: ')).trim();
  rl.close();

  if (answer === '1') return '07';
  if (answer === '2') return '08';
  return 'both';
}

async function main() {
  const args = process.argv.slice(2);
  const mode = parseMode(args) ?? (await askMode());
  const silentSummary = parseSilentSummary(args);

  if (silentSummary) {
    output.write('\nSilent summary mode enabled (full logs suppressed).\n');
  }

  const queue: Array<'07' | '08'> = mode === 'both' ? ['07', '08'] : [mode];

  for (const id of queue) {
    const demo = DEMOS[id];
    output.write(`\n=== Running ${demo.label} ===\n`);
    const result = await runTsDemo(demo.file, silentSummary);
    if (result.code !== 0) {
      if (silentSummary && result.log) {
        output.write('Summary (before failure):\n');
        const highlights = pickHighlights(result.log);
        for (const line of highlights) output.write(`  - ${line}\n`);
      }
      output.write(`\nDemo ${id} failed with exit code ${result.code}.\n`);
      process.exit(result.code);
    }

    if (silentSummary) {
      const highlights = pickHighlights(result.log);
      if (highlights.length > 0) {
        output.write('Summary:\n');
        for (const line of highlights) output.write(`  - ${line}\n`);
      } else {
        output.write('Summary: no highlights detected (run without --silent-summary for full logs).\n');
      }
    }

  }

  output.write('\nAll selected demos completed successfully.\n');
}

main().catch(err => {
  console.error('Demo runner failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
