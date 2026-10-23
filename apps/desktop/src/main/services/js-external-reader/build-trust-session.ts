import type { ProtocolFrame } from './protocol.js';
import {
  initialOfficialBuildTrustState, isOfficialBuildIdentity, isOfficialBuildReason, isOfficialSignerThumbprint,
  officialBuildBridgeTrust, type OfficialBuildBridgeTrust, type OfficialBuildIdentity, type OfficialBuildTrustPort,
} from '../official-build-trust.js';

const KEY_FAILURE_CODES = new Set(['key_unavailable', 'snapshot_key_mismatch']);
// Schema/decode invariant failures. `mid_or_schema_mismatch` and `official_account_not_active` are deliberately
// absent: the bridge reports a wrong LINE account under the same code, so it
// cannot be attributed to the build and stays inconclusive.
const SCHEMA_FAILURE_CODES = new Set(['source_schema_unsupported', 'snapshot_database_header_invalid']);
const VERSION_PATTERN = /^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$/;

export const INVENTORY_BUILD_KEYS = ['buildCode', 'buildVersion', 'buildBytes', 'buildSha256'] as const;
export const FAILURE_BUILD_KEYS = ['buildReason', 'buildVersion', 'signerThumbprint'] as const;

/** Parses the build identity the bridge reports in its inventory frame. */
export function parseInventoryBuild(frame: ProtocolFrame): { code: 'accepted' | 'candidate'; build: OfficialBuildIdentity } | null {
  if (frame.buildCode !== 'accepted' && frame.buildCode !== 'candidate') return null;
  const build = { version: frame.buildVersion, bytes: frame.buildBytes, sha256: frame.buildSha256 };
  if (!isOfficialBuildIdentity(build)) return null;
  return { code: frame.buildCode, build };
}

/**
 * One reader session's view of build trust: supplies the persisted lists for
 * the `init` frame and turns the bridge's frames into trust events. Recording
 * is best effort: a persistence failure never fails the read itself, it only
 * leaves a candidate unpromoted until the next session.
 */
export class BuildTrustSession {
  readonly #port: OfficialBuildTrustPort | undefined;
  #observed: { code: 'accepted' | 'candidate'; build: OfficialBuildIdentity } | null = null;
  #settled = false;

  constructor(port?: OfficialBuildTrustPort) { this.#port = port; }

  async trustForInit(): Promise<OfficialBuildBridgeTrust> {
    if (!this.#port) return officialBuildBridgeTrust(initialOfficialBuildTrustState());
    return this.#port.bridgeTrust();
  }

  /** Throws `reader_inventory_invalid` when the build identity is missing or malformed. */
  async inventory(frame: ProtocolFrame): Promise<void> {
    const parsed = parseInventoryBuild(frame);
    if (!parsed) throw new Error('reader_inventory_invalid');
    this.#observed = parsed;
    await this.#record({ kind: 'observed', verdict: parsed.code, build: parsed.build });
  }

  /** Key validation, schema and MID checks passed: a candidate becomes accepted. */
  async validated(frame?: ProtocolFrame): Promise<void> {
    const observed = this.#observed;
    if (!observed || this.#settled) return;
    if (frame && frame.buildCode !== undefined && frame.buildCode !== observed.code) throw new Error('reader_inventory_result_invalid');
    if (frame && frame.buildVersion !== undefined && frame.buildVersion !== observed.build.version) throw new Error('reader_inventory_result_invalid');
    this.#settled = true;
    if (observed.code === 'candidate') await this.#record({ kind: 'validated', build: observed.build });
  }

  /** A native failure frame (`verdict: unsupported`) arrived before the session validated. */
  async failed(frame: ProtocolFrame): Promise<void> {
    if (this.#settled) return;
    const code = typeof frame.errorCode === 'string' ? frame.errorCode : '';
    const reason = isOfficialBuildReason(frame.buildReason) ? frame.buildReason : null;
    const version = typeof frame.buildVersion === 'string' && VERSION_PATTERN.test(frame.buildVersion) ? frame.buildVersion : null;
    if (frame.buildCode === 'rotation' && code === 'build_rotation') {
      this.#settled = true;
      await this.#record({ kind: 'blocked', verdict: 'rotation', version, reason: reason ?? 'not_pinned',
        ...(isOfficialSignerThumbprint(frame.signerThumbprint) ? { thumbprint: frame.signerThumbprint } : {}) });
      return;
    }
    if (frame.buildCode === 'unsupported' && code === 'unsupported_build') {
      this.#settled = true;
      await this.#record({ kind: 'blocked', verdict: 'untrusted', version, reason: reason ?? 'unsupported_build' });
      return;
    }
    const observed = this.#observed;
    if (!observed || observed.code !== 'candidate') return;
    const verdict = KEY_FAILURE_CODES.has(code) ? 'key_scan_failed' : SCHEMA_FAILURE_CODES.has(code) ? 'schema_changed' : null;
    this.#settled = true;
    if (verdict) await this.#record({ kind: 'failed', verdict, build: observed.build, reason: code });
  }

  async #record(event: Parameters<OfficialBuildTrustPort['record']>[0]): Promise<void> {
    if (!this.#port) return;
    try { await this.#port.record(event); } catch { /* best effort: see class comment */ }
  }
}
