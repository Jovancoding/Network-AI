# Changelog

All notable changes to Network-AI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] -- Phase 3: Priority & Preemption

### Planned
- **Priority-Based Conflict Resolution** -- `'priority-wins'` strategy for `LockedBlackboard` commit step; higher-priority agents preempt lower-priority pending writes on same-key conflicts (0=low, 3=critical)
- **`ConflictResolutionStrategy` option** -- Choose between `'first-commit-wins'` (default, current behavior) and `'priority-wins'` (new)
- **Priority-aware `validate()` / `commit()`** -- Wire `HandoffMessage.metadata.priority` into the atomic commit pipeline

## [Future] -- Phase 4: Distributed Blackboard

### Planned
- **CRDT-Based Synchronization** -- Conflict-free replicated data types with vector clocks for eventual consistency across machines
- **Redis Blackboard Backend** -- Optional Redis pub/sub + distributed locks for multi-process / multi-machine agent coordination
- **Configurable Consistency Levels** -- `eventual` (async replication), `session` (read-your-writes), `strong` (synchronous quorum)
- **Federated Budget Tracking** -- Token spending tracked across distributed agent swarms
- **MCP Networking** -- Cross-machine agent communication (see [references/mcp-roadmap.md](references/mcp-roadmap.md))

## [3.1.0] - 2026-02-16

### Added -- Phase 2: Trust
- **Structured Logging** -- `Logger` class with 4 severity levels (DEBUG/INFO/WARN/ERROR) + SILENT, module-scoped instances via `Logger.create()`, pluggable transports
- **Typed Error Hierarchy** -- `NetworkAIError` base class + 10 specific error subclasses (`AdapterError`, `BlackboardError`, `SecurityError`, `ValidationError`, `LockError`, `TimeoutError`, `PermissionError`, `ConfigurationError`, `AgentError`, `OrchestratorError`)
- **Runtime API Input Validation** -- Guards on 20+ public entry points (`SwarmOrchestrator`, `SharedBlackboard`, `AuthGuardian`, `TaskDecomposer`, `AdapterRegistry`) with descriptive `ValidationError` throws
- **Comprehensive JSDoc** -- Documentation on all exported interfaces (12+), classes (13+), and public methods (8+) with `@example`, `@param`, `@returns`, `@throws` tags
- **Unified Lock + Audit Integration** -- `LockedBlackboard` now accepts an optional `SecureAuditLogger`; `write()` and `delete()` emit structured audit events (lock holder, duration, key, version, success/failure)

### Stats
- 251 tests passing (79 + 33 + 139)
- 0 compile errors

## [3.0.3] - 2026-02-15

### Security Fix
- Resolved 3 High + 1 Medium findings from [Snyk](https://snyk.io) security scan (CWE-547, CWE-798)

### Fixed
- **Hardcoded cryptographic salt** in `DataEncryptor` -- now generates a random 16-byte salt per instance via `crypto.randomBytes()` (was `'swarm-salt'`)
- **Agent token enforcement** -- all internal `blackboard.write()` calls now pass the orchestrator's verification token
- **Test registration** -- core test suite registers agents with proper tokens and namespace access

### Not Real Vulnerabilities (marked as ignore)
- Test file fake secrets (`test-secret-key-for-testing-only`, `sk-1234567890`, `password: 'secret123'`) -- intentional test data, not real credentials

### Stats
- 251 tests passing (79 + 33 + 139)
- 0 compile errors

## [3.0.0] - 2026-02-13

### Added
- **12 Agent Framework Adapters** -- OpenClaw, LangChain, AutoGen, CrewAI, MCP, LlamaIndex, Semantic Kernel, OpenAI Assistants, Haystack, DSPy, Agno, Custom
- **AdapterRegistry** -- Pattern-based routing with `adapterName:agentId` prefix convention
- **BaseAdapter** -- Abstract base class for writing custom adapters
- **Content Quality Gate** -- BlackboardValidator (rule-based, ~159K-1M ops/sec) + QualityGateAgent (AI-assisted review with quarantine)
- **Hallucination Detection** -- Catches vague, unsupported, or fabricated content
- **Dangerous Code Detection** -- Blocks eval(), exec(), rm -rf, and other risky patterns
- **Placeholder Rejection** -- Rejects TODO/FIXME/stub content from entering the blackboard
- **Setup utility** (setup.ts) -- Installation checker and adapter listing
- **QUICKSTART.md** -- 5-minute getting-started guide
- **Hello World example** in README -- 60-second TypeScript quickstart
- **"Why This Exists" section** in README -- Race condition / double-spend problem explanation
- **Production build** -- `npm run build` compiles to dist/ with declarations and source maps
- **GitHub Actions CI** -- Automated test runs on push and PR
- **CHANGELOG.md** -- Version tracking

### Changed
- README completely rewritten with SEO optimization, updated adapter count (6 -> 12), test count (129 -> 251)
- All Unicode/emoji replaced with ASCII for Windows PowerShell compatibility
- Package description and keywords updated for discoverability
- package.json `main` points to `dist/index.js` (compiled output)

### Fixed
- Audit chain hash continuity (P0)
- Shallow-copy vulnerability in custom validation rules (P1)
- Entry type detection accuracy in BlackboardValidator (P1)
- Dangerous pattern severity levels (P2)
- Placeholder detection sensitivity (P2)

### Security
- 13-point security audit completed with all P0/P1/P2 fixes applied
- AES-256-GCM encryption for sensitive blackboard entries
- HMAC-signed tokens with configurable TTL
- Rate limiting with lockout on failed authentication
- Privilege escalation prevention with trust-ceiling enforcement
- Cryptographic audit logs with tamper-evident chain

## [2.0.0] - 2026-02-01

### Added
- Security module (tokens, encryption, rate limiting, audit)
- SharedBlackboard with TTL support
- AuthGuardian permission system
- TaskDecomposer for parallel execution
- Swarm Guard (Python) for budget tracking
- LockedBlackboard with atomic commits

### Changed
- Migrated from single-file to modular architecture

## [1.0.0] - 2026-01-15

### Added
- Initial release
- Basic swarm orchestrator
- OpenClaw skill integration
- Blackboard pattern implementation
