/**
 * ThinkingBlockManager — thinking-block lifecycle across model switches.
 *
 * Frontier models with always-on adaptive thinking return `thinking` blocks
 * whose `signature` ties them to the producing model. Two rules follow:
 *
 *   - **Same model, multi-turn:** pass thinking blocks back *unchanged* (the
 *     signature is validated server-side).
 *   - **Switching models (e.g. a refusal fallback):** *strip* `thinking` and
 *     `redacted_thinking` blocks from prior turns — another model ignores them
 *     but still bills them as input tokens.
 *
 * It also guards prompts against the `reasoning_extraction` refusal: asking a
 * model to reproduce its internal reasoning as response text can be declined.
 *
 * Satisfies the `ThinkingSink` contract consumed by
 * {@link ../lib/model-gateway!GovernedModelGateway}, which calls
 * {@link ThinkingBlockManager.stripForModelSwitch} on a cross-model retry — but
 * only when it is *not* redeeming a fallback credit (credit redemption requires
 * an exact body match, so blocks stay).
 *
 * @module ThinkingBlockManager
 * @version 1.0.0
 * @license MIT
 */

import type { ModelMessage, ModelContentBlock } from './model-gateway';

/** Block types tied to the producing model — dropped on a model switch. */
const MODEL_BOUND_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);

/** Phrases that ask a model to reproduce its internal reasoning as response text. */
const REASONING_EXTRACTION_PATTERNS: RegExp[] = [
  /\b(show|share|reveal|expose|print|output|reproduce|transcribe|echo|repeat)\b[^.?!]{0,40}\b(your|the)\b[^.?!]{0,20}\b(reasoning|thinking|thought process|chain[- ]of[- ]thought|inner monologue|scratchpad)\b/i,
  /\b(explain|describe|walk me through|narrate)\b[^.?!]{0,30}\b(your|the)\b[^.?!]{0,20}\b(internal|raw|verbatim)\b[^.?!]{0,20}\b(reasoning|thinking|thoughts?)\b/i,
  /\bthink(ing)?\b[^.?!]{0,20}\bout loud\b[^.?!]{0,30}\b(in|within|as part of)\b[^.?!]{0,20}\b(the )?(response|answer|output|final message)\b/i,
  /\b(include|put|place)\b[^.?!]{0,20}\b(your|the)\b[^.?!]{0,20}\b(chain[- ]of[- ]thought|reasoning|thinking)\b[^.?!]{0,20}\bin\b[^.?!]{0,20}\b(the )?(response|answer|output)\b/i,
];

/** Result of {@link ThinkingBlockManager.guardAgainstReasoningExtraction}. */
export interface ReasoningExtractionCheck {
  /** Whether any reasoning-extraction phrasing was detected. */
  flagged: boolean;
  /** The matched substrings, for surfacing to the caller. */
  matches: string[];
}

/**
 * Manages thinking blocks across same-model turns and cross-model fallbacks.
 *
 * @example
 * ```typescript
 * const thinking = new ThinkingBlockManager();
 * const gateway = new GovernedModelGateway({ caller, primaryModel, fallbackModels, thinking });
 *
 * // Guard a system prompt before sending it to a refusal-prone model:
 * const check = thinking.guardAgainstReasoningExtraction(systemPrompt);
 * if (check.flagged) console.warn('reasoning-extraction risk:', check.matches);
 * ```
 */
export class ThinkingBlockManager {

  /**
   * Strip model-bound thinking blocks from prior assistant turns before a
   * cross-model retry. `fallback`, `text`, and tool blocks are preserved; only
   * `thinking` / `redacted_thinking` blocks are removed. Messages whose content
   * is not a block array are returned untouched.
   *
   * @param messages  The conversation to clean.
   * @returns         A new array with model-bound blocks removed.
   */
  stripForModelSwitch(messages: ModelMessage[]): ModelMessage[] {
    return messages.map((msg) => {
      if (!Array.isArray(msg.content)) return msg;
      const blocks = msg.content as ModelContentBlock[];
      const kept = blocks.filter((b) => !(b && typeof b === 'object' && MODEL_BOUND_BLOCK_TYPES.has(b.type)));
      if (kept.length === blocks.length) return msg;
      return { ...msg, content: kept };
    });
  }

  /**
   * Identity transform documenting the same-model rule: thinking blocks must be
   * passed back **unchanged** when continuing on the same model.
   *
   * @param messages  The conversation.
   * @returns         The same messages, unchanged.
   */
  preserveForSameModel(messages: ModelMessage[]): ModelMessage[] {
    return messages;
  }

  /** Whether any message carries a model-bound thinking block. */
  hasThinkingBlocks(messages: ModelMessage[]): boolean {
    return messages.some(
      (m) => Array.isArray(m.content) && (m.content as ModelContentBlock[]).some((b) => b && typeof b === 'object' && MODEL_BOUND_BLOCK_TYPES.has(b.type)),
    );
  }

  /**
   * Detect prompt text that asks a model to reproduce its internal reasoning as
   * response text — which can trigger a `reasoning_extraction` refusal. Read the
   * structured `thinking` blocks instead of prompting for reasoning in the body.
   *
   * @param text  The prompt or instruction to inspect.
   */
  guardAgainstReasoningExtraction(text: string): ReasoningExtractionCheck {
    const matches: string[] = [];
    if (typeof text === 'string' && text.length > 0) {
      for (const re of REASONING_EXTRACTION_PATTERNS) {
        const m = text.match(re);
        if (m && m[0]) matches.push(m[0].trim());
      }
    }
    return { flagged: matches.length > 0, matches };
  }
}
