# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 4.0.x   | Yes (latest) |
| 3.9.x   | Security fixes only |
| 3.8.x   | Security fixes only |
| 3.7.x   | Security fixes only |
| 3.6.x   | Security fixes only |
| 3.5.x   | Security fixes only |
| 3.4.x   | Security fixes only |
| 3.3.x   | No |
| 3.2.x   | No |
| 3.1.x   | No |
| 3.0.x   | No |
| < 3.0   | No |

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please report security issues privately:

1. Go to the [Security Advisories](https://github.com/jovanSAPFIONEER/Network-AI/security/advisories) page
2. Click **"Report a vulnerability"**
3. Provide a clear description, reproduction steps, and impact assessment

You will receive an acknowledgment within 48 hours and a detailed response within 7 days.

## Security Measures in Network-AI

Network-AI includes built-in security features:

- **AES-256-GCM encryption** for blackboard data at rest
- **HMAC-SHA256 signed tokens** via AuthGuardian with trust levels and scope restrictions
- **Rate limiting** to prevent abuse
- **Path traversal protection** in the Python blackboard (regex + resolved-path boundary checks)
- **Input validation** on all 20+ public API entry points
- **Secure audit logging** with tamper-resistant event trails
- **Justification hardening** (v3.2.1) -- prompt-injection detection (16 patterns), keyword-stuffing defense, repetition/padding detection, structural coherence validation
- **FSM Behavioral Control Plane** (v3.3.0) -- state-scoped agent and tool authorization via `JourneyFSM` and `ToolAuthorizationMatrix`; unauthorized actions blocked with `ComplianceViolationError`
- **ComplianceMonitor** (v3.3.0) -- real-time agent behavior surveillance with configurable violation policies, severity classification, and async audit loop
- **Named Multi-Blackboard API** (v3.4.0) -- isolated `SharedBlackboard` instances per name with independent namespaces, validation configs, and agent scoping; prevents cross-task data leakage

## Security Scan Results

- **VirusTotal**: Benign (0/64 engines)
- **OpenClaw Scanner**: Benign, HIGH CONFIDENCE
- **CodeQL**: v3.3.0 -- all fixable alerts resolved; unused imports cleaned; false-positive detection patterns dismissed; v3.4.0 clean; v3.4.1 -- #65–#68 HIGH (insecure temporary file) resolved via `path.resolve()` sanitization and `mode: 0o700` directory permissions
- **Snyk**: All High/Medium findings resolved in v3.0.3

## Disclosure Policy

We follow coordinated disclosure. We will:

1. Confirm the vulnerability and determine its impact
2. Develop and test a fix
3. Release a patched version
4. Credit the reporter (unless anonymity is requested)

We ask that you give us reasonable time to address the issue before any public disclosure.
