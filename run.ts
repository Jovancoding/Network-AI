#!/usr/bin/env ts-node
/**
 * network-ai demo launcher
 * Run: npx ts-node run.ts
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import * as readline from 'readline';

// ─── Demo registry ────────────────────────────────────────────────────────────
const DEMOS = [
  { id: '01', file: 'examples/01-hello-swarm.ts',    title: 'Hello Swarm',            desc: '3-agent greeting pipeline'                     },
  { id: '02', file: 'examples/02-fsm-pipeline.ts',   title: 'FSM Pipeline',           desc: 'Finite-state-machine task orchestration'        },
  { id: '03', file: 'examples/03-parallel-agents.ts',title: 'Parallel Agents',        desc: 'Fan-out + merge pattern'                        },
  { id: '04', file: 'examples/04-live-swarm.ts',     title: 'AI Safety Swarm',        desc: '9-agent live research swarm + executive summary'},
  { id: '05', file: 'examples/05-code-review-swarm.ts', title: 'Code Review Swarm',  desc: '5 specialist reviewers + coordinator verdict'   },
];

// ─── Colours ──────────────────────────────────────────────────────────────────
const c = {
  reset  : '\x1b[0m',
  bold   : '\x1b[1m',
  dim    : '\x1b[2m',
  cyan   : '\x1b[36m',
  yellow : '\x1b[33m',
  green  : '\x1b[32m',
  red    : '\x1b[31m',
  white  : '\x1b[97m',
};

function banner() {
  console.clear();
  console.log();
  console.log(`  ${c.bold}${c.cyan}network-ai${c.reset}  —  demo launcher`);
  console.log(`  ${c.dim}──────────────────────────────────────${c.reset}`);
  console.log();
}

function printMenu(available: typeof DEMOS) {
  available.forEach((d, i) => {
    const num   = `${c.bold}${c.yellow}[${i + 1}]${c.reset}`;
    const title = `${c.bold}${c.white}${d.title}${c.reset}`;
    const desc  = `${c.dim}${d.desc}${c.reset}`;
    console.log(`  ${num}  ${title}`);
    console.log(`       ${desc}`);
    console.log();
  });
  console.log(`  ${c.dim}[q]  Quit${c.reset}`);
  console.log();
}

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function runDemo(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log();
    console.log(`  ${c.dim}Launching: ${file}${c.reset}`);
    console.log();

    const proc = spawn(
      'npx', ['ts-node', file],
      { stdio: 'inherit', shell: true, cwd: process.cwd() }
    );

    proc.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`Demo exited with code ${code}`));
    });

    proc.on('error', reject);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const available = DEMOS.filter(d => existsSync(join(process.cwd(), d.file)));

  while (true) {
    banner();
    printMenu(available);

    const answer = await ask(`  ${c.bold}Choose a demo:${c.reset} `);

    if (answer.toLowerCase() === 'q' || answer.toLowerCase() === 'quit') {
      console.log(`\n  ${c.dim}Bye.${c.reset}\n`);
      process.exit(0);
    }

    const idx = parseInt(answer) - 1;
    if (isNaN(idx) || idx < 0 || idx >= available.length) {
      console.log(`\n  ${c.red}Invalid choice — press Enter to try again.${c.reset}`);
      await ask('');
      continue;
    }

    const demo = available[idx];
    try {
      await runDemo(demo.file);
    } catch (err: any) {
      console.log(`\n  ${c.red}${err.message}${c.reset}`);
    }

    console.log();
    const again = await ask(`  ${c.dim}Back to menu? [Y/n]:${c.reset} `);
    if (again.toLowerCase() === 'n') {
      console.log(`\n  ${c.dim}Bye.${c.reset}\n`);
      process.exit(0);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
