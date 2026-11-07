/**
 * test-skill-scripts.ts — regression checks for the ClawHub Python skill
 * scripts that need a real interpreter and a real file system.
 *
 * Covers the SkillSpector "Excessive Agency" findings for scripts/blackboard.py:
 * pending-change files must never be resolved or followed through a symlink,
 * and the containment check must work by path components (a sibling such as
 * pending_changes_extra/ is not "inside" pending_changes/).
 *
 * Each check runs against a copy of the script in a temporary project, so the
 * repository's data/ is never touched. File-symlink cases run where the OS
 * allows them (Linux/macOS CI); directory-junction and non-regular-file cases
 * run everywhere. Skips cleanly when no Python 3 is installed.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function pass(label: string) { passed++; process.stdout.write(`  ✓ ${label}\n`); }
function fail(label: string, reason: string) { failed++; failures.push(`${label}: ${reason}`); process.stdout.write(`  ✗ ${label} — ${reason}\n`); }
function assert(cond: boolean, label: string, detail = '') { if (cond) pass(label); else fail(label, detail || 'assertion failed'); }
function section(name: string) { process.stdout.write(`\n${name}\n`); }

function findPython(): string | null {
  for (const cmd of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', timeout: 30_000 });
    if (r.status === 0 && r.stdout.trim() === '3') return cmd;
  }
  return null;
}

/** A throwaway project: <tmp>/scripts/blackboard.py and <tmp>/data/. */
function makeProject(): { root: string; data: string; pending: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-skill-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(path.join(__dirname, 'scripts', 'blackboard.py'), path.join(root, 'scripts', 'blackboard.py'));
  const data = path.join(root, 'data');
  const pending = path.join(data, 'pending_changes');
  fs.mkdirSync(pending, { recursive: true });
  return { root, data, pending };
}

/** Run Python code with `bb` = SharedBlackboard() of the project; prints one JSON result line. */
function runPy(python: string, root: string, body: string): { ok: boolean; out: Record<string, unknown>; raw: string } {
  const code = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(root, 'scripts'))})`,
    'import blackboard as m',
    'res = {}',
    'try:',
    '    bb = m.SharedBlackboard()',
    ...body.split('\n').map((l) => `    ${l}`),
    'except Exception as e:',
    '    res["error"] = type(e).__name__ + ": " + str(e)',
    'print(json.dumps(res, default=str))',
  ].join('\n');
  const r = spawnSync(python, ['-c', code], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NETWORK_AI_ENV: '' } });
  const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const line = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  try {
    return { ok: r.status === 0, out: JSON.parse(line) as Record<string, unknown>, raw };
  } catch {
    return { ok: false, out: {}, raw };
  }
}

function canSymlinkFiles(dir: string): boolean {
  const t = path.join(dir, '.probe-target');
  const l = path.join(dir, '.probe-link');
  try {
    fs.writeFileSync(t, 'x');
    fs.symlinkSync(t, l, 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(l, { force: true });
    fs.rmSync(t, { force: true });
  }
}

function testPendingPaths(python: string): void {
  section('blackboard.py: normal propose → validate → commit still works');
  {
    const p = makeProject();
    try {
      const r = runPy(python, p.root, [
        'res["propose"] = bb.propose_change("chg_1", "task:a", {"v": 1}, "agent")["success"]',
        'res["validate"] = bb.validate_change("chg_1")["valid"]',
        'res["commit"] = bb.commit_change("chg_1").get("committed")',
        'res["value"] = bb.read("task:a")["value"]',
        'res["pending"] = len(bb.list_pending_changes())',
      ].join('\n'));
      assert(r.out['propose'] === true && r.out['validate'] === true && r.out['commit'] === true, 'propose, validate, and commit succeed', r.raw.slice(0, 400));
      assert(JSON.stringify(r.out['value']) === '{"v":1}' || JSON.stringify(r.out['value']) === '{"v": 1}', 'committed value is readable', r.raw.slice(0, 400));
      assert(r.out['pending'] === 0 && fs.existsSync(path.join(p.pending, 'archive', 'chg_1.committed.json')), 'the change is archived, nothing left pending');
    } finally {
      fs.rmSync(p.root, { recursive: true, force: true });
    }
  }

  section('blackboard.py: pending entries are never followed');
  {
    const p = makeProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-skill-outside-'));
    try {
      // A directory (or junction) planted at the pending-file name is not a regular file.
      fs.mkdirSync(path.join(p.pending, 'dirent.pending.json'));
      const r1 = runPy(python, p.root, 'res["r"] = bb.propose_change("dirent", "k", 1, "a")');
      assert(String(r1.out['error'] ?? '').includes('PermissionError'), 'a non-regular entry at the pending path is refused', r1.raw.slice(0, 300));
      const r1b = runPy(python, p.root, 'res["n"] = len(bb.list_pending_changes())');
      assert(r1b.out['n'] === 0 && r1b.out['error'] === undefined, 'listing skips non-regular entries without failing', r1b.raw.slice(0, 300));

      if (canSymlinkFiles(p.pending)) {
        const victim = path.join(outside, 'victim.json');
        const original = JSON.stringify({ change_id: 'evil', key: 'k', status: 'pending', operation: 'write', value: 'x', source_agent: 'a', proposed_at: 'now', base_hash: null });
        fs.writeFileSync(victim, original);
        fs.symlinkSync(victim, path.join(p.pending, 'evil.pending.json'), 'file');
        const r2 = runPy(python, p.root, 'res["r"] = bb.propose_change("evil", "k", 1, "a")');
        assert(String(r2.out['error'] ?? '').includes('PermissionError'), 'propose refuses a symlink at the pending path', r2.raw.slice(0, 300));
        const r3 = runPy(python, p.root, 'res["r"] = bb.validate_change("evil")');
        assert(String(r3.out['error'] ?? '').includes('PermissionError'), 'validate refuses to read through a symlink', r3.raw.slice(0, 300));
        const r4 = runPy(python, p.root, 'res["r"] = bb.abort_change("evil")');
        assert(String(r4.out['error'] ?? '').includes('PermissionError'), 'abort refuses to archive or delete through a symlink', r4.raw.slice(0, 300));
        assert(fs.readFileSync(victim, 'utf8') === original && fs.lstatSync(path.join(p.pending, 'evil.pending.json')).isSymbolicLink(), 'the link target outside data/ is untouched');
        const r5 = runPy(python, p.root, 'res["n"] = len(bb.list_pending_changes())');
        assert(r5.out['n'] === 0, 'listing never reads through a symlink');
        // A link planted between the path check and a later open is refused by O_NOFOLLOW.
        const r6 = runPy(python, p.root, [
          'import os',
          'target = bb._safe_pending_path("late")',
          `os.symlink(${JSON.stringify(victim)}, target)`,
          'res["r"] = bb._read_pending(target)',
        ].join('\n'));
        assert(/PermissionError|OSError|ELOOP|Too many levels/.test(String(r6.out['error'] ?? '')), 'a link planted after the path check is refused at open (O_NOFOLLOW)', r6.raw.slice(0, 300));
      } else {
        pass('file-symlink cases skipped: this OS account cannot create file symlinks (they run on Linux CI)');
      }
    } finally {
      fs.rmSync(p.root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }

  section('blackboard.py: containment is by path components, not string prefix');
  {
    const p = makeProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-skill-outside-'));
    try {
      // pending_changes redirected outside data/ (junction on Windows, symlink elsewhere).
      fs.rmSync(p.pending, { recursive: true, force: true });
      fs.symlinkSync(outside, p.pending, process.platform === 'win32' ? 'junction' : 'dir');
      const r1 = runPy(python, p.root, 'res["ok"] = True');
      assert(String(r1.out['error'] ?? '').includes('PermissionError') && fs.readdirSync(outside).length === 0, 'a pending_changes directory redirected outside data/ is refused', r1.raw.slice(0, 300));
    } finally {
      fs.rmSync(p.root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
    const q = makeProject();
    try {
      const r2 = runPy(python, q.root, [
        'from pathlib import Path',
        `sibling = Path(${JSON.stringify(path.join(q.data, 'pending_changes_extra'))})`,
        'try:',
        '    m._require_inside(sibling, bb.pending_dir)',
        '    res["sibling_inside"] = True',
        'except PermissionError:',
        '    res["sibling_inside"] = False',
        'res["child_inside"] = (m._require_inside(bb.pending_dir / "archive", bb.pending_dir) is None)',
      ].join('\n'));
      assert(r2.out['sibling_inside'] === false && r2.out['child_inside'] === true, 'pending_changes_extra is not inside pending_changes; archive/ is', r2.raw.slice(0, 300));
      const r3 = runPy(python, q.root, 'res["p"] = str(bb._safe_pending_path("ok_id"))');
      assert(String(r3.out['p'] ?? '') === path.join(q.pending, 'ok_id.pending.json'), 'the returned path is the unresolved name inside pending_changes', r3.raw.slice(0, 300));
      for (const bad of ['../x', 'a/b', '..', 'a\\b', '']) {
        const r = runPy(python, q.root, `res["r"] = str(bb._safe_pending_path(${JSON.stringify(bad)}))`);
        assert(String(r.out['error'] ?? '').includes('ValueError'), `change id ${JSON.stringify(bad)} rejected`, r.raw.slice(0, 200));
      }
    } finally {
      fs.rmSync(q.root, { recursive: true, force: true });
    }
  }
}

function main(): void {
  process.stdout.write('ClawHub skill scripts — file-system safety\n');
  const python = findPython();
  if (!python) {
    pass('skipped: no Python 3 interpreter found');
  } else {
    testPendingPaths(python);
  }
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.exit(1);
  }
}

main();
