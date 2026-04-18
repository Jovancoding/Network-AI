/**
 * WorkTreeUI — Terminal renderer for WorkTree hierarchies
 *
 * Renders a WorkTree as an ASCII/Unicode tree with:
 *   - Box-drawing connectors (├─, └─, │)
 *   - Status icons and color-coding
 *   - Progress bars per branch node
 *   - Token counts
 *   - Agent assignments
 *   - Live auto-refresh mode via WorkTree events
 *
 * Zero external dependencies — uses the {@link ansi} helpers from ConsoleUI.
 *
 * @module WorkTreeUI
 * @version 1.0.0
 */

import { EventEmitter } from 'events';
import { ansi } from './console-ui';
import type { WorkTree, WorkNode, WorkNodeStatus, WorkTreeStats } from './work-tree';

// ============================================================================
// TYPES
// ============================================================================

/** Render options for WorkTreeUI */
export interface WorkTreeUIOptions {
  /** Output stream (default: process.stdout) */
  output?: NodeJS.WritableStream;
  /** Show token counts (default: true) */
  showTokens?: boolean;
  /** Show agent assignments (default: true) */
  showAgents?: boolean;
  /** Show progress bars (default: true) */
  showProgress?: boolean;
  /** Show stats footer (default: true) */
  showStats?: boolean;
  /** Progress bar width in characters (default: 10) */
  progressBarWidth?: number;
  /** Use color output (default: true) */
  useColor?: boolean;
  /** Indent size per depth level (default: 2) */
  indentSize?: number;
  /** Title override (default: root label) */
  title?: string;
  /** Compact mode — hide nodes at depth > maxDepth (default: Infinity) */
  maxDepth?: number;
  /** Auto-refresh on WorkTree events (default: false) */
  live?: boolean;
}

/** Column-aligned render result for programmatic use */
export interface RenderResult {
  /** The rendered tree as a single string */
  text: string;
  /** Number of lines rendered */
  lineCount: number;
  /** Stats snapshot at render time */
  stats: WorkTreeStats;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const STATUS_ICONS: Record<WorkNodeStatus, string> = {
  pending:   '○',
  running:   '◑',
  completed: '✔',
  failed:    '✘',
  skipped:   '⏭',
  blocked:   '⛔',
};

const STATUS_COLORS: Record<WorkNodeStatus, string> = {
  pending:   ansi.gray,
  running:   ansi.yellow,
  completed: ansi.green,
  failed:    ansi.red,
  skipped:   ansi.gray,
  blocked:   ansi.red,
};

// Box-drawing characters
const BOX = {
  pipe:   '│',
  tee:    '├',
  corner: '└',
  dash:   '─',
  space:  ' ',
} as const;

// Progress bar characters
const BAR = {
  full:   '█',
  seven:  '▓',
  half:   '▒',
  light:  '░',
  empty:  '░',
} as const;

// ============================================================================
// WORK TREE UI
// ============================================================================

/**
 * Terminal renderer for {@link WorkTree} hierarchies.
 *
 * ```typescript
 * const tree = new WorkTree('root', 'My Project');
 * // ... add children, set statuses ...
 *
 * const ui = new WorkTreeUI(tree);
 * ui.render();            // print to stdout
 *
 * const result = ui.toString(); // get as string
 *
 * ui.startLive();         // auto-refresh on changes
 * ui.stopLive();
 * ```
 */
export class WorkTreeUI extends EventEmitter {
  private readonly tree: WorkTree;
  private readonly opts: Required<WorkTreeUIOptions>;
  private liveCleanup: (() => void) | null = null;
  private lastLineCount = 0;

  constructor(tree: WorkTree, options?: WorkTreeUIOptions) {
    super();
    this.tree = tree;
    this.opts = {
      output: options?.output ?? process.stdout,
      showTokens: options?.showTokens ?? true,
      showAgents: options?.showAgents ?? true,
      showProgress: options?.showProgress ?? true,
      showStats: options?.showStats ?? true,
      progressBarWidth: options?.progressBarWidth ?? 10,
      useColor: options?.useColor ?? true,
      indentSize: options?.indentSize ?? 2,
      title: options?.title ?? '',
      maxDepth: options?.maxDepth ?? Infinity,
      live: options?.live ?? false,
    };

    if (this.opts.live) {
      this.startLive();
    }
  }

  // --------------------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------------------

  /**
   * Render the tree to the output stream.
   * In live mode this clears previous output first.
   */
  render(): RenderResult {
    const result = this.buildRender();

    if (this.liveCleanup && this.lastLineCount > 0) {
      // Move cursor up and clear previous render
      this.write(`\x1b[${this.lastLineCount}A`);
      for (let i = 0; i < this.lastLineCount; i++) {
        this.write(`${ansi.clearLine}\n`);
      }
      this.write(`\x1b[${this.lastLineCount}A`);
    }

    this.write(result.text);
    this.lastLineCount = result.lineCount;
    this.emit('render', result);
    return result;
  }

  /**
   * Return the rendered tree as a string (no side effects).
   */
  toString(): string {
    return this.buildRender().text;
  }

  /**
   * Start live mode — auto-refresh whenever the tree changes.
   */
  startLive(): void {
    if (this.liveCleanup) return;

    const handler = () => this.render();
    this.tree.on('node:added', handler);
    this.tree.on('node:removed', handler);
    this.tree.on('node:status', handler);
    this.tree.on('node:tokens', handler);

    this.liveCleanup = () => {
      this.tree.removeListener('node:added', handler);
      this.tree.removeListener('node:removed', handler);
      this.tree.removeListener('node:status', handler);
      this.tree.removeListener('node:tokens', handler);
    };

    // Initial render
    this.render();
  }

  /**
   * Stop live mode.
   */
  stopLive(): void {
    if (this.liveCleanup) {
      this.liveCleanup();
      this.liveCleanup = null;
    }
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.stopLive();
    this.removeAllListeners();
  }

  // --------------------------------------------------------------------------
  // RENDERING
  // --------------------------------------------------------------------------

  private buildRender(): RenderResult {
    const lines: string[] = [];
    const stats = this.tree.stats();
    const root = this.tree.getRoot();
    const title = this.opts.title || root.label;

    // Header
    lines.push('');
    lines.push(this.style(`  ${title}`, ansi.bold));
    lines.push(`  ${this.style('─'.repeat(Math.max(title.length + 4, 50)), ansi.dim)}`);

    // Tree body
    const flat = this.tree.flatten();
    // Build a set of "has next sibling" per depth for pipe drawing
    const pipeStack: boolean[] = [];

    for (let i = 0; i < flat.length; i++) {
      const node = flat[i];
      if (node.depth > this.opts.maxDepth) continue;

      const line = this.renderNode(node, flat, i, pipeStack);
      lines.push(line);
    }

    // Footer
    if (this.opts.showStats) {
      lines.push('');
      lines.push(`  ${this.style('─'.repeat(Math.max(title.length + 4, 50)), ansi.dim)}`);
      lines.push(this.renderStatsLine(stats));
      lines.push(this.renderTokenLine(stats));
      lines.push(this.renderOverallProgress(stats));
    }

    lines.push('');

    const text = lines.join('\n');
    return { text, lineCount: lines.length, stats };
  }

  private renderNode(
    node: WorkNode,
    flat: WorkNode[],
    index: number,
    pipeStack: boolean[],
  ): string {
    const depth = node.depth;
    const isRoot = depth === 0;

    // Determine if this node is the last child of its parent
    const isLastChild = this.isLastSibling(node);

    // Update pipe stack for connector drawing
    pipeStack.length = depth;
    if (!isRoot) {
      // At depth-1, set whether we should continue drawing a pipe
      if (depth > 0) {
        pipeStack[depth - 1] = !isLastChild;
      }
    }

    // Build prefix with connectors
    let prefix = '  '; // left margin
    if (!isRoot) {
      for (let d = 0; d < depth - 1; d++) {
        prefix += pipeStack[d]
          ? `${BOX.pipe}${BOX.space.repeat(this.opts.indentSize)}`
          : `${BOX.space}${BOX.space.repeat(this.opts.indentSize)}`;
      }
      prefix += isLastChild
        ? `${BOX.corner}${BOX.dash} `
        : `${BOX.tee}${BOX.dash} `;
    }

    // Status icon
    const icon = STATUS_ICONS[node.status];
    const statusColor = STATUS_COLORS[node.status];

    // Label
    const label = this.style(`${icon} ${node.label}`, statusColor);

    // Inline metadata
    const parts: string[] = [label];

    // Progress bar for branch nodes
    if (this.opts.showProgress && node.children.length > 0) {
      parts.push(this.renderProgressBar(node.progress, node.status));
    }

    // Token count
    if (this.opts.showTokens && node.totalTokens > 0) {
      const tokenStr = node.children.length > 0
        ? `${this.formatTokens(node.totalTokens)} tok`
        : `${this.formatTokens(node.ownTokens)} tok`;
      parts.push(this.style(tokenStr, ansi.dim));
    }

    // Agent
    if (this.opts.showAgents && node.agent) {
      parts.push(this.style(`@${node.agent}`, ansi.dim + ansi.cyan));
    }

    return prefix + parts.join(' ');
  }

  private renderProgressBar(progress: number, status: WorkNodeStatus): string {
    const width = this.opts.progressBarWidth;
    const filled = Math.round(progress * width);
    const empty = width - filled;

    let barColor: string;
    if (status === 'completed') barColor = ansi.green;
    else if (status === 'failed') barColor = ansi.red;
    else if (progress >= 0.5) barColor = ansi.yellow;
    else barColor = ansi.gray;

    const filledStr = BAR.full.repeat(filled);
    const emptyStr = BAR.empty.repeat(empty);
    const pct = `${Math.round(progress * 100)}%`;

    return this.style(`${filledStr}`, barColor) +
      this.style(emptyStr, ansi.dim) +
      ' ' +
      this.style(pct, progress === 1 ? ansi.green : ansi.dim);
  }

  private renderStatsLine(stats: WorkTreeStats): string {
    const parts = [
      this.style(`${stats.completed} done`, ansi.green),
      this.style(`${stats.running} running`, ansi.yellow),
      this.style(`${stats.failed} failed`, ansi.red),
      `${stats.pending} pending`,
    ];
    if (stats.blocked > 0) {
      parts.push(this.style(`${stats.blocked} blocked`, ansi.red + ansi.dim));
    }
    if (stats.skipped > 0) {
      parts.push(this.style(`${stats.skipped} skipped`, ansi.dim));
    }
    return `  ${this.style(`${stats.total} nodes`, ansi.bold)} │ ${parts.join(this.style(' │ ', ansi.dim))}`;
  }

  private renderTokenLine(stats: WorkTreeStats): string {
    return `  Tokens: ${this.style(this.formatTokens(stats.totalTokens), ansi.bold)} │ Depth: ${stats.maxDepth}`;
  }

  private renderOverallProgress(stats: WorkTreeStats): string {
    const width = 30;
    const pct = stats.progress;
    const filled = Math.round(pct * width);
    const empty = width - filled;

    let barColor: string;
    if (pct === 1) barColor = ansi.green;
    else if (pct >= 0.66) barColor = ansi.yellow;
    else barColor = ansi.cyan;

    const filledStr = BAR.full.repeat(filled);
    const emptyStr = BAR.empty.repeat(empty);
    const pctStr = `${Math.round(pct * 100)}%`;

    return `  Progress: ${this.style(filledStr, barColor)}${this.style(emptyStr, ansi.dim)} ${this.style(pctStr, ansi.bold)}`;
  }

  // --------------------------------------------------------------------------
  // HELPERS
  // --------------------------------------------------------------------------

  private isLastSibling(node: WorkNode): boolean {
    if (!node.parentId) return true;
    const parent = this.tree.getNode(node.parentId);
    if (!parent) return true;
    return parent.children[parent.children.length - 1] === node.id;
  }

  private style(text: string, code: string): string {
    if (!this.opts.useColor) return text;
    return `${code}${text}${ansi.reset}`;
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  private write(text: string): void {
    (this.opts.output as NodeJS.WritableStream).write(text);
  }
}
