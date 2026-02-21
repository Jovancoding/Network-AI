/**
 * 05-code-review-swarm.ts
 * ───────────────────────
 * 6 real LLM agents do a parallel code review of a buggy auth service.
 *
 * Architecture:
 *   Wave   (parallel): 5 specialist reviewers — security, performance,
 *                       reliability, testing, architecture
 *   Final             : 1 coordinator — "top 3 blockers before you ship"
 *
 * Each agent makes a real gpt-5.2 call.
 * Findings are coordinated through SharedBlackboard.
 *
 * Run:
 *   npx ts-node examples/05-code-review-swarm.ts
 *
 * API key:
 *   $env:OPENAI_API_KEY = Read-Host -MaskInput "API Key"
 */

import OpenAI from 'openai';
import * as readline from 'readline';
import {
  createSwarmOrchestrator,
  CustomAdapter,
  SharedBlackboard,
} from '..';

// ─── Input types ─────────────────────────────────────────────────────────────
type InputMode = 'code' | 'design' | 'custom';
interface SwarmInput {
  content   : string;
  label     : string;
  mode      : InputMode;
  customRole?: string;
}

// ─── Interactive input prompt (4 modes) ──────────────────────────────────────
function promptForInput(c: Record<string, string>): Promise<SwarmInput> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log(`\n  ${c.bold}What should the swarm review?${c.reset}`);
    console.log(`  ${c.dim}[1]  Built-in example  (auth-service.ts — 5 deliberate bugs)${c.reset}`);
    console.log(`  ${c.dim}[2]  Paste your own code          ${c.reset}${c.dim}(TypeScript, Python, Go, any language)${c.reset}`);
    console.log(`  ${c.dim}[3]  Paste a system design doc    ${c.reset}${c.dim}(architecture, API spec, DB schema, deployment plan)${c.reset}`);
    console.log(`  ${c.dim}[4]  Custom role                  ${c.reset}${c.dim}(proposal, policy, email, report — any content, any reviewer)${c.reset}`);
    console.log();

    /** Collect lines until user types "end", then resolve. */
    const pasteLines = (mode: InputMode, label: string, customRole?: string) => {
      const lines: string[] = [];
      rl.on('line', line => {
        if (line.trim().toUpperCase() === 'END') {
          rl.close();
          resolve({ content: lines.join('\n'), label, mode, customRole });
        } else {
          lines.push(line);
        }
      });
    };

    rl.question(`  ${c.bold}Choice [1/2/3/4]:${c.reset} `, choice => {
      const ch = choice.trim();

      if (ch !== '2' && ch !== '3' && ch !== '4') {
        // Default: built-in example
        rl.close();
        resolve({ content: CODE_UNDER_REVIEW, label: 'auth-service.ts (built-in)', mode: 'code' });
        return;
      }

      if (ch === '3') {
        console.log(`\n  ${c.dim}Paste your system design doc or API spec below.`);
        console.log(`  ${c.dim}(architecture overview, API spec, DB schema, deployment plan, infra doc, etc.)`);
        console.log(`  ${c.reset}${c.bold}When finished, type  end  on its own new line and press Enter:${c.reset}`);
        console.log(`  ${c.dim}  ┌─ example ──────────────────────┐`);
        console.log(`  ${c.dim}  │  ... last line of your doc ... │`);
        console.log(`  ${c.dim}  │  end                           │`);
        console.log(`  ${c.dim}  └────────────────────────────────┘${c.reset}\n`);
        pasteLines('design', 'system design doc');
        return;
      }

      if (ch === '4') {
        rl.question(
          `\n  ${c.bold}Your reviewer role (e.g. "VP of Sales reviewing a junior SDR's proposal"):${c.reset} `,
          roleDesc => {
            console.log(`\n  ${c.dim}Paste your content below.`);
            console.log(`  ${c.dim}(proposal, business plan, policy doc, email, report, job description, marketing copy, etc.)`);
            console.log(`  ${c.reset}${c.bold}When finished, type  end  on its own new line and press Enter:${c.reset}`);
            console.log(`  ${c.dim}  ┌─ example ──────────────────────┐`);
            console.log(`  ${c.dim}  │  ... last line of content ...  │`);
            console.log(`  ${c.dim}  │  end                           │`);
            console.log(`  ${c.dim}  └────────────────────────────────┘${c.reset}\n`);
            pasteLines('custom', 'custom content', roleDesc.trim());
          }
        );
        return;
      }

      // [2] Own code
      console.log(`\n  ${c.dim}Paste your code below.`);
      console.log(`  ${c.dim}(TypeScript, JavaScript, Python, Go, Java, SQL, shell script, etc.)`);
      console.log(`  ${c.reset}${c.bold}When finished, type  end  on its own new line and press Enter:${c.reset}`);
      console.log(`  ${c.dim}  ┌─ example ──────────────────────┐`);
      console.log(`  ${c.dim}  │  ... last line of your code .. │`);
      console.log(`  ${c.dim}  │  end                           │`);
      console.log(`  ${c.dim}  └────────────────────────────────┘${c.reset}\n`);
      pasteLines('code', 'custom code');
    });
  });
}

// ─── Content / mode mismatch guard ─────────────────────────────────────────
async function warnIfMismatch(mode: InputMode, content: string, colors: Record<string, string>): Promise<void> {
  const lower = content.toLowerCase();
  const looksLikeCode =
    // keywords that are unambiguous on their own
    /\b(function\s*\(|function\s+\w+|class\s+\w+|import\s+[\w{*]|export\s+(default|function|class|const|async))\b/.test(lower) ||
    // assignment keywords — must be followed by identifier + =
    /\b(const|let|var)\s+\w+[\w\s,]*\s*=/.test(lower) ||
    // function-def patterns across languages
    /\b(def|fn|func)\s+\w+\s*\(/.test(lower) ||
    // async/await in code context (await expression, not "await your reply")
    /\bawait\s+\w+\s*[\.(]/.test(lower) ||
    // interface / struct with body
    /\b(interface|struct)\s+\w+\s*\{/.test(lower) ||
    // lots of braces = almost certainly code
    (content.match(/\{/g)?.length ?? 0) > 5;
  const looksLikeTechnical =
    /\b(service|api|endpoint|database|schema|component|architecture|deploy|infrastructure|scalab|queue|cache|auth|load.?balanc|microservice|latency|throughput|replica|partition|shard)\b/.test(lower);

  let message   = '';
  let suggestion = '';

  if (mode === 'code' && !looksLikeCode) {
    message    = `⚠  This doesn't look like code.`;
    suggestion = `For documents, proposals, or non-technical content use [3] or [4].`;
  } else if (mode === 'design' && looksLikeCode) {
    message    = `⚠  This looks like code, not a design doc.`;
    suggestion = `For code review use [1] or [2] — they have security, performance, and architecture angles built in.`;
  } else if (mode === 'design' && !looksLikeTechnical) {
    message    = `⚠  This doesn't look like a technical design doc.`;
    suggestion = `For non-technical content (proposals, plans, emails) use [4] with a matching reviewer role.`;
  } else if (mode === 'custom' && looksLikeCode) {
    message    = `⚠  This looks like code.`;
    suggestion = `For specialist code review use [1] or [2] — they have security, performance, and architecture angles built in.`;
  }

  if (!message) return;

  console.log(`\n  ${colors.yellow}${colors.bold}${message}${colors.reset}`);
  console.log(`  ${colors.dim}   ${suggestion}${colors.reset}\n`);

  await new Promise<void>(resolvePrompt => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`  ${colors.bold}Continue anyway? [y/N]:${colors.reset} `, answer => {
      rl.close();
      if (answer.trim().toLowerCase() !== 'y') {
        console.log(`\n  ${colors.dim}Cancelled — re-run and choose the right mode.${colors.reset}\n`);
        process.exit(0);
      }
      resolvePrompt();
    });
  });
}

// ─── Guard: require API key upfront ──────────────────────────────────────────
const API_KEY = process.env.OPENAI_API_KEY ?? '';
if (!API_KEY) {
  console.error(
    '\n[ERROR] OPENAI_API_KEY is not set.\n' +
    '  PowerShell:  $env:OPENAI_API_KEY = Read-Host -MaskInput "API Key"\n' +
    '  bash/zsh:    export OPENAI_API_KEY=sk-...\n' +
    '  .env file:   copy .env.example to .env and add your key\n'
  );
  process.exit(1);
}

const openai = new OpenAI({ apiKey: API_KEY });

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const c = {
  reset   : '\x1b[0m',
  bold    : '\x1b[1m',
  dim     : '\x1b[2m',
  cyan    : '\x1b[36m',
  green   : '\x1b[32m',
  yellow  : '\x1b[33m',
  red     : '\x1b[31m',
  blue    : '\x1b[34m',
  magenta : '\x1b[35m',
  white   : '\x1b[37m',
};

const SEV: Record<string, string> = {
  CRITICAL : `${c.bold}${c.red}CRITICAL${c.reset}`,
  HIGH     : `${c.bold}${c.yellow}HIGH    ${c.reset}`,
  MEDIUM   : `${c.bold}${c.cyan}MEDIUM  ${c.reset}`,
  LOW      : `${c.bold}${c.dim}LOW     ${c.reset}`,
};

const banner  = (msg: string) =>
  console.log(`\n${c.bold}${c.cyan}===  ${msg}  ===${c.reset}`);

// ─── Stage pipeline indicator ────────────────────────────────────────────────
const STAGES = ['Input', 'Reviewing', 'Fixing', 'Merging'];
function stageBar(active: number) {
  const parts = STAGES.map((name, i) => {
    if (i < active)  return `${c.green}✓ ${name}${c.reset}`;
    if (i === active) return `${c.bold}${c.yellow}● ${name}${c.reset}`;
    return `${c.dim}○ ${name}${c.reset}`;
  });
  console.log(`\n  ${parts.join(`  ${c.dim}→${c.reset}  `)}\n`);
}

const tag     = (id: string, color: string) =>
  `${color}[${id.padEnd(12)}]${c.reset}`;
const agent   = (id: string, msg: string) =>
  console.log(`  ${tag(id, c.blue)} ${msg}`);
const divider = () =>
  console.log(`  ${c.dim}${'─'.repeat(64)}${c.reset}`);
const sleep   = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function decodeHtml(s: string): string {
  // &amp; MUST go first so double-encoded sequences (&amp;#x27; → &#x27; → ')
  // are resolved in the same chain pass. Run twice to catch any triple-encoding.
  const once = (x: string) => x
    .replace(/&amp;/g,  '&')   // first — unlocks double-encoded entities
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g,  "'")
    .replace(/&#x60;/g, '`')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&vert;/g, '|')   // || operator
    .replace(/&#x7C;/g, '|')
    .replace(/&quest;/g,'?')   // ?? operator
    .replace(/&#x3F;/g, '?')
    .replace(/&amp;/g,  '&');  // second pass catches any remaining &amp;
  return once(once(s));         // two passes handles double → triple encoding
}

function extractContent(resp: any): string {
  const msg = resp?.choices?.[0]?.message;
  if (!msg) return '';
  if (typeof msg.content === 'string' && msg.content.length > 0) return msg.content;
  if (Array.isArray(msg.content)) {
    const parts = msg.content
      .filter((p: any) => p?.type === 'text' || p?.type === 'output_text')
      .map((p: any) => p.text ?? '')
      .join('\n');
    if (parts.length > 0) return parts;
  }
  if (typeof msg.refusal === 'string' && msg.refusal.length > 0)
    return `[refused] ${msg.refusal}`;
  return '';
}

// ─── The code under review ────────────────────────────────────────────────────
// A realistic but deliberately buggy TypeScript auth service (condensed).
const CODE_UNDER_REVIEW = `
// auth-service.ts
import { db } from './database';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'supersecret123';         // hardcoded
const SESSIONS: Record<string, string> = {}; // unbounded in-memory store

export async function login(username: string, password: string) {
  const user = await db.query(
    \`SELECT * FROM users WHERE username = '\${username}' AND password = '\${password}'\`
  );
  if (!user.rows.length) return { error: 'Invalid credentials' };
  const token = jwt.sign({ id: user.rows[0].id, role: user.rows[0].role }, JWT_SECRET);
  SESSIONS[user.rows[0].id] = token;
  return { token };
}

export async function getUserData(userId: string, requesterId: string) {
  const result = await db.query(\`SELECT * FROM users WHERE id = \${userId}\`);
  return result.rows[0]; // no authz check — any user can read any user
}

export async function resetPassword(email: string) {
  const token = Math.random().toString(36).slice(2); // weak token, no expiry
  await db.query(\`UPDATE users SET reset_token = '\${token}' WHERE email = '\${email}'\`);
  sendEmail(email, \`https://app.example.com/reset?token=\${token}\`);
}

export async function changePassword(userId: string, newPassword: string) {
  // no old password check, no complexity, stored plaintext
  await db.query(\`UPDATE users SET password = '\${newPassword}' WHERE id = '\${userId}'\`);
}
`.trim();

// ─── 5 reviewer agents ────────────────────────────────────────────────────────
const REVIEWERS = [
  {
    id    : 'sec_review',
    label : 'Security',
    angle : 'security vulnerabilities: SQL injection, auth bypass, token weaknesses, insecure crypto, privilege escalation',
    color : c.red,
  },
  {
    id    : 'perf_review',
    label : 'Performance',
    angle : 'performance issues: N+1 queries, missing indexes, unbounded queries, synchronous blocking, memory leaks',
    color : c.yellow,
  },
  {
    id    : 'rel_review',
    label : 'Reliability',
    angle : 'reliability issues: missing error handling, no timeouts, unhandled rejections, race conditions, data loss risks',
    color : c.cyan,
  },
  {
    id    : 'test_review',
    label : 'Testing',
    angle : 'testability and test coverage gaps: untestable design, missing edge case tests, side effects, no mocks',
    color : c.magenta,
  },
  {
    id    : 'arch_review',
    label : 'Architecture',
    angle : 'architecture and design: separation of concerns, coupling, scalability limits, maintainability, tech debt',
    color : c.green,
  },
];

// ─── 5 generic reviewer agents (custom role mode — any content type) ───────────
const CUSTOM_REVIEWERS = [
  {
    id    : 'clarity_review',
    label : 'Clarity',
    angle : 'clarity and communication: is it easy to understand, well-structured, free of ambiguity, jargon, or confusing phrasing',
    color : c.cyan,
  },
  {
    id    : 'completeness_review',
    label : 'Completeness',
    angle : 'completeness: missing sections, unanswered questions, gaps in reasoning, unstated assumptions, or missing context',
    color : c.yellow,
  },
  {
    id    : 'accuracy_review',
    label : 'Accuracy',
    angle : 'accuracy: incorrect facts, unsupported claims, logical inconsistencies, contradictions, or outdated information',
    color : c.red,
  },
  {
    id    : 'risk_review',
    label : 'Risk',
    angle : 'risks and downsides: what could go wrong, unintended consequences, blind spots, or decisions that may backfire',
    color : c.magenta,
  },
  {
    id    : 'improvement_review',
    label : 'Improvement',
    angle : 'overall effectiveness: what could be stronger, more persuasive, better evidenced, or more actionable',
    color : c.green,
  },
];

// ─── 5 design-doc reviewer agents ────────────────────────────────────────────
const DESIGN_REVIEWERS = [
  {
    id    : 'scale_review',
    label : 'Scalability',
    angle : 'scalability: throughput bottlenecks, horizontal scaling limits, stateful components, data partitioning, hot-spots',
    color : c.yellow,
  },
  {
    id    : 'sec_review',
    label : 'Security',
    angle : 'security: attack surface, trust boundary violations, sensitive data flows, auth model weaknesses, privilege escalation paths',
    color : c.red,
  },
  {
    id    : 'ops_review',
    label : 'Operability',
    angle : 'operability: observability gaps, deployment complexity, failure modes, missing runbook steps, on-call burden',
    color : c.cyan,
  },
  {
    id    : 'con_review',
    label : 'Consistency',
    angle : 'data consistency: race conditions, distributed state hazards, eventual vs strong consistency trade-offs, dual-write risks',
    color : c.magenta,
  },
  {
    id    : 'sim_review',
    label : 'Simplicity',
    angle : 'simplicity: accidental complexity, over-engineering, maintainability burden, cognitive load for new engineers',
    color : c.green,
  },
];

// ─── Format a reviewer's raw output into structured finding lines ─────────────
function printFindings(label: string, color: string, raw: string) {
  const decoded = decodeHtml(raw);
  console.log(`\n  ${color}${c.bold}[${label}]${c.reset}`);
  const lines = decoded.split('\n').filter(l => l.trim().length > 0);
  for (const line of lines) {
    const trimmed = line.trim();
    const sevMatch = trimmed.match(/^\[?(CRITICAL|HIGH|MEDIUM|LOW)\]?[:\s-]*/i);
    if (sevMatch) {
      const sev     = sevMatch[1].toUpperCase() as keyof typeof SEV;
      const rest    = trimmed.slice(sevMatch[0].length).trim();
      // Split on  |  Fix:  into two lines
      const fixIdx  = rest.indexOf('|');
      if (fixIdx !== -1) {
        const issue = rest.slice(0, fixIdx).trim();
        const fix   = rest.slice(fixIdx + 1).trim();
        console.log(`    ${SEV[sev] ?? sev}  ${issue}`);
        console.log(`    ${c.dim}         ${fix}${c.reset}`);
      } else {
        console.log(`    ${SEV[sev] ?? sev}  ${rest}`);
      }
    } else {
      console.log(`    ${c.dim}${trimmed}${c.reset}`);
    }
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  banner('network-ai -- Code Review Swarm');
  console.log();
  console.log(`  ${c.yellow}${c.bold}DEMO${c.reset}  ${c.dim}This is a demonstration of the Network-AI multi-agent framework.${c.reset}`);
  console.log(`  ${c.dim}      Results are generated by LLMs and are for illustrative purposes only.${c.reset}`);
  console.log(`  ${c.dim}      Do not rely on output for production, legal, medical, or financial decisions.${c.reset}`);
  console.log(`  ${c.dim}      Source: https://github.com/agentience/network-ai${c.reset}`);

  const { content, label: codeLabel, mode, customRole } = await promptForInput(c);

  await warnIfMismatch(mode, content, c);

  const lineCount = content.split('\n').length;

  const activeReviewers = mode === 'design' ? DESIGN_REVIEWERS : mode === 'custom' ? CUSTOM_REVIEWERS : REVIEWERS;
  const reviewMode =
    mode === 'design' ? 'Design review' :
    mode === 'custom' ? `Custom review — ${customRole ?? 'custom role'}` :
    'Code review';

  console.log();
  console.log(`  ${c.dim}File : ${codeLabel}  (${lineCount} lines)${c.reset}`);
  console.log(`  ${c.dim}Mode : ${reviewMode}${c.reset}`);
  const agentCount = mode !== 'design'
    ? (activeReviewers.length + ' reviewers + ' + activeReviewers.length + ' fixers + 1 merger')
    : (activeReviewers.length + ' reviewers + 1 coordinator');
  console.log(`  ${c.dim}Model: gpt-5.2  |  Agents: ${agentCount}  |  sequential${c.reset}`);
  stageBar(1); // ✓ Input  →  ● Reviewing  →  ○ Fixing  →  ○ Merging

  // ─── Blackboard + adapter ────────────────────────────────────────────────
  const blackboard = new SharedBlackboard(process.cwd());
  blackboard.registerAgent('orchestrator', 'tok-orch',  ['*']);
  blackboard.registerAgent('coordinator',  'tok-coord', ['review:', 'verdict:']);
  blackboard.registerAgent('merger',       'tok-merger', ['review:', 'fix:', 'verdict:']);
  for (const r of activeReviewers) {
    blackboard.registerAgent(r.id, `tok-${r.id}`, ['review:']);
    if (mode !== 'design') {
      const fid = r.id.replace('_review', '_fixer');
      blackboard.registerAgent(fid, 'tok-' + fid, ['fix:']);
    }
  }

  const adapter = new CustomAdapter();

  // ─── Spinner state (shared between handlers and main loop) ───────────────
  const FRAMES = ['⠋','⠙','⠸','⢰','⣠','⣄','⡆','⠇'];
  let   spinFrame = 0;

  type AgentSt = { status: 'waiting'|'running'|'done'; findings: string; ms: number };
  const agentState = new Map<string, AgentSt>(
    activeReviewers.map(r => [r.id, { status: 'waiting', findings: '', ms: 0 }])
  );

  function countFindings(raw: string) {
    return raw.split('\n').filter(l => /^\[?(CRITICAL|HIGH|MEDIUM|LOW)/i.test(l.trim())).length;
  }

  function renderBoard() {
    process.stdout.write(`\x1b[${activeReviewers.length}A`); // move up
    for (const r of activeReviewers) {
      const st = agentState.get(r.id)!;
      const icon =
        st.status === 'waiting' ? `${c.dim}·${c.reset}` :
        st.status === 'running' ? `${c.cyan}${FRAMES[spinFrame % FRAMES.length]}${c.reset}` :
                                  `${c.green}✓${c.reset}`;
      const detail =
        st.status === 'waiting' ? `${c.dim}waiting${c.reset}` :
        st.status === 'running' ? `${c.dim}analyzing...${c.reset}` :
        st.findings
          ? `${c.green}${countFindings(st.findings)} findings${c.reset}  ${c.dim}${(st.ms / 1000).toFixed(1)}s${c.reset}`
          : `${c.dim}(no findings)${c.reset}`;
      process.stdout.write(`\x1b[2K  ${icon}  ${r.color}${r.label.padEnd(14)}${c.reset}  ${detail}\n`);
    }
    spinFrame++;
  }

  // ─── Fixer board state (Wave 2) ──────────────────────────────────────────
  type FixerSt = { status: 'waiting'|'running'|'done'; nChanges: number; ms: number };
  const fixerState = new Map<string, FixerSt>();

  function renderFixerBoard(fixers: Array<{ id: string; label: string; color: string }>) {
    process.stdout.write(`\x1b[${fixers.length}A`);
    for (const fr of fixers) {
      const fid = fr.id.replace('_review', '_fixer');
      const st  = fixerState.get(fid) ?? { status: 'waiting' as const, nChanges: 0, ms: 0 };
      const icon =
        st.status === 'waiting' ? `${c.dim}·${c.reset}` :
        st.status === 'running' ? `${c.cyan}${FRAMES[spinFrame % FRAMES.length]}${c.reset}` :
                                  `${c.green}✓${c.reset}`;
      const detail =
        st.status === 'waiting' ? `${c.dim}waiting${c.reset}` :
        st.status === 'running' ? `${c.dim}patching...${c.reset}` :
        st.nChanges > 0
          ? `${c.green}${st.nChanges} patch${st.nChanges !== 1 ? 'es' : ''}${c.reset}  ${c.dim}${(st.ms / 1000).toFixed(1)}s${c.reset}`
          : `${c.dim}(no changes)${c.reset}`;
      process.stdout.write(`\x1b[2K  ${icon}  ${fr.color}${fr.label.padEnd(14)}${c.reset}  ${detail}\n`);
    }
    spinFrame++;
  }

  // Shared rate-limit state: set by each handler from response headers,
  // read by the sequential dispatch loop to wait exactly as long as needed.
  let nextCallAfterMs = 0;

  /** Parse OpenAI reset header strings like "1s", "500ms", "1m30s" into ms. */
  function parseResetMs(header: string | null): number {
    if (!header) return 0;
    let ms = 0;
    const mMatch  = header.match(/(\d+)m/);  if (mMatch)  ms += parseInt(mMatch[1])  * 60_000;
    const sMatch  = header.match(/(\d+(?:\.\d+)?)s/); if (sMatch)  ms += parseFloat(sMatch[1]) * 1_000;
    const msMatch = header.match(/(\d+)ms/); if (msMatch) ms += parseInt(msMatch[1]);
    return Math.ceil(ms);
  }

  // ─── Prompt builders (mode-aware) ────────────────────────────────────────
  function buildPrompts(angle: string): { SYSTEM: string; USER: string } {
    if (mode === 'design') {
      return {
        SYSTEM:
          'You are a senior software architect reviewing a system design document.\n' +
          'For each concern you identify, output one line in this exact format:\n' +
          '[SEVERITY] Short description of concern  |  Fix: one-line recommendation\n' +
          'SEVERITY is one of: CRITICAL, HIGH, MEDIUM, LOW\n' +
          'Identify 3-5 concerns. Be specific about which component or decision.\n' +
          'Focus only on real architectural risks — do not invent problems.',
        USER:
          `Review the following system design document from a ${angle} perspective.\n\n` +
          `\`\`\`\n${content}\n\`\`\``,
      };
    }
    const rolePrefix = mode === 'custom' && customRole
      ? `You are ${customRole}.\n`
      : 'You are a senior code reviewer.\n';
    return {
      SYSTEM:
        rolePrefix +
        'For each issue you find, output one line in this exact format:\n' +
        '[SEVERITY] Short description of issue  |  Fix: one-line fix\n' +
        'SEVERITY is one of: CRITICAL, HIGH, MEDIUM, LOW\n' +
        'Find 3-5 issues. Be specific about line numbers when relevant.\n' +
        'Focus only on real issues — do not invent problems.',
      USER:
        `Review the following content from a ${angle} perspective.\n\n` +
        `\`\`\`\n${content}\n\`\`\``,
    };
  }

  // ─── Register reviewer handlers ──────────────────────────────────────────
  for (const { id, label, angle } of activeReviewers) {
    adapter.registerHandler(id, async (_payload) => {
      agentState.set(id, { status: 'running', findings: '', ms: 0 });
      const t0 = Date.now();

      const { SYSTEM, USER } = buildPrompts(angle);

      try {
        const { data: resp, response: httpResp } = await openai.chat.completions.create({
          model   : 'gpt-5.2',
          messages : [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }],
          max_completion_tokens: 400,
          temperature          : 0.4,
        }).withResponse();

        const remaining = parseInt(httpResp.headers.get('x-ratelimit-remaining-requests') ?? '99');
        if (remaining <= 1) {
          nextCallAfterMs = parseResetMs(httpResp.headers.get('x-ratelimit-reset-requests')) + 500;
        } else {
          nextCallAfterMs = 0;
        }

        const finish  = resp?.choices?.[0]?.finish_reason ?? 'none';
        const findings = decodeHtml(extractContent(resp));
        const ms = Date.now() - t0;

        if (!findings) {
          agentState.set(id, { status: 'done', findings: `[empty — finish_reason: ${finish}]`, ms });
          return { label, findings: '', ms };
        }

        agentState.set(id, { status: 'done', findings, ms });
        blackboard.write(`review:${id}`, { label, angle, findings, ms }, id, 3600, `tok-${id}`);
        return { label, findings, ms };
      } catch (err: any) {
        const ms = Date.now() - t0;
        const msg = err?.message ?? String(err);
        agentState.set(id, { status: 'done', findings: `[error: ${msg}]`, ms });
        return { label, findings: '', ms };
      }
    });
  }

  // ─── Shared display config ────────────────────────────────────────────────
  const isDesign       = mode === 'design';
  const blockersHeader = isDesign ? '=== ARCHITECTURAL RISKS ===' : '=== SHIP BLOCKERS ===';
  const fixedHeader    = isDesign ? '=== REVISED DESIGN ==='      : '=== FIXED CODE ===';

  // ─── Design mode: single coordinator call ────────────────────────────────
  if (isDesign) {
    adapter.registerHandler('coordinator', async (payload) => {
      agent('coordinator', 'Synthesizing risks + rewriting design...');
      const allReviews = (payload.handoff?.context as any)?.reviews as Array<{ label: string; findings: string }> ?? [];
      const combined   = allReviews.map(r => '=== ' + r.label + ' Review ===\n' + r.findings).join('\n\n');
      const t0 = Date.now();
      const resp = await openai.chat.completions.create({
        model                : 'gpt-5.2',
        messages             : [
          { role: 'system', content:
              'You are a senior editor producing a revised version of the exact document the user submitted.\n' +
              'CRITICAL RULES — violating any of these is an error:\n' +
              '  1. Your output MUST be a rewritten version of the original document text below — nothing else.\n' +
              '  2. DO NOT invent a new document, a new example, or a replacement subject.\n' +
              '  3. DO NOT output code, TypeScript, JavaScript, Python, SQL, or any programming language.\n' +
              '  4. DO NOT output import statements, class definitions, function bodies, or variable declarations.\n' +
              '  5. Output plain prose or Markdown only — the same kind of document the user gave you, improved.' },
          { role: 'user',   content:
              '5 specialist reviewers analysed this document:\n\n' +
              '=== ORIGINAL DOCUMENT (rewrite THIS — do not replace it) ===\n' + content + '\n\n' +
              '=== SPECIALIST FINDINGS ===\n' + combined + '\n\n' +
              'Return JSON with two string keys:\n' +
              '  "blockers" — exactly three lines, each: #N  [SEVERITY]  one-line issue description\n' +
              '  "fixed"    — the complete rewritten document in plain prose / Markdown. ' +
              'Keep every section from the original. Improve weak sections based on the findings. ' +
              'After each improved section add a line: > **Change:** what was improved and why. ' +
              'PLAIN TEXT / MARKDOWN ONLY — absolutely no code, no import statements, no function definitions.' },
        ],
        max_completion_tokens: 32000,
        temperature          : 0.2,
        response_format      : { type: 'json_object' },
      });
      const finishReason = resp?.choices?.[0]?.finish_reason ?? 'unknown';
      const ms = Date.now() - t0;
      let verdict = '', fixed = '';
      try {
        const parsed = JSON.parse(extractContent(resp));
        verdict = decodeHtml(String(parsed.blockers ?? '').trim());
        fixed   = decodeHtml(String(parsed.fixed   ?? '').trim());
      } catch { /* keep empty */ }
      blackboard.write('verdict:final', { verdict, fixed, finishReason, reviewCount: allReviews.length, ms, generatedAt: new Date().toISOString() }, 'coordinator', 3600, 'tok-coord');
      return { verdict, fixed, finishReason, ms };
    });
  }

  // ─── Code / custom mode: Wave 2 fixers + Wave 3 merger ───────────────────
  if (!isDesign) {
    // 5 specialist fixers — each reads its reviewer's findings and applies targeted patches
    for (const { id, label, angle } of activeReviewers) {
      const fixId = id.replace('_review', '_fixer');
      adapter.registerHandler(fixId, async (_payload) => {
        fixerState.set(fixId, { status: 'running', nChanges: 0, ms: 0 });
        const reviewEntry = blackboard.read('review:' + id);
        const findings    = (reviewEntry?.value as any)?.findings ?? '';
        const t0 = Date.now();
        try {
          const resp = await openai.chat.completions.create({
            model                : 'gpt-5.2',
            messages             : [
              {
                role   : 'system',
                content: mode === 'custom'
                  ? 'You are a specialist editor focused only on ' + angle.split(':')[0] + ' improvements.\n' +
                    'Return a JSON object with key "changes": an array where each object has:\n' +
                    '  "fn"    — section or heading name\n' +
                    '  "issue" — one sentence: what was wrong or weak\n' +
                    '  "fixed" — complete revised version of that section.'
                  : 'You are a specialist code fixer focused only on ' + angle.split(':')[0] + ' issues.\n' +
                    'Return a JSON object with key "changes": an array where each object has:\n' +
                    '  "fn"    — function or block name\n' +
                    '  "issue" — one sentence: what was wrong\n' +
                    '  "fixed" — complete corrected function/block. Rules: single-quoted strings, no template literals, ' +
                    'always write the constructor keyword in TypeScript classes, ' +
                    'write || and && and ?? as literal characters (never omit or encode them), ' +
                    'write | for TypeScript union types (e.g. string | null), ' +
                    'semicolons between object/type literal members.',
              },
              {
                role   : 'user',
                content: mode === 'custom'
                  ? 'Original content:\n' + content + '\n\n' +
                    label + ' issues to improve:\n' + (findings || 'No issues — return { "changes": [] }')
                  : 'Original code:\n' + content + '\n\n' +
                    label + ' issues to fix:\n' + (findings || 'No issues — return { "changes": [] }'),
              },
            ],
            max_completion_tokens: 3000,
            temperature          : 0.1,
            response_format      : { type: 'json_object' },
          });
          const ms = Date.now() - t0;
          let changes: Array<{ fn: string; issue: string; fixed: string }> = [];
          try {
            const parsed = JSON.parse(extractContent(resp));
            changes = Array.isArray(parsed.changes) ? parsed.changes : [];
          } catch { /* keep empty */ }
          fixerState.set(fixId, { status: 'done', nChanges: changes.length, ms });
          blackboard.write('fix:' + id, { domain: label, changes, ms }, fixId, 3600, 'tok-' + fixId);
          return { domain: label, changes, ms };
        } catch (err: any) {
          const ms = Date.now() - t0;
          fixerState.set(fixId, { status: 'done', nChanges: 0, ms });
          blackboard.write('fix:' + id, { domain: label, changes: [], ms }, fixId, 3600, 'tok-' + fixId);
          return { domain: label, changes: [], ms };
        }
      });
    }

    // Merger: reads all 5 fix patches from blackboard, produces unified clean output
    adapter.registerHandler('merger', async (_payload) => {
      agent('merger', 'Merging all targeted patches into final unified output...');
      const allFixes = activeReviewers.map(r => {
        const entry = blackboard.read('fix:' + r.id);
        return (entry?.value as any) ?? { domain: r.label, changes: [] };
      });
      const t0 = Date.now();
      const resp = await openai.chat.completions.create({
        model                : 'gpt-5.2',
        messages             : [
          {
            role   : 'system',
            content:
              mode === 'custom'
                ? 'You are a lead editor incorporating 5 sets of targeted improvements into one final revised version.\n' +
                  'Apply ALL improvements. Where two improvements touch the same section, combine both.\n' +
                  'CRITICAL: Output plain prose or Markdown ONLY. DO NOT output code, TypeScript, JavaScript, SQL, ' +
                  'import statements, class definitions, function bodies, or any programming language.\n' +
                  'Return JSON with exactly two string keys:\n' +
                  '  "blockers" — top 3 most important improvements made, each: #N  [SEVERITY]  What was improved  (impact in 5 words)\n' +
                  '  "fixed"    — complete final revised version of the content in plain prose / Markdown. ' +
                  'After each changed section add a line: > **Change:** what was improved and why. ' +
                  'NO CODE — plain text / Markdown only.'
                : 'You are the lead engineer merging 5 targeted patch sets into one clean final file.\n' +
                  'Apply ALL patches. Where two patches touch the same function, combine both fixes.\n' +
                  'Return JSON with exactly two string keys:\n' +
                  '  "blockers" — top 3 most important fixes, each: #N  [SEVERITY]  What was fixed  (impact in 5 words)\n' +
                  '  "fixed"    — complete unified source file. Rules: no markdown fences, single-quoted strings, ' +
                  'no template literals, always write the constructor keyword in TypeScript classes, ' +
                  'write || and && and ?? as literal characters (never omit or encode them), ' +
                  'write | for TypeScript union types (e.g. string | null — never omit the pipe), ' +
                  'semicolons between object/type literal members, one // FIX: comment per changed block.',
          },
          {
            role   : 'user',
            content: mode === 'custom'
              ? 'Original content:\n' + content + '\n\nImprovement sets to merge:\n' + JSON.stringify(allFixes, null, 2)
              : 'Original code:\n' + content + '\n\nPatch sets to merge:\n' + JSON.stringify(allFixes, null, 2),
          },
        ],
        max_completion_tokens: 32000,
        temperature          : 0.1,
        response_format      : { type: 'json_object' },
      });
      const finishReason = resp?.choices?.[0]?.finish_reason ?? 'unknown';
      const ms           = Date.now() - t0;
      let verdict = '', fixed = '';
      try {
        const parsed = JSON.parse(extractContent(resp));
        verdict = decodeHtml(String(parsed.blockers ?? '').trim());
        fixed   = decodeHtml(String(parsed.fixed   ?? '').trim());
      } catch { /* keep empty */ }
      blackboard.write('verdict:final', { verdict, fixed, finishReason, reviewCount: activeReviewers.length, ms, generatedAt: new Date().toISOString() }, 'merger', 3600, 'tok-merger');
      return { verdict, fixed, finishReason, ms };
    });
  }

  // ─── Orchestrator ─────────────────────────────────────────────────────────
  const orchestrator = createSwarmOrchestrator({
    qualityThreshold: 0,
    trustLevels: [
      { agentId: 'orchestrator', trustLevel: 0.9, allowedNamespaces: ['*'],        allowedResources: ['*'] },
      { agentId: 'coordinator',  trustLevel: 0.9, allowedNamespaces: ['*'],        allowedResources: ['*'] },
      { agentId: 'merger',       trustLevel: 0.9, allowedNamespaces: ['*'],        allowedResources: ['*'] },
      ...activeReviewers.map(r => ({
        agentId          : r.id,
        trustLevel       : 0.8,
        allowedNamespaces: ['task:', 'review:'],
        allowedResources : ['EXTERNAL_SERVICE'],
      })),
      ...(!isDesign ? activeReviewers.map(r => ({
        agentId          : r.id.replace('_review', '_fixer'),
        trustLevel       : 0.8,
        allowedNamespaces: ['review:', 'fix:'],
        allowedResources : ['EXTERNAL_SERVICE'],
      })) : []),
    ],
  });
  await orchestrator.addAdapter(adapter);

  const ctx = { agentId: 'orchestrator', taskId: 'code-review-001', sessionId: 'cr-001' };
  const totalStart = Date.now();
  const collectedReviews: Array<{ label: string; findings: string; color: string }> = [];

  banner(`${activeReviewers.length} Reviewers`);
  console.log();
  console.log(`  ${c.yellow}⚡ Single API key — dispatching sequentially (RPM-limited)${c.reset}`);
  console.log(`  ${c.dim}   Speed depends on your provider, model tier, and API architecture.${c.reset}`);
  console.log(`  ${c.dim}   Multiple keys, a faster provider (Groq, gpt-4o-mini), or a local GPU${c.reset}`);
  console.log(`  ${c.dim}   enables true parallel dispatch and cuts this to ~8s.${c.reset}`);
  console.log();
  // Print initial status board (all waiting)
  for (const r of activeReviewers) {
    process.stdout.write(`  ${c.dim}·${c.reset}  ${r.color}${r.label.padEnd(14)}${c.reset}  ${c.dim}waiting${c.reset}\n`);
  }

  // Spinner interval — refreshes status board every 120ms
  const spinInterval = setInterval(renderBoard, 120);

  // Sequential dispatch with adaptive rate-limit gap
  for (let i = 0; i < activeReviewers.length; i++) {
    if (i > 0) {
      const wait = nextCallAfterMs > 0 ? nextCallAfterMs : 1000;
      await sleep(wait);
      nextCallAfterMs = 0;
    }
    const r = activeReviewers[i];
    await orchestrator.execute('delegate_task', {
      targetAgent: `custom:${r.id}`,
      taskPayload: {
        instruction   : r.angle,
        context       : { content },
        expectedOutput: '[SEVERITY] Issue  |  Fix: remedy',
      },
    }, ctx);
    const entry = blackboard.read(`review:${r.id}`);
    const val = entry?.value as { label: string; findings: string } | undefined;
    if (val?.findings) collectedReviews.push({ label: val.label, findings: val.findings, color: r.color });
  }

  // Silent retry for any blank agents (rate-limit hit on first call)
  const failed = activeReviewers.filter(r => !collectedReviews.find(cr => cr.label === r.label));
  if (failed.length > 0) {
    await sleep(12000);
    for (const r of failed) {
      await orchestrator.execute('delegate_task', {
        targetAgent: `custom:${r.id}`,
        taskPayload: {
          instruction   : r.angle,
          context       : { content },
          expectedOutput: '[SEVERITY] Issue  |  Fix: remedy',
        },
      }, ctx);
      const entry = blackboard.read(`review:${r.id}`);
      const val = entry?.value as { label: string; findings: string } | undefined;
      if (val?.findings) collectedReviews.push({ label: val.label, findings: val.findings, color: r.color });
      // Update agentState for board if retry succeeded
      const st = agentState.get(r.id)!;
      if (!st.findings && val?.findings) {
        agentState.set(r.id, { ...st, findings: val.findings });
      }
      await sleep(3000);
    }
  }

  clearInterval(spinInterval);
  renderBoard(); // final repaint — all ✓

  // ─── Print full findings ──────────────────────────────────────────────────
  for (const review of collectedReviews) {
    printFindings(review.label, review.color, review.findings);
  }

  divider();
  console.log(`  ${c.dim}${collectedReviews.length}/${activeReviewers.length} reviewers returned findings${c.reset}`);

  // ─── Wave 2: Targeted fixers (code / custom mode) ───────────────────────
  const finalBanner = isDesign ? 'ARCHITECTURAL RISKS' : mode === 'custom' ? 'KEY ISSUES' : 'SHIP BLOCKERS';
  const fixedBanner = isDesign ? 'REVISED DESIGN' : mode === 'custom' ? 'REVISED CONTENT' : 'FIXED CODE';

  if (!isDesign) {
    stageBar(2); // ✓ Reviewing  →  ● Fixing  →  ○ Merging
    banner(activeReviewers.length + ' Fixers');
    console.log();
    for (const r of activeReviewers) {
      const fid = r.id.replace('_review', '_fixer');
      fixerState.set(fid, { status: 'waiting', nChanges: 0, ms: 0 });
      process.stdout.write(`  ${c.dim}·${c.reset}  ${r.color}${r.label.padEnd(14)}${c.reset}  ${c.dim}waiting${c.reset}\n`);
    }
    const fixerSpinInterval = setInterval(() => renderFixerBoard(activeReviewers), 120);
    for (let i = 0; i < activeReviewers.length; i++) {
      if (i > 0) {
        const wait = nextCallAfterMs > 0 ? nextCallAfterMs : 1000;
        await sleep(wait);
        nextCallAfterMs = 0;
      }
      const r   = activeReviewers[i];
      const fid = r.id.replace('_review', '_fixer');
      await orchestrator.execute('delegate_task', {
        targetAgent: 'custom:' + fid,
        taskPayload: { instruction: r.angle, context: { content }, expectedOutput: '{ "changes": [] }' },
      }, ctx);
    }
    clearInterval(fixerSpinInterval);
    renderFixerBoard(activeReviewers);
  }

  // ─── Wave 3: Merger / Coordinator ────────────────────────────────────────
  stageBar(3); // ● Merging
  const mergeTarget = isDesign ? 'custom:coordinator' : 'custom:merger';
  const mergeLabel  = isDesign ? 'Synthesizing risks + rewriting design...' : 'Merging patches into unified output...';
  banner(isDesign ? 'Coordinator' : 'Merger');
  console.log();
  let coordFrame = 0;
  const coordSpin = setInterval(() => {
    process.stdout.write(`\r  ${c.cyan}${FRAMES[coordFrame % FRAMES.length]}${c.reset}  ${c.dim}${mergeLabel}${c.reset}  `);
    coordFrame++;
  }, 120);

  await orchestrator.execute('delegate_task', {
    targetAgent: mergeTarget,
    taskPayload: {
      instruction   : mergeLabel,
      context       : { reviews: collectedReviews },
      expectedOutput: '{ "blockers": "...", "fixed": "..." }',
    },
  }, ctx);

  clearInterval(coordSpin);
  process.stdout.write('\r\x1b[2K');

  const verdictEntry = blackboard.read('verdict:final');
  if (verdictEntry) {
    const val        = verdictEntry.value as { verdict: string; fixed: string; finishReason?: string; reviewCount: number; ms: number };
    const reviewType = isDesign ? 'architecture reviews' : 'specialist reviews';

    // ── Blockers
    banner(finalBanner);
    console.log(`  ${c.dim}Ready in ${val.ms} ms${c.reset}\n`);
    for (const line of val.verdict.split('\n').filter(Boolean)) {
      await sleep(400);
      const trimmed  = line.trim();
      const sevMatch = trimmed.match(/\[?(CRITICAL|HIGH|MEDIUM|LOW)\]?/i);
      if (sevMatch) {
        const sev  = sevMatch[1].toUpperCase() as keyof typeof SEV;
        const rest = trimmed.replace(/\[?(CRITICAL|HIGH|MEDIUM|LOW)\]?/i, SEV[sev] ?? sev);
        console.log(`  ${c.bold}${rest}${c.reset}`);
      } else {
        console.log(`  ${c.bold}${c.white}${trimmed}${c.reset}`);
      }
    }
    console.log();
    console.log(`  ${c.dim}Based on ${val.reviewCount}/${activeReviewers.length} ${reviewType}${c.reset}`);

    // ── Fixed output
    if (val.fixed && val.fixed.trim().length > 10) {
      banner(fixedBanner);
      const ext     = isDesign || mode === 'custom' ? 'md' : 'ts';
      const slug    = codeLabel.replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/-+/g, '-').slice(0, 30);
      const path    = require('path') as typeof import('path');
      const fs      = require('fs')   as typeof import('fs');
      const { execSync } = require('child_process') as typeof import('child_process');
      const outDir  = path.join(__dirname, 'output');
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const outFile = path.join(outDir, `fixed-${slug}-${Date.now()}.${ext}`);

      // ── Syntax feedback loop (TS files only, max 2 correction passes) ───
      let currentCode  = val.fixed;
      let syntaxPasses = 0;
      const MAX_SYNTAX_PASSES = 2;

      async function runSyntaxCheck(code: string): Promise<string[]> {
        if (ext !== 'ts') return [];
        const tmpFile = path.join(outDir, `_syntax_tmp_${Date.now()}.ts`);
        fs.writeFileSync(tmpFile, code, 'utf8');
        try {
          execSync(
            'npx tsc --noEmit --skipLibCheck --noResolve --allowSyntheticDefaultImports ' +
            '--target ES2020 --module commonjs --strict false "' + tmpFile + '"',
            { stdio: 'pipe', cwd: process.cwd() }
          );
          return [];
        } catch (e: any) {
          const out = String(e.stdout ?? '') + String(e.stderr ?? '');
          return out.split('\n')
            // Filter import-resolution noise — we only want real syntax errors
            .filter(l => l.includes('error TS') && !l.includes('TS2307') && !l.includes('TS2304') && !l.includes('TS2305') && !l.includes('TS2339'))
            .map(l => l.replace(tmpFile, '<file>').trim())
            .filter(Boolean);
        } finally {
          try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        }
      }

      let syntaxErrors = await runSyntaxCheck(currentCode);

      while (syntaxErrors.length > 0 && syntaxPasses < MAX_SYNTAX_PASSES) {
        syntaxPasses++;
        console.log(`  ${c.yellow}⟳  ${syntaxErrors.length} syntax error${syntaxErrors.length !== 1 ? 's' : ''} — correction pass ${syntaxPasses}/${MAX_SYNTAX_PASSES}...${c.reset}`);

        let corrFrame = 0;
        const corrSpin = setInterval(() => {
          process.stdout.write(`\r  ${c.cyan}${FRAMES[corrFrame++ % FRAMES.length]}${c.reset}  ${c.dim}Fixing syntax...${c.reset}  `);
        }, 120);

        try {
          const corrResp = await openai.chat.completions.create({
            model                : 'gpt-5.2',
            max_completion_tokens: 32000,
            temperature          : 0.1,
            response_format      : { type: 'json_object' },
            messages: [
              {
                role   : 'system',
                content:
                  'You are a TypeScript syntax corrector. Fix ONLY the reported errors — do not change logic.\n' +
                  'Common causes: missing | in union types (string | null), missing constructor keyword, ' +
                  'missing || or && or ?? operators.\n' +
                  'Return JSON with one key "fixed": the complete corrected source file. ' +
                  'Single-quoted strings only. No template literals. No markdown fences.',
              },
              {
                role   : 'user',
                content:
                  'TypeScript errors to fix:\n' + syntaxErrors.join('\n') + '\n\n' +
                  'Current code:\n' + currentCode,
              },
            ],
          });
          clearInterval(corrSpin);
          process.stdout.write('\r\x1b[2K');
          const parsed = JSON.parse(extractContent(corrResp));
          currentCode  = decodeHtml(String(parsed.fixed ?? currentCode).trim());
          syntaxErrors = await runSyntaxCheck(currentCode);
        } catch {
          clearInterval(corrSpin);
          process.stdout.write('\r\x1b[2K');
          break;
        }
      }

      const fixedLines = currentCode.split('\n');
      const fixCount   = fixedLines.filter(l => l.includes('// FIX:') || l.includes('## Changes Made')).length;
      const truncated  = val.finishReason === 'length';

      if (syntaxErrors.length === 0) {
        console.log(`  ${c.green}✓  ${fixedLines.length} lines · ${fixCount} changes · syntax clean${truncated ? `  ${c.yellow}⚠ output truncated` : ''}${c.reset}\n`);
      } else {
        console.log(`  ${c.yellow}⚠  ${fixedLines.length} lines · ${fixCount} changes · ${syntaxErrors.length} syntax error${syntaxErrors.length !== 1 ? 's' : ''} remain${truncated ? '  ⚠ output truncated' : ''}${c.reset}\n`);
      }

      for (let i = 0; i < fixedLines.length; i++) {
        const lineNum = String(i + 1).padStart(4, ' ');
        const line    = decodeHtml(fixedLines[i]);
        const isFix   = line.includes('// FIX:') || line.includes('## Changes Made') || line.includes('> **Change:');
        console.log(`  ${c.dim}${lineNum}${c.reset}  ${isFix ? c.green : c.dim}${line}${c.reset}`);
      }

      console.log();
      fs.writeFileSync(outFile, currentCode, 'utf8');
      console.log(`  ${c.green}✓  Saved → ${outFile}${c.reset}  ${c.dim}(open to see the full file)${c.reset}`);
    } else {
      console.log(`  ${c.yellow}⚠  Fixed output empty (token limit hit) — increase max_completion_tokens or use a model with higher context${c.reset}`);
    }
  }

  const totalMs  = Date.now() - totalStart;
  const llmCalls = isDesign ? activeReviewers.length + 1 : activeReviewers.length * 2 + 1;
  console.log(`\n  ${c.dim}Total: ${totalMs} ms (${(totalMs / 1000).toFixed(1)}s) — ${llmCalls} LLM calls via network-ai${c.reset}\n`);
}

main().catch(err => {
  console.error('\n[ERROR]', err.message);
  process.exit(1);
});
