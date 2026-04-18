/**
 * CoverageReporter — Lightweight code coverage reporting without external deps
 *
 * Integrates with Node.js built-in V8 coverage (`NODE_V8_COVERAGE`).
 * Parses V8 coverage JSON output into a structured report with file-level
 * line and function coverage metrics. Supports thresholds and reporters.
 *
 * Usage:
 *   // Run tests with V8 coverage:
 *   // NODE_V8_COVERAGE=./coverage npx ts-node test.ts
 *
 *   const reporter = new CoverageReporter({ coverageDir: './coverage' });
 *   const report = await reporter.collect();
 *   reporter.printSummary(report);
 *   reporter.enforce(report, { linePct: 80, branchPct: 70 });
 *
 * @module CoverageReporter
 * @version 1.0.0
 */

import { readdir, readFile } from 'fs/promises';
import { join, relative, resolve } from 'path';

// ============================================================================
// TYPES
// ============================================================================

/** V8 coverage function range */
interface V8FunctionCoverage {
  functionName: string;
  ranges: Array<{
    startOffset: number;
    endOffset: number;
    count: number;
  }>;
  isBlockCoverage: boolean;
}

/** V8 script coverage entry */
interface V8ScriptCoverage {
  scriptId: string;
  url: string;
  functions: V8FunctionCoverage[];
}

/** V8 coverage JSON file */
interface V8CoverageData {
  result: V8ScriptCoverage[];
}

/** Coverage stats for a single file */
export interface FileCoverage {
  /** File path (relative to project root) */
  file: string;
  /** Total functions found */
  totalFunctions: number;
  /** Functions with at least one call */
  coveredFunctions: number;
  /** Function coverage percentage (0-100) */
  functionPct: number;
  /** Total byte ranges */
  totalRanges: number;
  /** Ranges with count > 0 */
  coveredRanges: number;
  /** Range coverage percentage (0-100) */
  rangePct: number;
}

/** Aggregate coverage report */
export interface CoverageReport {
  /** Individual file coverage */
  files: FileCoverage[];
  /** Aggregate function coverage % */
  totalFunctionPct: number;
  /** Aggregate range coverage % */
  totalRangePct: number;
  /** Total files analyzed */
  fileCount: number;
  /** Timestamp */
  generatedAt: number;
}

/** Coverage thresholds */
export interface CoverageThresholds {
  /** Minimum function coverage % (0-100) */
  functionPct?: number;
  /** Minimum range/branch coverage % (0-100) */
  rangePct?: number;
  /** Per-file minimum function coverage % */
  perFileFunctionPct?: number;
}

/** Coverage reporter configuration */
export interface CoverageReporterConfig {
  /** Directory containing V8 coverage JSON files */
  coverageDir: string;
  /** Project root for relative path computation */
  projectRoot?: string;
  /** File patterns to include (substring match) */
  include?: string[];
  /** File patterns to exclude (substring match) */
  exclude?: string[];
}

// ============================================================================
// REPORTER
// ============================================================================

/**
 * CoverageReporter — Collects and reports V8 code coverage data.
 */
export class CoverageReporter {
  private readonly config: Required<CoverageReporterConfig>;

  constructor(config: CoverageReporterConfig) {
    this.config = {
      coverageDir: resolve(config.coverageDir),
      projectRoot: config.projectRoot ?? process.cwd(),
      include: config.include ?? ['.ts', '.js'],
      exclude: config.exclude ?? ['node_modules', 'test-', 'dist/'],
    };
  }

  /**
   * Collect coverage data from V8 coverage directory.
   */
  async collect(): Promise<CoverageReport> {
    const files: FileCoverage[] = [];
    const coverageFiles = await this.findCoverageFiles();

    for (const cf of coverageFiles) {
      const raw = await readFile(cf, 'utf-8');
      const data = JSON.parse(raw) as V8CoverageData;

      for (const script of data.result) {
        if (!this.shouldInclude(script.url)) continue;

        const relPath = this.toRelativePath(script.url);
        const existing = files.find((f) => f.file === relPath);
        if (existing) continue; // Deduplicate

        const totalFunctions = script.functions.length;
        const coveredFunctions = script.functions.filter((fn) =>
          fn.ranges.some((r) => r.count > 0),
        ).length;

        let totalRanges = 0;
        let coveredRanges = 0;
        for (const fn of script.functions) {
          for (const range of fn.ranges) {
            totalRanges++;
            if (range.count > 0) coveredRanges++;
          }
        }

        files.push({
          file: relPath,
          totalFunctions,
          coveredFunctions,
          functionPct: totalFunctions > 0 ? round((coveredFunctions / totalFunctions) * 100) : 100,
          totalRanges,
          coveredRanges,
          rangePct: totalRanges > 0 ? round((coveredRanges / totalRanges) * 100) : 100,
        });
      }
    }

    files.sort((a, b) => a.file.localeCompare(b.file));

    const totalFns = files.reduce((s, f) => s + f.totalFunctions, 0);
    const coveredFns = files.reduce((s, f) => s + f.coveredFunctions, 0);
    const totalRng = files.reduce((s, f) => s + f.totalRanges, 0);
    const coveredRng = files.reduce((s, f) => s + f.coveredRanges, 0);

    return {
      files,
      totalFunctionPct: totalFns > 0 ? round((coveredFns / totalFns) * 100) : 100,
      totalRangePct: totalRng > 0 ? round((coveredRng / totalRng) * 100) : 100,
      fileCount: files.length,
      generatedAt: Date.now(),
    };
  }

  /**
   * Print a summary table to console.
   */
  printSummary(report: CoverageReport): void {
    const header = 'File'.padEnd(50) + 'Functions'.padEnd(15) + 'Ranges';
    console.log('─'.repeat(75));
    console.log(header);
    console.log('─'.repeat(75));

    for (const f of report.files) {
      const name = f.file.length > 48 ? '…' + f.file.slice(-47) : f.file;
      const fnCol = `${f.coveredFunctions}/${f.totalFunctions} (${f.functionPct}%)`.padEnd(15);
      const rgCol = `${f.coveredRanges}/${f.totalRanges} (${f.rangePct}%)`;
      console.log(name.padEnd(50) + fnCol + rgCol);
    }

    console.log('─'.repeat(75));
    console.log(
      `Total: ${report.fileCount} files | ` +
      `Functions: ${report.totalFunctionPct}% | ` +
      `Ranges: ${report.totalRangePct}%`,
    );
    console.log('─'.repeat(75));
  }

  /**
   * Enforce coverage thresholds. Throws if below threshold.
   */
  enforce(report: CoverageReport, thresholds: CoverageThresholds): void {
    const failures: string[] = [];

    if (thresholds.functionPct !== undefined && report.totalFunctionPct < thresholds.functionPct) {
      failures.push(
        `Function coverage ${report.totalFunctionPct}% below threshold ${thresholds.functionPct}%`,
      );
    }

    if (thresholds.rangePct !== undefined && report.totalRangePct < thresholds.rangePct) {
      failures.push(
        `Range coverage ${report.totalRangePct}% below threshold ${thresholds.rangePct}%`,
      );
    }

    if (thresholds.perFileFunctionPct !== undefined) {
      for (const f of report.files) {
        if (f.functionPct < thresholds.perFileFunctionPct) {
          failures.push(
            `${f.file}: function coverage ${f.functionPct}% below per-file threshold ${thresholds.perFileFunctionPct}%`,
          );
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(`Coverage thresholds not met:\n${failures.join('\n')}`);
    }
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private async findCoverageFiles(): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await readdir(this.config.coverageDir);
      for (const entry of entries) {
        if (entry.endsWith('.json')) {
          results.push(join(this.config.coverageDir, entry));
        }
      }
    } catch {
      // Directory doesn't exist or not readable
    }
    return results;
  }

  private shouldInclude(url: string): boolean {
    if (!url || url.startsWith('node:')) return false;
    const hasInclude = this.config.include.some((p) => url.includes(p));
    const hasExclude = this.config.exclude.some((p) => url.includes(p));
    return hasInclude && !hasExclude;
  }

  private toRelativePath(url: string): string {
    let path = url;
    // Strip file:// prefix
    if (path.startsWith('file://')) {
      path = path.slice(7);
    }
    // On Windows, strip leading slash before drive letter
    if (/^\/[A-Za-z]:/.test(path)) {
      path = path.slice(1);
    }
    return relative(this.config.projectRoot, path).replace(/\\/g, '/');
  }
}

/** Round to 1 decimal */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}
