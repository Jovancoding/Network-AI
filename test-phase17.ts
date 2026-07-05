/**
 * test-phase17.ts
 *
 * v5.13.4 — GHSA-m4jg-6w3q-gm86 regression tests:
 *   ApprovalInbox GET read routes (/, /stats, /sse, /:id) must require the
 *   same Bearer auth as the mutating POST routes once a `secret` is
 *   configured, and the HTTP handler must never emit a wildcard
 *   `Access-Control-Allow-Origin: *` header.
 */

import type { AddressInfo } from 'net';
import { ApprovalInbox } from './lib/approval-inbox';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];
function pass(label: string) { passed++; process.stdout.write(`  ✓ ${label}\n`); }
function fail(label: string, reason: string) { failed++; failures.push(`${label}: ${reason}`); process.stdout.write(`  ✗ ${label} — ${reason}\n`); }
function assert(cond: boolean, label: string, detail = '') { if (cond) pass(label); else fail(label, detail || 'assertion failed'); }
function header(t: string) { process.stdout.write(`\n=== ${t} ===\n`); }

function startInbox(options: ConstructorParameters<typeof ApprovalInbox>[0] = {}): Promise<{ inbox: ApprovalInbox; server: import('http').Server; base: string }> {
  const inbox = new ApprovalInbox(options);
  const server = inbox.startServer(0);
  return new Promise((resolve) => {
    server.on('listening', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ inbox, server, base: `http://127.0.0.1:${port}/approvals` });
    });
  });
}

function closeServer(server: import('http').Server): Promise<void> {
  return new Promise((res) => server.close(() => res()));
}

// ---------------------------------------------------------------------------
// Read-route authentication (GHSA-m4jg-6w3q-gm86)
// ---------------------------------------------------------------------------

async function testReadRoutesGatedWhenSecretConfigured() {
  header('Read routes gated behind Bearer auth when secret is set');
  const { server, base } = await startInbox({ secret: 's3cr3t' });
  try {
    const rList = await fetch(`${base}/?status=all`);
    assert(rList.status === 401, 'GET / with no auth -> 401', String(rList.status));

    const rStats = await fetch(`${base}/stats`);
    assert(rStats.status === 401, 'GET /stats with no auth -> 401', String(rStats.status));

    const rSse = await fetch(`${base}/sse`);
    assert(rSse.status === 401, 'GET /sse with no auth -> 401', String(rSse.status));

    const rId = await fetch(`${base}/deadbeef`);
    assert(rId.status === 401, 'GET /:id with no auth -> 401', String(rId.status));

    const rApprove = await fetch(`${base}/deadbeef/approve`, { method: 'POST' });
    assert(rApprove.status === 401, 'POST /:id/approve with no auth still -> 401 (unchanged)', String(rApprove.status));
  } finally {
    await closeServer(server);
  }
}

async function testReadRoutesSucceedWithCorrectToken() {
  header('Read routes succeed with correct Bearer token');
  const { server, base } = await startInbox({ secret: 's3cr3t' });
  try {
    const headers = { Authorization: 'Bearer s3cr3t' };
    const rList = await fetch(`${base}/?status=all`, { headers });
    assert(rList.status === 200, 'GET / with correct token -> 200', String(rList.status));

    const rStats = await fetch(`${base}/stats`, { headers });
    assert(rStats.status === 200, 'GET /stats with correct token -> 200', String(rStats.status));
  } finally {
    await closeServer(server);
  }
}

async function testReadRoutesRejectWrongToken() {
  header('Read routes reject an incorrect Bearer token');
  const { server, base } = await startInbox({ secret: 's3cr3t' });
  try {
    const rList = await fetch(`${base}/?status=all`, { headers: { Authorization: 'Bearer wrong' } });
    assert(rList.status === 403, 'GET / with wrong token -> 403', String(rList.status));
  } finally {
    await closeServer(server);
  }
}

async function testBackwardCompatNoSecretConfigured() {
  header('Backward compatibility — no secret configured leaves read routes open');
  const { server, base } = await startInbox();
  try {
    const rList = await fetch(`${base}/?status=all`);
    assert(rList.status === 200, 'GET / with no secret configured -> 200 (unchanged default)', String(rList.status));
  } finally {
    await closeServer(server);
  }
}

// ---------------------------------------------------------------------------
// CORS — no wildcard (GHSA-m4jg-6w3q-gm86)
// ---------------------------------------------------------------------------

async function testNoWildcardCorsByDefault() {
  header('CORS — no Access-Control-Allow-Origin header by default');
  const { server, base } = await startInbox();
  try {
    const r = await fetch(`${base}/?status=all`, { headers: { Origin: 'https://evil.example' } });
    assert(r.headers.get('access-control-allow-origin') === null, 'no CORS header when allowedOrigins is not configured', String(r.headers.get('access-control-allow-origin')));
  } finally {
    await closeServer(server);
  }
}

async function testAllowlistedOriginEchoed() {
  header('CORS — allowlisted origin is echoed back (never wildcard)');
  const { server, base } = await startInbox({ allowedOrigins: ['https://good.example'] });
  try {
    const rGood = await fetch(`${base}/?status=all`, { headers: { Origin: 'https://good.example' } });
    assert(rGood.headers.get('access-control-allow-origin') === 'https://good.example', 'allowlisted origin echoed exactly', String(rGood.headers.get('access-control-allow-origin')));
    assert(rGood.headers.get('access-control-allow-origin') !== '*', 'never emits wildcard');

    const rBad = await fetch(`${base}/?status=all`, { headers: { Origin: 'https://evil.example' } });
    assert(rBad.headers.get('access-control-allow-origin') === null, 'non-allowlisted origin gets no CORS header', String(rBad.headers.get('access-control-allow-origin')));
  } finally {
    await closeServer(server);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  process.stdout.write('\n========================================\n');
  process.stdout.write('  Phase 17 — ApprovalInbox GHSA-m4jg-6w3q-gm86 fix\n');
  process.stdout.write('========================================\n');

  await testReadRoutesGatedWhenSecretConfigured();
  await testReadRoutesSucceedWithCorrectToken();
  await testReadRoutesRejectWrongToken();
  await testBackwardCompatNoSecretConfigured();
  await testNoWildcardCorsByDefault();
  await testAllowlistedOriginEchoed();

  process.stdout.write(`\n========================================\n`);
  process.stdout.write(`  Phase 17: ${passed} passed, ${failed} failed\n`);
  process.stdout.write('========================================\n');
  if (failed > 0) {
    process.stdout.write('\nFailures:\n');
    failures.forEach((f) => process.stdout.write(`  - ${f}\n`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => { process.stdout.write(`\nFATAL: ${err instanceof Error ? err.stack : String(err)}\n`); process.exit(1); });
