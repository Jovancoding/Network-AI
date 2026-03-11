# Contributing to Network-AI

Network-AI is a solo-maintained project with high quality standards. Contributions are welcome but must meet strict requirements.

## Before You Start

**All contributions require prior discussion.** Do not open a pull request without an approved issue first.

1. **Open an issue** describing the problem or feature
2. **Wait for maintainer approval** before writing code
3. Only after approval, fork and implement

Unsolicited PRs without a linked, approved issue will be closed.

## Requirements for All Contributions

### Code Quality

- All 462+ existing tests must pass (`npm run test:all`)
- Zero TypeScript compile errors (`npx tsc --noEmit`)
- New features must include tests with >90% branch coverage
- Follow existing code style and patterns
- No new runtime dependencies without prior approval

### Security

- No hardcoded secrets, keys, or credentials
- No new network calls without explicit justification
- Input validation required on all public API entry points
- Path traversal and injection protections where applicable

### Documentation

- JSDoc on all exported functions and classes
- Update README.md if adding user-facing features
- Update CHANGELOG.md under `[Unreleased]`

## Pull Request Process

1. Fork the repository and create a branch from `main`
2. Implement your change with tests
3. Run the full test suite:
   ```bash
   npm run test:all
   npx tsc --noEmit
   ```
4. Open a PR referencing the approved issue
5. Fill out the PR template completely
6. Wait for review -- the maintainer reviews all PRs personally

### PR Review Criteria

- Does it solve the approved issue?
- Are tests comprehensive?
- Is the code clean and idiomatic TypeScript?
- Does it maintain backward compatibility?
- Does it introduce any security concerns?

## What We Accept

- Bug fixes with reproduction steps and tests
- Security improvements
- Performance optimizations with benchmarks
- New adapter implementations (following `BaseAdapter` pattern)
- Documentation improvements

## What We Do Not Accept

- Breaking API changes without a migration path
- Features that add external runtime dependencies
- Code that reduces test coverage
- Cosmetic-only changes (formatting, renaming)
- AI-generated code without human review and testing

## Development Setup

```bash
git clone https://github.com/Jovancoding/Network-AI.git
cd Network-AI
npm install
npm run test:all  # Run all 462 tests (5 suites)
npm run test:phase4  # Phase 4 behavioral control plane tests only
npx tsc --noEmit  # Type-check
```

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
