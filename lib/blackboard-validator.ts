/**
 * BlackboardValidator + QualityGateAgent
 *
 * Two-layer content validation for the SharedBlackboard:
 *
 * Layer 1 -- BlackboardValidator (rule-based, deterministic, fast)
 *   Validates structure, completeness, and basic quality of tasks,
 *   results, and code before they enter the blackboard.
 *
 * Layer 2 -- QualityGateAgent (AI-assisted, optional)
 *   A special review agent that can inspect pending entries,
 *   run deeper analysis, detect hallucinations, and approve/reject.
 *
 * Together they prevent bad code, incomplete results, and hallucinated
 * data from poisoning the shared state that other agents depend on.
 *
 * @module BlackboardValidator
 */

// ============================================================================
// TYPES
// ============================================================================

export interface ValidationResult {
  /** Did the entry pass validation? */
  passed: boolean;
  /** Quality score 0-1 (1 = perfect) */
  score: number;
  /** Specific issues found */
  issues: ValidationIssue[];
  /** Which rules were checked */
  rulesApplied: string[];
  /** Timestamp of validation */
  timestamp: string;
  /** If failed, can it be retried after fixes? */
  recoverable: boolean;
}

export interface ValidationIssue {
  /** Rule that flagged the issue */
  rule: string;
  /** Severity: error blocks entry, warning is logged, info is advisory */
  severity: 'error' | 'warning' | 'info';
  /** Human-readable description */
  message: string;
  /** Which field had the problem */
  field?: string;
  /** Suggested fix */
  suggestion?: string;
}

/** Configuration for validation rules -- all configurable per domain */
export interface ValidationConfig {
  /** Minimum instruction length for tasks (chars) */
  minInstructionLength: number;
  /** Maximum instruction length for tasks (chars) */
  maxInstructionLength: number;
  /** Require tasks to have constraints defined */
  requireConstraints: boolean;
  /** Require tasks to have expectedOutput defined */
  requireExpectedOutput: boolean;
  /** Minimum result data fields for a result to be considered complete */
  minResultFields: number;
  /** Maximum allowed error rate in a batch of results */
  maxErrorRate: number;
  /** Code quality: minimum lines for a code entry to be non-trivial */
  minCodeLines: number;
  /** Code quality: maximum allowed ratio of comments to code */
  maxCommentRatio: number;
  /** Detect common hallucination patterns */
  detectHallucinations: boolean;
  /** Reject entries with placeholder/dummy data patterns */
  rejectPlaceholders: boolean;
  /** Custom validation rules -- user-extensible */
  customRules: CustomValidationRule[];
}

export interface CustomValidationRule {
  /** Unique rule name */
  name: string;
  /** Human-readable description of the rule */
  description?: string;
  /** Which entry types this rule applies to ('task', 'result', 'code', 'any') */
  appliesTo: string[];
  /** The validation function -- return null if valid, or an issue */
  validate: (key: string, value: unknown, metadata?: Record<string, unknown>) => ValidationIssue | null;
}

/** Quality gate decision */
export type GateDecision = 'approve' | 'reject' | 'quarantine' | 'needs_review';

export interface QualityGateResult {
  decision: GateDecision;
  validation: ValidationResult;
  /** If quarantined, it's stored here instead of the main blackboard */
  quarantineKey?: string;
  /** Review notes from the quality gate */
  reviewNotes: string[];
  /** Reviewer agent ID (if AI review was used) */
  reviewedBy?: string;
}

/** Callback type for AI review delegation */
export type AIReviewCallback = (
  key: string,
  value: unknown,
  entryType: string,
  context: { sourceAgent: string; validation: ValidationResult }
) => Promise<{
  approved: boolean;
  confidence: number;
  feedback: string;
  suggestedFixes?: string[];
}>;

// ============================================================================
// DEFAULT CONFIGURATION
// ============================================================================

const DEFAULT_CONFIG: ValidationConfig = {
  minInstructionLength: 10,
  maxInstructionLength: 50000,
  requireConstraints: false,
  requireExpectedOutput: false,
  minResultFields: 1,
  maxErrorRate: 0.5,
  minCodeLines: 1,
  maxCommentRatio: 0.8,
  detectHallucinations: true,
  rejectPlaceholders: true,
  customRules: [],
};

// ============================================================================
// LAYER 1: BLACKBOARD VALIDATOR -- Rule-based quality gates
// ============================================================================

export class BlackboardValidator {
  private config: ValidationConfig;

  constructor(config?: Partial<ValidationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config, customRules: [...(config?.customRules ?? DEFAULT_CONFIG.customRules)] };
  }

  // ---------- Public API ----------

  /**
   * Validate any entry by auto-detecting its type from the key prefix.
   */
  validate(key: string, value: unknown, metadata?: Record<string, unknown>): ValidationResult {
    const entryType = this.detectEntryType(key, value);

    switch (entryType) {
      case 'task':
        return this.validateTask(key, value);
      case 'result':
        return this.validateResult(key, value, metadata);
      case 'code':
        return this.validateCode(key, value);
      default:
        return this.validateGeneric(key, value);
    }
  }

  /**
   * Validate a task payload before dispatching.
   */
  validateTask(key: string, value: unknown): ValidationResult {
    const issues: ValidationIssue[] = [];
    const rulesApplied: string[] = [];

    const obj = value as Record<string, unknown> | null;
    if (!obj || typeof obj !== 'object') {
      return this.makeResult(false, 0, [
        { rule: 'task.structure', severity: 'error', message: 'Task value must be an object' },
      ], ['task.structure']);
    }

    // --- Rule: Instruction quality ---
    rulesApplied.push('task.instruction');
    const instruction = (obj.instruction as string) ?? '';
    if (typeof instruction !== 'string' || instruction.trim().length === 0) {
      issues.push({
        rule: 'task.instruction',
        severity: 'error',
        message: 'Task must have a non-empty instruction',
        field: 'instruction',
      });
    } else {
      if (instruction.length < this.config.minInstructionLength) {
        issues.push({
          rule: 'task.instruction.length',
          severity: 'error',
          message: `Instruction too short (${instruction.length} chars, minimum ${this.config.minInstructionLength})`,
          field: 'instruction',
          suggestion: 'Provide more specific details about what the task should accomplish',
        });
      }
      if (instruction.length > this.config.maxInstructionLength) {
        issues.push({
          rule: 'task.instruction.length',
          severity: 'error',
          message: `Instruction too long (${instruction.length} chars, maximum ${this.config.maxInstructionLength})`,
          field: 'instruction',
        });
      }

      // Detect vague instructions
      rulesApplied.push('task.instruction.quality');
      const vaguePatterns = /^(do it|fix it|make it work|do something|todo|tbd|placeholder|asdf|test123)/i;
      if (vaguePatterns.test(instruction.trim())) {
        issues.push({
          rule: 'task.instruction.quality',
          severity: 'error',
          message: 'Instruction appears to be a placeholder or too vague',
          field: 'instruction',
          suggestion: 'Provide a clear, specific instruction describing the task objective',
        });
      }
    }

    // --- Rule: Constraints ---
    if (this.config.requireConstraints) {
      rulesApplied.push('task.constraints');
      if (!obj.constraints || !Array.isArray(obj.constraints) || obj.constraints.length === 0) {
        issues.push({
          rule: 'task.constraints',
          severity: 'warning',
          message: 'Task has no constraints defined -- results may be unbounded',
          field: 'constraints',
          suggestion: 'Add constraints like time limits, scope boundaries, or quality thresholds',
        });
      }
    }

    // --- Rule: Expected output ---
    if (this.config.requireExpectedOutput) {
      rulesApplied.push('task.expectedOutput');
      if (!obj.expectedOutput) {
        issues.push({
          rule: 'task.expectedOutput',
          severity: 'warning',
          message: 'Task has no expectedOutput defined -- validation of results will be weaker',
          field: 'expectedOutput',
        });
      }
    }

    // --- Custom rules ---
    this.applyCustomRules('task', key, value, issues, rulesApplied);

    return this.makeResult(
      !issues.some(i => i.severity === 'error'),
      this.calculateScore(issues),
      issues,
      rulesApplied,
    );
  }

  /**
   * Validate a result/output before caching.
   */
  validateResult(key: string, value: unknown, metadata?: Record<string, unknown>): ValidationResult {
    const issues: ValidationIssue[] = [];
    const rulesApplied: string[] = [];

    // --- Rule: Non-null result ---
    rulesApplied.push('result.existence');
    if (value === null || value === undefined) {
      issues.push({
        rule: 'result.existence',
        severity: 'error',
        message: 'Result value is null or undefined',
      });
      return this.makeResult(false, 0, issues, rulesApplied);
    }

    // --- Rule: Result structure ---
    rulesApplied.push('result.structure');
    if (typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const fieldCount = Object.keys(obj).length;

      if (fieldCount < this.config.minResultFields) {
        issues.push({
          rule: 'result.structure',
          severity: 'warning',
          message: `Result has very few fields (${fieldCount}), expected at least ${this.config.minResultFields}`,
          suggestion: 'Ensure the result contains all expected output data',
        });
      }

      // --- Rule: Error result check ---
      rulesApplied.push('result.error_check');
      if (obj.error && !obj.data && !obj.result) {
        issues.push({
          rule: 'result.error_check',
          severity: 'error',
          message: 'Result contains only an error -- no useful data',
          field: 'error',
          suggestion: 'Retry the task or handle the error before caching',
        });
      }
    }

    // --- Rule: Placeholder/dummy data detection ---
    if (this.config.rejectPlaceholders) {
      rulesApplied.push('result.placeholders');
      const serialized = JSON.stringify(value);
      const placeholderPatterns = [
        /lorem ipsum/i,
        /foo\s*bar\s*baz/i,
        /^.*\bexample\.com\b.*$/im,
        /\b(?:TODO|FIXME|HACK|XXX)\b/,
        /placeholder/i,
        /dummy[_\s]?data/i,
        /sample[_\s]?data/i,
        /test123|abc123/i,
        /\b0{5,}\b/, // Long runs of zeros
        /\b1234567\b/, // Sequential numbers
      ];

      for (const pattern of placeholderPatterns) {
        if (pattern.test(serialized)) {
          issues.push({
            rule: 'result.placeholders',
            severity: 'error',
            message: `Result contains placeholder data (matched: ${pattern.source})`,
            suggestion: 'Ensure the result contains real, production-ready data',
          });
          break; // One flag is enough
        }
      }
    }

    // --- Rule: Hallucination detection ---
    if (this.config.detectHallucinations) {
      rulesApplied.push('result.hallucination');
      const hallucinationIssues = this.detectHallucinations(value, metadata);
      issues.push(...hallucinationIssues);
    }

    // --- Custom rules ---
    this.applyCustomRules('result', key, value, issues, rulesApplied);

    return this.makeResult(
      !issues.some(i => i.severity === 'error'),
      this.calculateScore(issues),
      issues,
      rulesApplied,
    );
  }

  /**
   * Validate code content before it enters the blackboard.
   */
  validateCode(key: string, value: unknown): ValidationResult {
    const issues: ValidationIssue[] = [];
    const rulesApplied: string[] = [];

    // Extract code string from various formats
    const code = this.extractCode(value);
    if (!code) {
      rulesApplied.push('code.extraction');
      issues.push({
        rule: 'code.extraction',
        severity: 'error',
        message: 'Could not extract code content from value',
        suggestion: 'Value should be a string or an object with a "code", "content", or "source" field',
      });
      return this.makeResult(false, 0, issues, rulesApplied);
    }

    const lines = code.split('\n');

    // --- Rule: Non-trivial code ---
    rulesApplied.push('code.length');
    const codeLines = lines.filter(l => l.trim().length > 0);
    if (codeLines.length < this.config.minCodeLines) {
      issues.push({
        rule: 'code.length',
        severity: 'warning',
        message: `Code is very short (${codeLines.length} non-empty lines)`,
      });
    }

    // --- Rule: Syntax marker checks ---
    rulesApplied.push('code.syntax');
    const syntaxIssues = this.checkCodeSyntax(code);
    issues.push(...syntaxIssues);

    // --- Rule: Comment ratio ---
    rulesApplied.push('code.comment_ratio');
    const commentLines = lines.filter(l => /^\s*(\/\/|#|\/\*|\*|"""|''')/.test(l));
    const ratio = codeLines.length > 0 ? commentLines.length / codeLines.length : 0;
    if (ratio > this.config.maxCommentRatio && codeLines.length > 5) {
      issues.push({
        rule: 'code.comment_ratio',
        severity: 'warning',
        message: `High comment-to-code ratio (${(ratio * 100).toFixed(0)}%) -- may be mostly comments`,
      });
    }

    // --- Rule: Dangerous patterns ---
    rulesApplied.push('code.dangerous_patterns');
    const dangerousPatterns = [
      { pattern: new RegExp('eval' + '\\s*\\('), name: 'eval()' },
      { pattern: /exec\s*\(/, name: 'exec()' },
      { pattern: /rm\s+-rf\s+\//, name: 'rm -rf /' },
      { pattern: /DROP\s+TABLE|DROP\s+DATABASE/i, name: 'SQL DROP statements' },
      { pattern: /process\.env\.\w+/, name: 'Direct env var access' },
      { pattern: /child_process/, name: 'child_process import' },
      { pattern: /require\s*\(\s*['"]child_process/, name: 'child_process require' },
      { pattern: /\.exec\s*\(\s*['"`].*\$\{/, name: 'Command injection via template literal' },
      { pattern: /(?:password|secret|api_key|token)\s*[:=]\s*['"][^'"]+['"]/i, name: 'Hardcoded credentials' },
    ];

    for (const { pattern, name } of dangerousPatterns) {
      if (pattern.test(code)) {
        issues.push({
          rule: 'code.dangerous_patterns',
          severity: 'error',
          message: `Code contains dangerous pattern: ${name}`,
          suggestion: 'Remove this pattern or provide explicit justification',
        });
      }
    }

    // --- Rule: Placeholder code detection ---
    if (this.config.rejectPlaceholders) {
      rulesApplied.push('code.placeholders');
      const placeholderCode = [
        /\/\/\s*TODO:?\s*implement/i,
        /pass\s*#\s*TODO/i,
        /throw\s+new\s+Error\s*\(\s*['"]Not implemented['"]/i,
        /raise\s+NotImplementedError/i,
        /console\.log\s*\(\s*['"]hello world['"]/i,
      ];
      for (const pattern of placeholderCode) {
        if (pattern.test(code)) {
          issues.push({
            rule: 'code.placeholders',
            severity: 'warning',
            message: 'Code contains placeholder/stub patterns -- may be incomplete',
            suggestion: 'Ensure all functions are fully implemented before submission',
          });
          break;
        }
      }
    }

    // --- Custom rules ---
    this.applyCustomRules('code', key, value, issues, rulesApplied);

    return this.makeResult(
      !issues.some(i => i.severity === 'error'),
      this.calculateScore(issues),
      issues,
      rulesApplied,
    );
  }

  /**
   * Validate a generic entry (not task, result, or code).
   */
  validateGeneric(key: string, value: unknown): ValidationResult {
    const issues: ValidationIssue[] = [];
    const rulesApplied: string[] = [];

    rulesApplied.push('generic.non_null');
    if (value === null || value === undefined) {
      issues.push({
        rule: 'generic.non_null',
        severity: 'error',
        message: 'Value must not be null or undefined',
      });
    }

    // Run custom rules that apply to 'any'
    this.applyCustomRules('any', key, value, issues, rulesApplied);

    return this.makeResult(
      !issues.some(i => i.severity === 'error'),
      this.calculateScore(issues),
      issues,
      rulesApplied,
    );
  }

  /**
   * Register a custom validation rule at runtime.
   */
  addRule(rule: CustomValidationRule): void {
    this.config.customRules.push(rule);
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(patch: Partial<ValidationConfig>): void {
    Object.assign(this.config, patch);
  }

  // ---------- Private helpers ----------

  private detectEntryType(key: string, value: unknown): 'task' | 'result' | 'code' | 'generic' {
    // Key-prefix-based detection
    if (/^task:/i.test(key)) return 'task';
    if (/^result:|^output:/i.test(key)) return 'result';
    if (/^code:|^source:|^file:/i.test(key)) return 'code';

    // Value-shape-based fallback
    if (typeof value === 'object' && value !== null) {
      const obj = value as Record<string, unknown>;
      if ('instruction' in obj) return 'task';
      if ('code' in obj || 'source' in obj) {
        const codeField = (obj.code ?? obj.source) as string;
        if (typeof codeField === 'string' && codeField.includes('\n') && codeField.length > 50) return 'code';
      }
    }

    return 'generic';
  }

  private extractCode(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null) {
      const obj = value as Record<string, unknown>;
      for (const field of ['code', 'source', 'content', 'body', 'text']) {
        if (typeof obj[field] === 'string') return obj[field] as string;
      }
      // Array of files
      if (Array.isArray(obj.files)) {
        return (obj.files as Array<{ content?: string }>)
          .map(f => f.content ?? '')
          .filter(Boolean)
          .join('\n\n');
      }
    }
    return null;
  }

  private checkCodeSyntax(code: string): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    // Unmatched brackets/braces/parens
    const opens = { '{': 0, '[': 0, '(': 0 };
    const closes: Record<string, keyof typeof opens> = { '}': '{', ']': '[', ')': '(' };
    let inString = false;
    let stringChar = '';

    for (let i = 0; i < code.length; i++) {
      const ch = code[i];

      // Skip string contents
      if (inString) {
        if (ch === stringChar && code[i - 1] !== '\\') inString = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true;
        stringChar = ch;
        continue;
      }
      // Skip single-line comments
      if (ch === '/' && code[i + 1] === '/') {
        while (i < code.length && code[i] !== '\n') i++;
        continue;
      }

      if (ch in opens) opens[ch as keyof typeof opens]++;
      if (ch in closes) opens[closes[ch]]--;
    }

    for (const [bracket, count] of Object.entries(opens)) {
      if (count !== 0) {
        const matchMap: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
        issues.push({
          rule: 'code.syntax',
          severity: 'error',
          message: `Unmatched bracket: ${count > 0 ? 'missing ' + matchMap[bracket] : 'extra ' + bracket} (${Math.abs(count)} unmatched)`,
          suggestion: 'Check bracket/brace/parenthesis matching',
        });
      }
    }

    return issues;
  }

  private detectHallucinations(value: unknown, metadata?: Record<string, unknown>): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    const serialized = JSON.stringify(value);

    // Pattern 1: Fake URLs with realistic-looking but invalid domains
    const fakeUrlPattern = /https?:\/\/(?:www\.)?[a-z]+(?:api|service|endpoint|docs)\.[a-z]{2,}\//gi;
    const urls = serialized.match(fakeUrlPattern) ?? [];
    for (const url of urls) {
      // Flag obviously fake API endpoints
      if (/example-api|fake-service|test-endpoint|placeholder-url/i.test(url)) {
        issues.push({
          rule: 'result.hallucination',
          severity: 'warning',
          message: `Potentially hallucinated URL detected: ${url}`,
          suggestion: 'Verify all URLs are real and accessible',
        });
      }
    }

    // Pattern 2: Suspicious precision in numeric data (too many decimal places)
    const suspiciousNumbers = serialized.match(/"[^"]*":\s*\d+\.\d{10,}/g);
    if (suspiciousNumbers && suspiciousNumbers.length > 3) {
      issues.push({
        rule: 'result.hallucination',
        severity: 'info',
        message: `Multiple values with unusual precision (${suspiciousNumbers.length} values with 10+ decimal places)`,
        suggestion: 'Verify numeric data comes from a real source -- excessive precision may indicate hallucination',
      });
    }

    // Pattern 3: Contradictory data within the same result
    if (typeof value === 'object' && value !== null) {
      const obj = value as Record<string, unknown>;

      // Revenue > total but expenses also > total
      if (typeof obj.revenue === 'number' && typeof obj.expenses === 'number' && typeof obj.total === 'number') {
        if (obj.revenue > (obj.total as number) && obj.expenses > (obj.total as number)) {
          issues.push({
            rule: 'result.hallucination',
            severity: 'warning',
            message: 'Contradictory numeric data: both revenue and expenses exceed total',
          });
        }
      }

      // Success: true but error field present
      if (obj.success === true && obj.error && typeof obj.error === 'string' && (obj.error as string).length > 0) {
        issues.push({
          rule: 'result.hallucination',
          severity: 'warning',
          message: 'Contradictory state: success=true but error field contains a message',
        });
      }
    }

    // Pattern 4: Repetitive content (copy-paste hallucination)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const values = Object.values(value as Record<string, unknown>)
        .filter(v => typeof v === 'string' && (v as string).length > 20);
      const unique = new Set(values.map(v => (v as string).toLowerCase().trim()));
      if (values.length >= 3 && unique.size < values.length * 0.5) {
        issues.push({
          rule: 'result.hallucination',
          severity: 'warning',
          message: `Highly repetitive content: ${values.length} string fields but only ${unique.size} unique values`,
          suggestion: 'Check if the agent is copying the same output across multiple fields',
        });
      }
    }

    // Pattern 5: Fabricated references (papers, docs)
    const fakeRefPatterns = [
      /arXiv:\d{4}\.\d{5,}/g,   // Fake arXiv IDs
      /doi:\s*10\.\d{4}/g,       // Fake DOIs
      /ISBN\s*\d{10,13}/g,       // Fake ISBNs
    ];
    for (const pattern of fakeRefPatterns) {
      const matches = serialized.match(pattern);
      if (matches && matches.length > 0) {
        issues.push({
          rule: 'result.hallucination',
          severity: 'info',
          message: `Result contains ${matches.length} academic reference(s) -- verify they are real`,
          suggestion: 'AI models commonly hallucinate paper titles, DOIs, and arXiv IDs',
        });
        break;
      }
    }

    return issues;
  }

  private applyCustomRules(
    entryType: string,
    key: string,
    value: unknown,
    issues: ValidationIssue[],
    rulesApplied: string[],
  ): void {
    for (const rule of this.config.customRules) {
      if (rule.appliesTo.includes(entryType) || rule.appliesTo.includes('any')) {
        rulesApplied.push(`custom:${rule.name}`);
        const issue = rule.validate(key, value);
        if (issue) issues.push(issue);
      }
    }
  }

  private calculateScore(issues: ValidationIssue[]): number {
    let score = 1.0;
    for (const issue of issues) {
      switch (issue.severity) {
        case 'error': score -= 0.3; break;
        case 'warning': score -= 0.1; break;
        case 'info': score -= 0.02; break;
      }
    }
    return Math.max(0, Math.min(1, score));
  }

  private makeResult(
    passed: boolean,
    score: number,
    issues: ValidationIssue[],
    rulesApplied: string[],
  ): ValidationResult {
    return {
      passed,
      score,
      issues,
      rulesApplied,
      timestamp: new Date().toISOString(),
      recoverable: issues.every(i => i.severity !== 'error' || i.suggestion !== undefined),
    };
  }
}

// ============================================================================
// LAYER 2: QUALITY GATE AGENT -- AI-assisted review
// ============================================================================

export class QualityGateAgent {
  private validator: BlackboardValidator;
  private quarantine: Map<string, { key: string; value: unknown; issues: ValidationIssue[]; submittedBy: string; timestamp: string }> = new Map();
  private reviewCallback?: AIReviewCallback;
  private metrics = {
    totalChecked: 0,
    approved: 0,
    rejected: 0,
    quarantined: 0,
    aiReviewed: 0,
  };

  /** Quality score threshold: entries below this go to AI review or quarantine */
  private qualityThreshold: number;
  /** Score below which entries are auto-rejected (no AI review) */
  private autoRejectThreshold: number;
  /** Whether to invoke AI review for borderline entries */
  private aiReviewEnabled: boolean;

  constructor(options?: {
    validationConfig?: Partial<ValidationConfig>;
    qualityThreshold?: number;
    autoRejectThreshold?: number;
    aiReviewCallback?: AIReviewCallback;
  }) {
    this.validator = new BlackboardValidator(options?.validationConfig);
    this.qualityThreshold = options?.qualityThreshold ?? 0.7;
    this.autoRejectThreshold = options?.autoRejectThreshold ?? 0.3;
    this.reviewCallback = options?.aiReviewCallback;
    this.aiReviewEnabled = !!options?.aiReviewCallback;
  }

  /**
   * Gate an entry -- validate, optionally send for AI review, and decide.
   *
   * Call this before writing to the blackboard. Returns a decision:
   * - 'approve': safe to write
   * - 'reject': do not write, return error to submitting agent
   * - 'quarantine': stored separately for human/senior-agent review
   * - 'needs_review': requires AI review (only if callback is set)
   */
  async gate(
    key: string,
    value: unknown,
    sourceAgent: string,
    metadata?: Record<string, unknown>
  ): Promise<QualityGateResult> {
    this.metrics.totalChecked++;

    // Layer 1: Rule-based validation
    const validation = this.validator.validate(key, value, metadata);
    const reviewNotes: string[] = [];

    // Auto-reject: too many hard errors
    if (validation.score < this.autoRejectThreshold) {
      this.metrics.rejected++;
      reviewNotes.push(`Auto-rejected: score ${validation.score.toFixed(2)} below threshold ${this.autoRejectThreshold}`);
      return {
        decision: 'reject',
        validation,
        reviewNotes,
      };
    }

    // Clean pass: no issues, high quality
    if (validation.passed && validation.score >= this.qualityThreshold) {
      this.metrics.approved++;
      reviewNotes.push(`Approved: score ${validation.score.toFixed(2)}, ${validation.rulesApplied.length} rules passed`);
      return {
        decision: 'approve',
        validation,
        reviewNotes,
      };
    }

    // Borderline: send for AI review if available
    if (this.aiReviewEnabled && this.reviewCallback) {
      this.metrics.aiReviewed++;
      reviewNotes.push(`Borderline score ${validation.score.toFixed(2)} -- sending for AI review`);

      try {
        const entryType = this.detectEntryType(key, value);
        const aiResult = await this.reviewCallback(key, value, entryType, {
          sourceAgent,
          validation,
        });

        reviewNotes.push(`AI review: ${aiResult.approved ? 'APPROVED' : 'REJECTED'} (confidence: ${aiResult.confidence.toFixed(2)})`);
        reviewNotes.push(`AI feedback: ${aiResult.feedback}`);
        if (aiResult.suggestedFixes) {
          reviewNotes.push(`Suggested fixes: ${aiResult.suggestedFixes.join('; ')}`);
        }

        if (aiResult.approved && aiResult.confidence >= 0.6) {
          this.metrics.approved++;
          return {
            decision: 'approve',
            validation,
            reviewNotes,
            reviewedBy: 'ai_reviewer',
          };
        } else {
          // AI rejected or low confidence -- quarantine
          const qKey = this.addToQuarantine(key, value, validation.issues, sourceAgent);
          this.metrics.quarantined++;
          return {
            decision: 'quarantine',
            validation,
            quarantineKey: qKey,
            reviewNotes,
            reviewedBy: 'ai_reviewer',
          };
        }
      } catch (err) {
        reviewNotes.push(`AI review failed: ${err instanceof Error ? err.message : 'unknown error'}`);
        // Fall through to quarantine
      }
    }

    // No AI review available or AI review failed -- quarantine or reject based on severity
    if (validation.passed) {
      // Passed rules but low quality score -- quarantine for review
      const qKey = this.addToQuarantine(key, value, validation.issues, sourceAgent);
      this.metrics.quarantined++;
      reviewNotes.push(`Quarantined: passed rules but score ${validation.score.toFixed(2)} below quality threshold ${this.qualityThreshold}`);
      return {
        decision: 'quarantine',
        validation,
        quarantineKey: qKey,
        reviewNotes,
      };
    } else {
      // Hard rule failures -- reject
      this.metrics.rejected++;
      reviewNotes.push('Rejected: failed validation rules');
      return {
        decision: 'reject',
        validation,
        reviewNotes,
      };
    }
  }

  /**
   * Get all quarantined entries for manual review.
   */
  getQuarantined(): Array<{ quarantineId: string; key: string; value: unknown; issues: ValidationIssue[]; submittedBy: string; timestamp: string }> {
    return Array.from(this.quarantine.entries()).map(([id, entry]) => ({
      quarantineId: id,
      ...entry,
    }));
  }

  /**
   * Approve a quarantined entry -- returns the value for writing to the blackboard.
   */
  approveQuarantined(quarantineId: string): { key: string; value: unknown } | null {
    const entry = this.quarantine.get(quarantineId);
    if (!entry) return null;
    this.quarantine.delete(quarantineId);
    this.metrics.approved++;
    this.metrics.quarantined--;
    return { key: entry.key, value: entry.value };
  }

  /**
   * Reject and discard a quarantined entry.
   */
  rejectQuarantined(quarantineId: string): boolean {
    if (!this.quarantine.has(quarantineId)) return false;
    this.quarantine.delete(quarantineId);
    this.metrics.rejected++;
    this.metrics.quarantined--;
    return true;
  }

  /**
   * Get quality gate metrics.
   */
  getMetrics(): Readonly<typeof this.metrics> {
    return { ...this.metrics };
  }

  /**
   * Get the underlying validator for direct access (e.g., adding custom rules).
   */
  getValidator(): BlackboardValidator {
    return this.validator;
  }

  /**
   * Set or change the AI review callback at runtime.
   */
  setAIReviewCallback(callback: AIReviewCallback): void {
    this.reviewCallback = callback;
    this.aiReviewEnabled = true;
  }

  // ---------- Private helpers ----------

  private addToQuarantine(key: string, value: unknown, issues: ValidationIssue[], submittedBy: string): string {
    const id = `quarantine_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.quarantine.set(id, {
      key,
      value,
      issues,
      submittedBy,
      timestamp: new Date().toISOString(),
    });
    return id;
  }

  private detectEntryType(key: string, value: unknown): string {
    if (/^task:.*:pending|^task:.*:instruction/i.test(key)) return 'task';
    if (/^task:.*:result|^result:|^output:/i.test(key)) return 'result';
    if (/^code:|^source:|^file:/i.test(key)) return 'code';
    return 'generic';
  }
}
