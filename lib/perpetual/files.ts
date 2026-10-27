/**
 * Perpetual Runtime — key, policy, and route files for the CLI.
 *
 * Private keys are written once with mode 0600 and never overwritten.
 * Route files name the environment variable holding each upstream credential;
 * the credential itself is never stored in a file.
 *
 * @module PerpetualFiles
 */

import * as fs from 'fs';
import * as path from 'path';
import { createPrivateKey, createPublicKey, type KeyObject } from 'crypto';
import { generateEd25519KeyPair, keyIdOf, type Ed25519KeyPair } from './signing';
import type { ControlRole } from './types';
import type { EgressRoute } from './egress-proxy';
import type { AuthoritySecrets } from './lease-authority';

const KEY_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_FILE_BYTES = 1024 * 1024;

/** Paths written by {@link writeKeyPair}. */
export interface WrittenKeyPair {
  keyId: string;
  privateKeyPath: string;
  publicKeyPath: string;
}

/**
 * Generate an Ed25519 key pair and write `<name>.key` (PKCS#8 PEM, 0600) and
 * `<name>.pub` (SPKI PEM). Fails if either file already exists.
 */
export function writeKeyPair(dir: string, name: string): WrittenKeyPair {
  if (!KEY_NAME.test(name)) throw new TypeError('key name must be 1-64 characters of A-Z, a-z, 0-9, _ or -');
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  const privateKeyPath = path.join(root, `${name}.key`);
  const publicKeyPath = path.join(root, `${name}.pub`);
  if (fs.existsSync(privateKeyPath) || fs.existsSync(publicKeyPath)) {
    throw new Error(`refusing to overwrite existing key files for "${name}" in ${root}`);
  }
  const pair = generateEd25519KeyPair();
  fs.writeFileSync(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644, flag: 'wx' });
  return { keyId: pair.keyId, privateKeyPath, publicKeyPath };
}

function readBounded(file: string): string {
  const resolved = path.resolve(file);
  const size = fs.statSync(resolved).size;
  if (size > MAX_FILE_BYTES) throw new Error(`${resolved} is larger than ${MAX_FILE_BYTES} bytes`);
  return fs.readFileSync(resolved, 'utf8');
}

/** Read an Ed25519 public key (SPKI PEM). */
export function readPublicKey(file: string): KeyObject {
  const key = createPublicKey(readBounded(file));
  if (key.asymmetricKeyType !== 'ed25519') throw new TypeError(`${file} is not an Ed25519 public key`);
  return key;
}

/** Read an Ed25519 private key (PKCS#8 PEM) and derive its public half. */
export function readKeyPair(file: string): Ed25519KeyPair {
  const privateKey = createPrivateKey(readBounded(file));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError(`${file} is not an Ed25519 private key`);
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, keyId: keyIdOf(publicKey) };
}

/** Read and parse a JSON file of at most 1 MiB. */
export function readJsonFile(file: string): unknown {
  return JSON.parse(readBounded(file)) as unknown;
}

/**
 * Load egress routes from a JSON array:
 * `[{ name, upstream, methods?, pathPrefixes?, credential?: { header, env, prefix? } }]`.
 * Each `credential.env` must name a set environment variable.
 */
export function loadRoutes(file: string, env: NodeJS.ProcessEnv = process.env): EgressRoute[] {
  const raw = readJsonFile(file);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 256) throw new TypeError('routes file must be a JSON array of 1-256 routes');
  return raw.map((entry: unknown, i): EgressRoute => {
    if (!entry || typeof entry !== 'object') throw new TypeError(`route ${i} must be an object`);
    const r = entry as Record<string, unknown>;
    if (typeof r['name'] !== 'string' || typeof r['upstream'] !== 'string') throw new TypeError(`route ${i} needs string name and upstream`);
    const route: EgressRoute = {
      name: r['name'],
      upstream: r['upstream'],
      methods: stringList(r['methods'], `route ${i}.methods`),
      pathPrefixes: stringList(r['pathPrefixes'], `route ${i}.pathPrefixes`),
    };
    const fin = r['financial'];
    if (fin !== undefined) {
      const f = fin as Record<string, unknown>;
      if (!f || typeof f !== 'object' || typeof f['amountField'] !== 'string' || typeof f['maxPerRequestUsd'] !== 'number' || typeof f['maxPerRunUsd'] !== 'number') {
        throw new TypeError(`route ${i}.financial needs amountField, maxPerRequestUsd, maxPerRunUsd`);
      }
      route.financial = { amountField: f['amountField'], maxPerRequestUsd: f['maxPerRequestUsd'], maxPerRunUsd: f['maxPerRunUsd'] };
    }
    const cred = r['credential'];
    if (cred !== undefined) {
      if (!cred || typeof cred !== 'object') throw new TypeError(`route ${i}.credential must be an object`);
      const c = cred as Record<string, unknown>;
      if ('value' in c) throw new TypeError(`route ${i}.credential must reference an environment variable (env), not contain a value`);
      const envName = c['env'];
      if (typeof envName !== 'string' || !ENV_NAME.test(envName)) throw new TypeError(`route ${i}.credential.env must be an environment variable name`);
      if (typeof c['header'] !== 'string') throw new TypeError(`route ${i}.credential.header is required`);
      if (c['prefix'] !== undefined && typeof c['prefix'] !== 'string') throw new TypeError(`route ${i}.credential.prefix must be a string`);
      if (!env[envName]) throw new Error(`route ${i}: environment variable ${envName} is not set`);
      route.credential = {
        header: c['header'],
        prefix: c['prefix'] as string | undefined,
        value: () => {
          const v = env[envName];
          if (!v) throw new Error(`environment variable ${envName} is no longer set`);
          return v;
        },
      };
    }
    return route;
  });
}

function stringList(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new TypeError(`${label} must be an array of strings`);
  return value as string[];
}

/** Environment variable holding each role's bearer secret. */
export const ROLE_SECRET_ENV: Readonly<Record<ControlRole, string>> = {
  operator: 'NETWORK_AI_LEASE_OPERATOR_SECRET',
  sentry: 'NETWORK_AI_LEASE_SENTRY_SECRET',
  runner: 'NETWORK_AI_LEASE_RUNNER_SECRET',
};

/** Prefix for per-sentry secrets: `NETWORK_AI_LEASE_SENTRY_SECRET_<ID>` gives sentry `<id>` its own identity. */
export const SENTRY_SECRET_ENV_PREFIX = 'NETWORK_AI_LEASE_SENTRY_SECRET_';

/** Read the role secrets that are set; unset roles cannot connect. */
export function readRoleSecrets(env: NodeJS.ProcessEnv = process.env): AuthoritySecrets {
  const out: AuthoritySecrets = {};
  for (const role of Object.keys(ROLE_SECRET_ENV) as ControlRole[]) {
    const value = env[ROLE_SECRET_ENV[role]];
    if (value) out[role] = value;
  }
  const sentries: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(SENTRY_SECRET_ENV_PREFIX) && value) sentries[name.slice(SENTRY_SECRET_ENV_PREFIX.length).toLowerCase()] = value;
  }
  if (Object.keys(sentries).length > 0) out.sentries = sentries;
  return out;
}
