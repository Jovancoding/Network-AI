# Changelog

All notable changes to Network-AI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
