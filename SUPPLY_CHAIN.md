# Supply Chain

What Network-AI installs, what it executes, what it writes to disk, and what it calls
over the network — so operators can make informed trust decisions.

---

## 1. Runtime Dependencies

Network-AI has **one production runtime dependency**:

| Package | Version | Purpose | Network access | Writes to disk |
|---------|---------|---------|---------------|---------------|
| `commander` | ^14.0.3 | CLI argument parsing | None | None |

That's it. The core library, all 29 adapters, the MCP server, and the blackboard are
implemented with Node.js built-ins only.

**BYOC design principle**: Adapters are "Bring Your Own Client". They declare interfaces
and types but import no LLM SDK, no HTTP library, and no vector store at require-time.
The operator passes a pre-constructed client in. This means installing `network-ai` does
**not** install OpenAI, LangChain, AutoGen, or any other framework SDK.

---

## 2. Development Dependencies (not installed in production)

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^6.0.3 | Compiler |
| `ts-node` | ^10.9.2 | Test runner / local execution |
| `@types/node` | ^25.9.0 | Node.js type declarations |
| `dotenv` | ^17.4.2 | Load `.env` files in tests |
| `openai` | ^6.38.0 | Used in test suites (MCP SSE integration tests) |

`devDependencies` are **not** included in the published npm package.

---

## 3. What Runs at Install Time

| Script | Trigger | Action |
|--------|---------|--------|
| None | `npm install` | No `preinstall` or `postinstall` scripts |

There are no install-time scripts. `npm install network-ai` only downloads and unpacks
the package; no code runs.

The `prepublishOnly` script (`npm run build && npm run test:all`) runs only when the
maintainer publishes a new version. It is not executed on the operator's machine.

---

## 4. What Writes to Disk at Runtime

| Component | What it writes | Where |
|-----------|---------------|-------|
| `LockedBlackboard` | Blackboard state, WAL entries, lock files | `data/` |
| `SecureAuditLogger` | Event log lines (JSONL) | `data/audit_log.jsonl` |
| `EnvironmentManager` | Per-env data directories, backup snapshots | `data/<env>/`, `data/backups/` |
| `check_permission.py` | HMAC signing key (on first run) | `data[/<env>]/.signing_key` |
| `LockedBlackboard` | Filesystem mutex | `data/.lock` |

All writes are confined to the configured data directory. Path traversal is blocked: all
file operations resolve the final path and assert it is within the data root before I/O.

---

## 5. What Calls Over the Network

### Core library: zero outbound network calls

The core library (`index.ts`, `lib/`, `security.ts`) makes **no outbound network calls**.
All network I/O is performed by:

- The operator's BYOC client (passed in by the operator at runtime)
- The MCP transport (`lib/mcp-transport-sse.ts`), which **receives** inbound HTTP/SSE
  connections — it does not initiate outbound connections

### Python helper scripts

The helper scripts (`scripts/blackboard.py`, `scripts/check_permission.py`,
`scripts/validate_token.py`, `scripts/revoke_token.py`) make no network calls. They read
and write local files only.

### Test suite only (not included in the published package)

| File | Network call | Purpose |
|------|-------------|---------|
| `test-phase6.ts` | `localhost:<port>` | MCP SSE integration test (loopback only) |
| `test-a2a.ts` | `localhost:<port>` | A2A protocol integration test (loopback only) |

---

## 6. npm Provenance & SLSA

Every release is published via GitHub Actions CI with:

```yaml
- name: Publish to npm
  run: npm publish --provenance --access public
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

The `--provenance` flag publishes a signed SLSA Build Level 2 attestation to the
[Sigstore transparency log](https://search.sigstore.dev/). This attestation links the
published package to the exact Git commit and CI workflow run that built it.

**Verifying provenance**:

```bash
npm audit signatures
# or
npm install network-ai
npx sigstore verify node_modules/network-ai
```

The provenance statement includes:

- Source repository: `https://github.com/Jovancoding/Network-AI`
- Builder: GitHub Actions (`ubuntu-latest`)
- Build workflow: `.github/workflows/ci.yml`
- Git ref: `refs/tags/v<version>`

---

## 7. Signed Git Tags

All release tags are pushed from CI and correspond to a signed commit on `main`. The tag
format is `v<semver>` (e.g. `v5.7.2`).

---

## 8. CodeQL Scanning

Every push and pull request to `main` triggers CodeQL analysis (JavaScript/TypeScript).
Results are published to the GitHub Security tab. Open alerts are tracked and resolved
before each release.

---

## 9. Package Contents (`files` in package.json)

The published npm package includes:

```
dist/          compiled JavaScript + declaration files
bin/           CLI entry points (TypeScript source)
types/         additional .d.ts declarations
scripts/       Python helper scripts
socket.json    MCP socket configuration
README.md
QUICKSTART.md
INTEGRATION_GUIDE.md
SKILL.md
LICENSE
```

Notably **excluded** from the published package:

- `test-*.ts` files
- `data/` directory
- `.github/`
- `node_modules/`
- TypeScript source files (other than `bin/`)

---

## 10. Dependency Update Policy

- Dependabot is enabled for npm (weekly PRs for patch/minor updates).
- All dependency update PRs run the full test suite (3,148 tests) before merge.
- Major version bumps require manual review and a CHANGELOG entry.
- New **runtime** dependencies require explicit approval and an update to this file.
