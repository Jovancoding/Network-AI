/**
 * test-plugin-pins.ts — every launcher and run instruction that fetches the
 * package names an exact version, and that version is the one being released.
 *
 * Plugin marketplaces (Claude Code, Gemini CLI, MCP registry) reject launchers
 * like `npx network-ai` or `network-ai@latest` because the code they run can
 * change after review. This suite fails a release that forgets to bump a pin.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

let passed = 0;
let failed = 0;
const failures: string[] = [];
function pass(label: string) { passed++; process.stdout.write(`  ✓ ${label}\n`); }
function fail(label: string, reason: string) { failed++; failures.push(`${label}: ${reason}`); process.stdout.write(`  ✗ ${label} — ${reason}\n`); }
function assert(cond: boolean, label: string, detail = '') { if (cond) pass(label); else fail(label, detail || 'assertion failed'); }
function section(name: string) { process.stdout.write(`\n${name}\n`); }

const root = __dirname;
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const json = <T = Record<string, unknown>>(rel: string) => JSON.parse(read(rel)) as T;
const version = json<{ version: string }>('package.json').version;
const PIN = `network-ai@${version}`;

function trackedFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function testManifests(): void {
  section(`Launchers run ${PIN}`);
  const launcherArgs = (rel: string) => {
    const servers = json<{ mcpServers: Record<string, { command: string; args: string[] }> }>(rel).mcpServers;
    return servers['network-ai'];
  };
  for (const rel of ['.mcp.json', 'plugins/network-ai/.mcp.json', 'gemini-extension.json']) {
    const l = launcherArgs(rel);
    assert(l.command === 'npx' && l.args.includes(PIN) && !l.args.includes('network-ai'), `${rel} launches ${PIN}`, JSON.stringify(l.args));
  }
  const server = json<{ version: string; packages: { version: string; runtimeArguments: { value: string }[] }[] }>('server.json');
  assert(server.version === version && server.packages.every((p) => p.version === version), 'server.json versions match package.json');
  assert(server.packages.every((p) => p.runtimeArguments.some((a) => a.value === PIN)), `server.json runtime arguments pin ${PIN}`);
  assert(read('.codex/config.toml').includes(`"${PIN}"`), `.codex/config.toml pins ${PIN}`);

  section('Plugin and manifest versions match package.json');
  for (const rel of ['plugins/network-ai/.claude-plugin/plugin.json', 'gemini-extension.json', 'skill.json']) {
    assert(json<{ version: string }>(rel).version === version, `${rel} version is ${version}`);
  }
  const market = json<{ plugins?: { version?: string; source?: string }[]; metadata?: { version?: string } }>('.claude-plugin/marketplace.json');
  assert((market.plugins ?? []).every((p) => p.source === './plugins/network-ai'), 'marketplace.json points at plugins/network-ai');
  for (const rel of ['plugins/network-ai/README.md', 'plugins/network-ai/LICENSE', 'plugins/network-ai/.claude-plugin/icon.png']) {
    assert(fs.existsSync(path.join(root, rel)), `${rel} exists`);
  }
  const pluginFiles = trackedFiles().filter((f) => f.startsWith('plugins/network-ai/'));
  assert(pluginFiles.every((f) => /^(plugins\/network-ai\/)(\.claude-plugin\/(plugin\.json|icon\.png)|\.mcp\.json|README\.md|LICENSE|commands\/[a-z-]+\.md)$/.test(f)), 'the plugin folder holds only manifest, icon, MCP config, commands, README, and LICENSE', pluginFiles.join(', '));
  const marketVersions = [...(market.plugins ?? []).map((p) => p.version), market.metadata?.version].filter((v): v is string => typeof v === 'string');
  assert(marketVersions.length > 0 && marketVersions.every((v) => v === version), `.claude-plugin/marketplace.json versions are ${version}`, marketVersions.join(','));

  section('package.json scripts never fetch through npx');
  const scripts = json<{ scripts: Record<string, string> }>('package.json').scripts;
  const npxScripts = Object.entries(scripts).filter(([, v]) => /\bnpx\b/.test(v)).map(([k]) => k);
  assert(npxScripts.length === 0, 'no npm script uses npx (local bins are on PATH)', npxScripts.join(', '));
}

function testTextPins(): void {
  section('Run instructions pin the package everywhere');
  // Files that intentionally contain historical or test text.
  const skip = new Set(['CHANGELOG.md', 'package-lock.json', 'test-phase18.ts', 'test-plugin-pins.ts']);
  const files = trackedFiles().filter((f) => /\.(md|ts|js|json|ya?ml|toml|html)$/.test(f) && !skip.has(f));
  if (files.length === 0) {
    pass('skipped: git is not available to list tracked files');
    return;
  }
  const unpinned: string[] = [];
  const stale: string[] = [];
  const latest: string[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = read(f);
    } catch {
      continue;
    }
    text.split('\n').forEach((line, i) => {
      if (/npx (?:-y )?(?:-p )?network-ai(?![-@\w])/.test(line) || /npx (?:-y )?network-ai-(?:server|console|dashboard)\b/.test(line)) unpinned.push(`${f}:${i + 1}`);
      if (/"-p",\s*"network-ai"/.test(line)) unpinned.push(`${f}:${i + 1}`);
      for (const m of line.matchAll(/network-ai@(\d+\.\d+\.\d+)/g)) if (m[1] !== version) stale.push(`${f}:${i + 1} (${m[1]})`);
      if (/@latest\b/.test(line)) latest.push(`${f}:${i + 1}`);
    });
  }
  assert(unpinned.length === 0, 'no unpinned `npx network-ai…` launch', unpinned.slice(0, 10).join(', '));
  assert(stale.length === 0, `every network-ai@x.y.z pin is ${version}`, stale.slice(0, 10).join(', '));
  assert(latest.length === 0, 'no `@latest` anywhere', latest.slice(0, 10).join(', '));
}

function main(): void {
  process.stdout.write(`Release pins — ${PIN}\n`);
  testManifests();
  testTextPins();
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    for (const f of failures) process.stdout.write(`  - ${f}\n`);
    process.exit(1);
  }
}

main();
