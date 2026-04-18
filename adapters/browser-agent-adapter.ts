/**
 * Browser Agent Adapter
 *
 * Integrates browser automation agents (Playwright, Puppeteer, or
 * any CDP-compatible driver) with the SwarmOrchestrator.
 *
 * Provides a BYOC (bring your own client) interface for browser
 * agents that navigate, scrape, interact with, and test web pages.
 *
 * Usage:
 *   const adapter = new BrowserAgentAdapter();
 *   adapter.registerBrowser('scraper', {
 *     driver: myPlaywrightDriver,
 *     mode: 'scrape',
 *   });
 *
 * @module BrowserAgentAdapter
 * @version 1.0.0
 */

import { BaseAdapter } from './base-adapter';
import type {
  AdapterConfig,
  AdapterCapabilities,
  AgentPayload,
  AgentContext,
  AgentResult,
} from '../types/agent-adapter';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Browser agent operating mode */
export type BrowserMode = 'navigate' | 'scrape' | 'interact' | 'test' | 'screenshot';

/** Navigation/action step for scripted browser agents */
export interface BrowserStep {
  /** Action type */
  action: 'goto' | 'click' | 'type' | 'select' | 'wait' | 'screenshot' | 'evaluate' | 'scroll';
  /** CSS selector for click/type/select */
  selector?: string;
  /** URL for goto, text for type */
  value?: string;
  /** Wait time in ms for wait action */
  waitMs?: number;
  /** JavaScript to evaluate for evaluate action */
  script?: string;
}

/** Result from a browser action */
export interface BrowserActionResult {
  /** URL after action */
  url: string;
  /** Page title */
  title: string;
  /** Extracted text content (for scrape mode) */
  textContent?: string;
  /** Extracted HTML (for scrape mode) */
  html?: string;
  /** Screenshot as base64 (for screenshot mode) */
  screenshot?: string;
  /** Evaluate result (for evaluate action) */
  evalResult?: unknown;
  /** Console messages captured */
  consoleMessages?: string[];
  /** Network errors captured */
  networkErrors?: string[];
  /** Execution time for this action */
  actionDurationMs?: number;
}

/**
 * Browser driver interface — wraps Playwright, Puppeteer, or CDP.
 * Users supply their own driver implementation.
 */
export interface BrowserDriver {
  /** Navigate to a URL */
  goto(url: string): Promise<BrowserActionResult>;
  /** Click an element */
  click(selector: string): Promise<BrowserActionResult>;
  /** Type text into an element */
  type(selector: string, text: string): Promise<BrowserActionResult>;
  /** Select an option */
  select(selector: string, value: string): Promise<BrowserActionResult>;
  /** Wait for a duration or selector */
  wait(ms: number): Promise<void>;
  /** Take a screenshot */
  screenshot(): Promise<string>;
  /** Evaluate JavaScript in the page */
  evaluate(script: string): Promise<unknown>;
  /** Get the current page text content */
  getTextContent(): Promise<string>;
  /** Get the current URL */
  getCurrentUrl(): Promise<string>;
  /** Get the page title */
  getTitle(): Promise<string>;
  /** Close the browser/page */
  close(): Promise<void>;
}

/** Configuration for a registered browser agent */
export interface BrowserAgentConfig {
  /** The browser driver instance */
  driver: BrowserDriver;
  /** Default mode (default: 'navigate') */
  mode?: BrowserMode;
  /** Default steps for scripted execution */
  steps?: BrowserStep[];
  /** Per-invocation timeout in ms (default: 60000) */
  timeoutMs?: number;
  /** Whether to capture console logs (default: false) */
  captureConsole?: boolean;
  /** Whether to capture screenshots after each step (default: false) */
  screenshotPerStep?: boolean;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Adapter for browser automation agents.
 *
 * Supports scripted step sequences or single-action modes
 * (navigate, scrape, screenshot, interact, test).
 */
export class BrowserAgentAdapter extends BaseAdapter {
  readonly name = 'browser-agent';
  readonly version = '1.0.0';

  private browsers = new Map<string, BrowserAgentConfig>();

  get capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      parallel: true,
      bidirectional: false,
      discovery: true,
      authentication: false,
      statefulSessions: true,
    };
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /**
   * Register a browser agent with a driver.
   */
  registerBrowser(agentId: string, config: BrowserAgentConfig): void {
    this.browsers.set(agentId, config);
    this.registerLocalAgent({
      id: agentId,
      name: agentId,
      status: 'available',
      capabilities: ['browser', config.mode ?? 'navigate', 'web'],
      metadata: {
        adapter: 'browser-agent',
        mode: config.mode ?? 'navigate',
      },
    });
  }

  // -----------------------------------------------------------------------
  // Execution
  // -----------------------------------------------------------------------

  async executeAgent(agentId: string, payload: AgentPayload, _context: AgentContext): Promise<AgentResult> {
    this.ensureReady();

    const config = this.browsers.get(agentId);
    if (!config) {
      return this.errorResult('BROWSER_AGENT_NOT_FOUND', `No browser registered as '${agentId}'`);
    }

    const mode = (payload.params?.mode as BrowserMode) ?? config.mode ?? 'navigate';
    const url = (payload.params?.url as string) ?? (payload.handoff?.instruction as string) ?? payload.action;
    const steps = (payload.params?.steps as BrowserStep[]) ?? config.steps;
    const timeoutMs = config.timeoutMs ?? 60_000;

    const start = Date.now();

    try {
      let result: Record<string, unknown>;

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Browser agent timed out')), timeoutMs),
      );

      if (steps?.length) {
        result = await Promise.race([
          this.executeSteps(config.driver, steps, config.screenshotPerStep ?? false),
          timeoutPromise,
        ]);
      } else {
        result = await Promise.race([
          this.executeSingleMode(config.driver, mode, url),
          timeoutPromise,
        ]);
      }

      const durationMs = Date.now() - start;
      return this.successResult({ ...result, mode }, durationMs);
    } catch (err) {
      return this.errorResult(
        'BROWSER_EXECUTION_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // -----------------------------------------------------------------------
  // Single mode execution
  // -----------------------------------------------------------------------

  private async executeSingleMode(
    driver: BrowserDriver,
    mode: BrowserMode,
    target: string,
  ): Promise<Record<string, unknown>> {
    switch (mode) {
      case 'navigate': {
        const result = await driver.goto(target);
        return { url: result.url, title: result.title };
      }
      case 'scrape': {
        await driver.goto(target);
        const text = await driver.getTextContent();
        const currentUrl = await driver.getCurrentUrl();
        const title = await driver.getTitle();
        return { url: currentUrl, title, textContent: text };
      }
      case 'screenshot': {
        await driver.goto(target);
        const screenshot = await driver.screenshot();
        const ssUrl = await driver.getCurrentUrl();
        return { url: ssUrl, screenshot };
      }
      case 'interact': {
        const result = await driver.goto(target);
        return { url: result.url, title: result.title, ready: true };
      }
      case 'test': {
        await driver.goto(target);
        const testUrl = await driver.getCurrentUrl();
        const testTitle = await driver.getTitle();
        return { url: testUrl, title: testTitle, tested: true };
      }
      default:
        return { error: `Unknown mode: ${mode}` };
    }
  }

  // -----------------------------------------------------------------------
  // Step-based execution
  // -----------------------------------------------------------------------

  private async executeSteps(
    driver: BrowserDriver,
    steps: BrowserStep[],
    screenshotPerStep: boolean,
  ): Promise<Record<string, unknown>> {
    const results: Array<Record<string, unknown>> = [];

    for (const step of steps) {
      const stepStart = Date.now();
      let stepResult: Record<string, unknown> = { action: step.action };

      switch (step.action) {
        case 'goto':
          if (step.value) {
            const r = await driver.goto(step.value);
            stepResult = { ...stepResult, url: r.url, title: r.title };
          }
          break;
        case 'click':
          if (step.selector) {
            const r = await driver.click(step.selector);
            stepResult = { ...stepResult, url: r.url };
          }
          break;
        case 'type':
          if (step.selector && step.value) {
            await driver.type(step.selector, step.value);
            stepResult = { ...stepResult, typed: step.value };
          }
          break;
        case 'select':
          if (step.selector && step.value) {
            await driver.select(step.selector, step.value);
            stepResult = { ...stepResult, selected: step.value };
          }
          break;
        case 'wait':
          await driver.wait(step.waitMs ?? 1000);
          stepResult = { ...stepResult, waited: step.waitMs ?? 1000 };
          break;
        case 'screenshot': {
          const ss = await driver.screenshot();
          stepResult = { ...stepResult, screenshot: ss };
          break;
        }
        case 'evaluate':
          if (step.script) {
            const evalResult = await driver.evaluate(step.script);
            stepResult = { ...stepResult, evalResult };
          }
          break;
        case 'scroll':
          await driver.evaluate(
            `window.scrollBy(0, ${step.value ? parseInt(step.value, 10) : 500})`,
          );
          stepResult = { ...stepResult, scrolled: true };
          break;
      }

      stepResult['durationMs'] = Date.now() - stepStart;

      if (screenshotPerStep && step.action !== 'screenshot') {
        stepResult['screenshot'] = await driver.screenshot();
      }

      results.push(stepResult);
    }

    const finalUrl = await driver.getCurrentUrl();
    const finalTitle = await driver.getTitle();

    return { steps: results, finalUrl, finalTitle, stepCount: results.length };
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async shutdown(): Promise<void> {
    // Close all browser drivers
    for (const [, config] of this.browsers) {
      try {
        await config.driver.close();
      } catch {
        // Best-effort cleanup
      }
    }
    this.browsers.clear();
    await super.shutdown();
  }
}
