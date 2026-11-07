# Hardened Deployment Profile — Perpetual Runtime

> Applies to Network-AI 6.0.0+ when `lib/perpetual` runs long-lived, self-improving, or self-funding agents.
> Everything here is opt-in. A short, attended run does not need all of it; the more autonomy you grant, the more of it you need.

## What this profile is for

Assume a capable agent may get arbitrary code execution on its own machine, and may find zero-days in the Node runtime, the guest kernel, or the hypervisor. No software stack can be shown to be unbreakable, so this profile does not depend on the agent's machine staying intact. Instead it:

1. keeps every control decision, key, and credential **off** the agent's machine;
2. keeps the channels from the agent to the control plane few, narrow, fixed-schema, and fuzzed;
3. makes tampering itself stop the run (attestation), so nothing has to detect the attack;
4. bounds how long any exploit chain has to work (lease TTL, human checkpoints);
5. detects attempts early (tripwires, sentries, a tamper-evident audit log).

**Containment buys time and detection. It does not make compromise impossible.** Hypervisor, kernel, and hardware zero-days exist. Do not grant these modes to systems you suspect could exceed the assurance of the containment you have deployed.

## Topology

```
 ┌─────────────────────── agent host ───────────────────────┐
 │  Agent microVM (Firecracker / Kata)                       │
 │   • no network interface                                  │
 │   • read-only, dm-verity root image                       │
 │   • node --no-addons --disallow-code-generation-…         │
 │       --permission --allow-fs-*=/workspace                │
 │            │ vsock (only channel)                         │
 │  VsockRelay (host side, own user) ── fixed frames only ───┼──► lease authorities (k-of-n)
 └──────────────────────────────────────────────────────────┬┘──► egress proxy (sole internet path)
                                                           │
 Authority hosts (≥ 2 for high-risk scopes, separate admin domains, confidential VMs where available)
 Egress proxy host (holds credentials; tripwires; reports as sentry:proxy)
 Sentry host(s) (read-only audit tails; quorum)
 External audit witness (signed tree heads; object-lock storage or a separate host)
 Operator (offline / hardware-backed key; signs policies, checkpoints, approvals)
```

| Component | Runs as | Holds | Reachable by the agent? |
|---|---|---|---|
| Agent microVM | dedicated agent user | nothing secret | — |
| `VsockRelay` | relay user | nothing secret | yes, over vsock, 4 message types |
| `LeaseAuthority` ×n | authority user, separate hosts | one authority key each (HSM / `--signer-cmd`) | only via the relay |
| `EgressProxy` | proxy user | upstream credentials, decoy manifest | only via the relay |
| Sentries | sentry users | their own sentry secrets | no |
| Witness | separate host | log public key, latest head | no |
| Operator | human | operator key on a hardware token | no |

## Step by step

### 1. Keys and signers

- Generate the operator key on an offline machine or hardware token. It must **never** be on an authority, proxy, or agent host — `perpetual doctor` and `perpetual authority` check for it (`operator-key-present`).
- Keep authority keys in an HSM, TPM, YubiKey, or cloud KMS and sign through `--signer-cmd` (stdin → signature on stdout). The private key never enters Node memory, and every signature is verified before use. Only Ed25519 is supported today; for devices without Ed25519 wrap them in a signer program that does support it (a P-256 variant is not implemented yet).
- Use distinct, high-entropy role secrets per role and per sentry (`weak-secret`, `duplicate-secret`).

### 2. Policy

Sign a `RenewalPolicy` with at least:

```jsonc
{
  "leaseTtlMs": 60000,                         // short: bounds every exploit window
  "humanCheckpointEveryMs": 86400000,          // the run dies at the next checkpoint without a human decision
  "authorityQuorum": { "threshold": 2, "keyIds": ["<a1>", "<a2>", "<a3>"] },
  "financialDestinations": ["payments"],       // routes that move money (makes the policy high-risk)
  "attestation": { "kind": "tpm-quote", "expectedMeasurements": ["<dm-verity root hash>"] },
  "requires": { "capabilityEval": { "evaluatorPublicKeysPem": ["…"], "thresholds": { "cyber-offense": { "max": 0.2 }, "self-exfiltration": { "max": 0.1 }, "deception": { "max": 0.1 } }, "maxAgeMs": 604800000 } },
  "stopWhen": { "sentryAlertAtOrAbove": "critical", "sentryQuorum": 2, "tripwire": true, "onCanaryFailure": true, "onHealthFailing": true }
}
```

High-risk policies (`elevated` tier, `self_improve`, or a granted financial route) are rejected unless they have `authorityQuorum.threshold ≥ 2` and a capability-evaluation requirement — or an explicit, operator-signed `acceptRisk` entry.

### 3. Posture gate

Run on every control-plane host before starting anything:

```bash
npx -y network-ai@6.0.1 perpetual doctor --role authority --operator-pub operator.pub --key /keys/authority.key \
  --agent-user nai-agent --host 0.0.0.0 --allow-remote --tls-terminated --authority-threshold 2
npx -y network-ai@6.0.1 perpetual doctor --role agent --node-flags "$(node -p 'process.execArgv.join(" ")')"
```

`perpetual authority` and `perpetual proxy` run the same checks and refuse to start on a failure unless you pass `--accept-risk <check-id>`, which is written to the audit log.

### 4. Agent image and sandbox

- Read-only root image with dm-verity; record its root hash in `attestation.expectedMeasurements`.
- No compilers or package managers in the image unless the task needs them.
- `FirecrackerSandboxRunner` with `vsockUdsPath` and `network: 'relay-only'` (no network interface is ever configured), under the jailer with an unprivileged uid/gid; or `KataSandboxRunner`; or `ContainerSandboxRunner` with `runsc` and `network: 'relay-only'`.
- `nodeProfile: 'hardened'` for Node workloads: no native addons, no code generation from strings, the permission model limited to `/workspace`, no child processes or workers unless configured. The flags go in argv (not `NODE_OPTIONS`).
- The sandbox refuses uid 0.

### 5. Doors

- `VsockRelay` on the host: listens on `<vsock uds>_5000`, serves only the run ids of that VM, accepts only `lease-issue`, `lease-challenge`, `lease-renew`, `lease-status`, and `egress` frames (strict schema, ≤ 16 KiB by default, rate- and concurrency-limited). It forwards egress only to a loopback proxy and never exposes an authority admin route.
- Where latency allows, use the one-way spool (`SpoolLeaseTransport` / `SpoolPuller`) across a hardware data diode instead of a socket.
- The egress proxy is the only internet path. Give it every authority URL and public key (`--authority-url a b c --authority-pub a.pub b.pub c.pub --authority-threshold 2`): a lease needs k signatures including its issuer's, and **any** authority reporting it inactive refuses it. Start each authority with the others' public keys (`--peer-pub b.pub c.pub`) so it can co-sign.

### 6. Tripwires

```bash
npx -y network-ai@6.0.1 perpetual tripwires --workspace /srv/agent/workspace --manifest /etc/nai/tripwires.json
npx -y network-ai@6.0.1 perpetual proxy ... --tripwires /etc/nai/tripwires.json      # NETWORK_AI_LEASE_SENTRY_SECRET_PROXY set
npx -y network-ai@6.0.1 perpetual sentry --id files --audit-log ... --tripwires /etc/nai/tripwires.json
```

Decoy credentials and files look real. Any request carrying a decoy is refused (generic 403, never forwarded) and reported as `sentry:proxy`; with `stopWhen.tripwire` every run is revoked at once and the authority latches — no new run gets a lease until an operator runs `perpetual resume`.

### 7. Human checkpoints

```bash
npx -y network-ai@6.0.1 perpetual checkpoint --all --key operator.key --policy policy.signed.json --authority-url https://a1 …
```

Checkpoints are bound to the reviewed policy hash, expire within an hour of signing, and are single-use. Without one, renewal stops at `humanCheckpointEveryMs` and the run halts within one lease.

### 8. Attestation and capability evaluations

- Configure a verifier for your platform (`AttestationVerifier`: TPM quote, SEV-SNP, TDX, Nitro). The reference `SignedQuoteVerifier` (`--attestation-pub`) is for software-measured boot and tests.
- Every lease carries a fresh nonce; each renewal must present evidence bound to it with a listed measurement. Changing the image or binaries changes the measurement, so renewal fails — without anything having to detect the change. Co-signing authorities check the evidence independently.
- Install capability evaluations with `perpetual sign-capability-eval` (evaluator key) and `perpetual capability-eval` (operator). Gated scopes get no lease without a valid, unexpired, passing evaluation.

### 9. Audit

- Feed authority, proxy, relay, and sentry events into `HashChainSink` with `{ merkle: new MerkleAuditLog() }`.
- Sign tree heads with a dedicated log key and send them, with consistency proofs, to a `FileWitness` (or your own witness) on storage the log host cannot rewrite. Rollback and forks are refused.
- Attach inclusion proofs to high-stakes blackboard facts and inter-agent messages; consumers use `classifyClaim` and can require `proven`.

### 10. Control-plane hosts and physical layer

- dm-verity plus IPE (execute only signed images) on authority, proxy, and relay hosts.
- Optional BPF-LSM tooling (Tetragon, Falco) feeding events into sentries via `AuditTail`. Network-AI ships no kernel or eBPF code.
- Confidential VMs (SEV-SNP / TDX) for authorities where available.
- An out-of-band way to cut power and network to agent hosts; keys on hardware tokens.

## Compromise runbook

1. `perpetual revoke --all` and `perpetual pause` at **every** authority (any one is enough to stop runs; do all to be sure).
2. Isolate the agent hosts (network and power, out of band).
3. Roll state back to the last verified snapshot (`perpetual rollback`).
4. Rotate the operator key, authority keys, role secrets, upstream credentials, and the decoy manifest.
5. Verify the Merkle audit against the witness (consistency from the last witnessed head).
6. Write a postmortem before resuming; resuming needs a newly signed policy and a fresh checkpoint.

## Drills

Run these before trusting a deployment, and after any change to it. Each is also covered by the automated suites (`test-perpetual*.ts`).

| # | Drill | Expected |
|---|---|---|
| 1 | Kill the authority process | The run halts within one lease TTL |
| 2 | Revoke the run at one of k authorities | The run halts; the proxy refuses its lease |
| 3 | Modify a binary in the agent image | The next renewal is refused; the run halts |
| 4 | Use a decoy credential | Request refused; every run revoked |
| 5 | Let a human checkpoint lapse | Renewal stops at the deadline |
| 6 | Send malformed or fuzzed frames to the relay or authority | No grant, no crash |

## What is not covered

- Kernel, eBPF, or hypervisor code inside the library — deployment tooling only.
- Shipping a hypervisor or TEE stack — bring-your-own runners and verifiers.
- Formal proofs of agent behaviour. `references/formal/PerpetualCore.lean` proves properties of the decision core's model (absorbing stops, monotone spend, tighten-only, k-to-grant / one-to-stop); the specification gap remains, and every runtime control stays in place.
