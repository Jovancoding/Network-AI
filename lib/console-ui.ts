/**
 * Console UI — Interactive terminal dashboard for Network-AI
 *
 * A TUI (text user interface) built with Node.js builtins (readline + ANSI
 * escape codes). Zero external dependencies.
 *
 * Features:
 *   - Live event feed with timestamped entries
 *   - Status bar (agents, budget, FSM state)
 *   - Command input with auto-completion
 *   - Approval prompts (approve/deny inline)
 *   - Color-coded output
 *
 * @module ConsoleUI
 * @version 1.0.0
 */

import { createInterface, Interface as ReadlineInterface } from 'readline';
import { EventEmitter } from 'events';

// ============================================================================
// ANSI HELPERS
// ============================================================================

const ESC = '\x1b[';

/** ANSI color/style codes */
export const ansi = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,

  // Foreground
  black: `${ESC}30m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  white: `${ESC}37m`,
  gray: `${ESC}90m`,

  // Background
  bgBlack: `${ESC}40m`,
  bgRed: `${ESC}41m`,
  bgGreen: `${ESC}42m`,
  bgYellow: `${ESC}43m`,
  bgBlue: `${ESC}44m`,
  bgMagenta: `${ESC}45m`,
  bgCyan: `${ESC}46m`,
  bgWhite: `${ESC}47m`,

  // Cursor
  clearScreen: `${ESC}2J${ESC}H`,
  clearLine: `${ESC}2K`,
  cursorHome: `${ESC}H`,
  hideCursor: `${ESC}?25l`,
  showCursor: `${ESC}?25h`,
};

/** Apply color to text */
function color(text: string, ...codes: string[]): string {
  return codes.join('') + text + ansi.reset;
}

/** Format a timestamp for display */
function timeStamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ============================================================================
// TYPES
// ============================================================================

/** Status data displayed in the header bar */
export interface ConsoleStatus {
  version: string;
  agents: { active: number; total: number };
  budget: { usedPercent: number };
  fsm: { state: string };
  pendingApprovals: number;
}

/** A feed entry displayed in the live feed */
export interface FeedEntry {
  time: string;
  icon: string;
  message: string;
  level: 'info' | 'warn' | 'error' | 'success' | 'approval';
}

/** Command handler function */
export type CommandHandler = (args: string, ui: ConsoleUI) => Promise<void> | void;

/** Console UI options */
export interface ConsoleUIOptions {
  /** Title shown in the header */
  title?: string;
  /** Version string */
  version?: string;
  /** Custom prompt string (default: '> ') */
  prompt?: string;
  /** Maximum feed entries to keep (default: 200) */
  maxFeedEntries?: number;
  /** Input stream (default: process.stdin) */
  input?: NodeJS.ReadableStream;
  /** Output stream (default: process.stdout) */
  output?: NodeJS.WritableStream;
}

// ============================================================================
// CONSOLE UI
// ============================================================================

/**
 * Interactive terminal UI for Network-AI agent runtime.
 *
 * @example
 * ```typescript
 * const ui = new ConsoleUI({ title: 'Network-AI', version: '4.13.1' });
 * ui.command('status', (args, ui) => { ui.log('All systems operational'); });
 * ui.command('approve', async (args, ui) => { ... });
 * await ui.start();
 * ```
 */
export class ConsoleUI extends EventEmitter {
  private readonly opts: Required<ConsoleUIOptions>;
  private rl: ReadlineInterface | null = null;
  private commands = new Map<string, { handler: CommandHandler; description: string }>();
  private feed: FeedEntry[] = [];
  private status: ConsoleStatus = {
    version: '0.0.0',
    agents: { active: 0, total: 0 },
    budget: { usedPercent: 0 },
    fsm: { state: 'idle' },
    pendingApprovals: 0,
  };
  private running = false;

  constructor(opts: ConsoleUIOptions = {}) {
    super();
    this.opts = {
      title: opts.title ?? 'Network-AI',
      version: opts.version ?? '0.0.0',
      prompt: opts.prompt ?? '> ',
      maxFeedEntries: opts.maxFeedEntries ?? 200,
      input: opts.input ?? process.stdin,
      output: opts.output ?? process.stdout,
    };
    this.status.version = this.opts.version;

    // Register built-in commands
    this.command('help', (_args, ui) => { ui.showHelp(); }, 'Show available commands');
    this.command('clear', (_args, ui) => { ui.clearFeed(); }, 'Clear the event feed');
    this.command('exit', () => { this.stop(); }, 'Exit the console');
    this.command('quit', () => { this.stop(); }, 'Exit the console');
  }

  /** Register a command handler */
  command(name: string, handler: CommandHandler, description = ''): void {
    this.commands.set(name.toLowerCase(), { handler, description });
  }

  /** Update the status bar */
  updateStatus(partial: Partial<ConsoleStatus>): void {
    Object.assign(this.status, partial);
  }

  /** Add an entry to the live feed */
  log(message: string, level: FeedEntry['level'] = 'info'): void {
    const icons: Record<FeedEntry['level'], string> = {
      info: color('ℹ', ansi.cyan),
      warn: color('⚠', ansi.yellow),
      error: color('✗', ansi.red),
      success: color('✓', ansi.green),
      approval: color('⏳', ansi.magenta),
    };

    const entry: FeedEntry = {
      time: timeStamp(),
      icon: icons[level],
      message,
      level,
    };

    this.feed.push(entry);
    if (this.feed.length > this.opts.maxFeedEntries) {
      this.feed.shift();
    }

    this.emit('feed', entry);

    // Print inline if running
    if (this.running) {
      this.writeFeedEntry(entry);
    }
  }

  /** Get all feed entries */
  getFeed(): ReadonlyArray<FeedEntry> {
    return this.feed;
  }

  /** Clear the feed */
  clearFeed(): void {
    this.feed = [];
    if (this.running) {
      this.write(ansi.clearScreen);
      this.renderHeader();
      this.renderPrompt();
    }
  }

  /** Get current status */
  getStatus(): Readonly<ConsoleStatus> {
    return { ...this.status };
  }

  /** Start the interactive console */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.rl = createInterface({
      input: this.opts.input,
      output: this.opts.output,
      prompt: this.opts.prompt,
      terminal: true,
    });

    this.renderHeader();
    this.renderPrompt();

    this.rl.on('line', async (line: string) => {
      const trimmed = line.trim();
      if (trimmed) {
        await this.handleInput(trimmed);
      }
      if (this.running) {
        this.renderPrompt();
      }
    });

    this.rl.on('close', () => {
      this.running = false;
      this.emit('exit');
    });

    return new Promise<void>((resolve) => {
      this.once('exit', resolve);
    });
  }

  /** Stop the console */
  stop(): void {
    this.running = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    this.write(color('\nGoodbye.\n', ansi.dim));
    this.emit('exit');
  }

  /** Whether the console is currently running */
  get isRunning(): boolean { return this.running; }

  /** Show the help text */
  showHelp(): void {
    this.write('\n' + color('  Available Commands:', ansi.bold, ansi.cyan) + '\n');
    for (const [name, { description }] of this.commands) {
      const desc = description ? color(` — ${description}`, ansi.dim) : '';
      this.write(`    ${color(name, ansi.green)}${desc}\n`);
    }
    this.write('\n');
  }

  /** Render the header/status bar */
  renderHeader(): void {
    const s = this.status;
    const divider = color('─'.repeat(60), ansi.dim);

    this.write('\n');
    this.write(
      `  ${color(this.opts.title, ansi.bold, ansi.cyan)} ` +
      color(`v${s.version}`, ansi.dim) + '\n',
    );
    this.write(divider + '\n');
    this.write(
      `  Agents: ${color(String(s.agents.active), ansi.green)}/${s.agents.total}` +
      `  │  Budget: ${this.budgetColor(s.budget.usedPercent)}` +
      `  │  FSM: ${color(s.fsm.state, ansi.yellow)}` +
      (s.pendingApprovals > 0
        ? `  │  ${color(`${s.pendingApprovals} pending`, ansi.magenta, ansi.bold)}`
        : '') +
      '\n',
    );
    this.write(divider + '\n');
  }

  // ------- Internals -------

  private write(text: string): void {
    const out = this.opts.output as NodeJS.WritableStream & { write: (s: string) => void };
    out.write(text);
  }

  private renderPrompt(): void {
    if (this.rl) {
      this.rl.prompt();
    }
  }

  private writeFeedEntry(entry: FeedEntry): void {
    const time = color(`[${entry.time}]`, ansi.dim);
    this.write(`\r${ansi.clearLine}  ${time} ${entry.icon} ${entry.message}\n`);
  }

  private budgetColor(pct: number): string {
    const text = `${pct}%`;
    if (pct >= 80) return color(text, ansi.red, ansi.bold);
    if (pct >= 50) return color(text, ansi.yellow);
    return color(text, ansi.green);
  }

  private async handleInput(input: string): Promise<void> {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    const handler = this.commands.get(cmd);
    if (!handler) {
      this.write(color(`  Unknown command: ${cmd}. Type 'help' for available commands.\n`, ansi.red));
      this.emit('unknown-command', cmd, args);
      return;
    }

    try {
      await handler.handler(args, this);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.write(color(`  Error: ${msg}\n`, ansi.red));
    }

    this.emit('command', cmd, args);
  }
}
