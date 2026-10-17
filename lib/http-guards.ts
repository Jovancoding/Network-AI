/**
 * HTTP request guards shared by the local dashboard servers
 * (`DashboardServer`, `ControlPlane`, `WorkTreeDashboard`).
 *
 * Blocks DNS rebinding (Host header must name this server on a loopback
 * bind) and cross-site WebSocket hijacking (browser Origin must be the
 * server's own or explicitly allowlisted) — GHSA-hr6v-mfxm-4438.
 *
 * @module HttpGuards
 */

import type { IncomingMessage } from 'http';

/** Bind/host values treated as loopback. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || h.startsWith('127.');
}

/** Current server identity used to validate Host/Origin headers. */
export interface HostGuardConfig {
  /** Address the server is bound to */
  bindHost: string;
  /** Port the server is actually listening on */
  port: number;
  /** Extra accepted Host header values (lower-case) */
  allowedHosts: readonly string[];
  /** Extra accepted browser Origin values (exact match) */
  allowedOrigins: readonly string[];
}

/**
 * Accept the request only if its Host header names this server. On a loopback
 * bind, loopback names on the server's port are accepted; on a non-loopback
 * bind the header is enforced only when `allowedHosts` is configured, since a
 * wildcard bind has no knowable public name.
 */
export function isAllowedHostHeader(req: IncomingMessage, cfg: HostGuardConfig): boolean {
  const host = req.headers.host?.toLowerCase();
  if (!host) return false;
  if (cfg.allowedHosts.includes(host)) return true;
  if (!isLoopbackHost(cfg.bindHost) && cfg.allowedHosts.length === 0) return true;
  const suffixes = cfg.port === 80 ? ['', ':80'] : [`:${cfg.port}`];
  return ['127.0.0.1', 'localhost', '[::1]'].some(name => suffixes.some(s => host === name + s));
}

/**
 * Browsers always send Origin on a WebSocket handshake and do not apply
 * same-origin policy to it, so only the server's own origin (or an explicit
 * allowlist entry) may connect. Non-browser clients omit Origin.
 */
export function isAllowedOriginHeader(req: IncomingMessage, cfg: HostGuardConfig): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (cfg.allowedOrigins.includes(origin)) return true;
  return origin.toLowerCase() === `http://${req.headers.host?.toLowerCase()}`;
}
