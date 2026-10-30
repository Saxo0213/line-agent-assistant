import { describe, expect, it } from 'vitest';
import { CHROME_EXTENSION_STORE_URL, ChromeLtsmInstallResultSchema, ChromeLtsmStatusSchema } from './chrome-login.js';
import { IpcRequestSchema, IpcResultSchema, LineAccountSummarySchema } from './ipc.js';

describe('Chrome login IPC contracts', () => {
  it('accepts the new requests and rejects extra or invalid fields', () => {
    // There is no request that changes the login method of an existing account.
    expect(IpcRequestSchema.safeParse({ type: 'setAccountLineTransport', requestId: 'r', accountId: 'a', lineTransport: 'CHROMEOS' }).success).toBe(false);
    for (const type of ['getChromeLoginAvailability', 'detectChromeLtsm', 'chooseChromeLtsmFolder', 'openChromeExtensionStore']) {
      expect(IpcRequestSchema.safeParse({ type, requestId: 'r' }).success).toBe(true);
      // The renderer cannot give a path or a URL.
      expect(IpcRequestSchema.safeParse({ type, requestId: 'r', path: 'C:\\x' }).success).toBe(false);
      expect(IpcRequestSchema.safeParse({ type, requestId: 'r', url: 'https://example.com' }).success).toBe(false);
    }
  });

  it('lets login requests carry an optional login method', () => {
    expect(IpcRequestSchema.safeParse({ type: 'lineAddAccountQr', requestId: 'r' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'lineAddAccountQr', requestId: 'r', lineTransport: 'CHROMEOS' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'lineReplaceAgentQr', requestId: 'r', accountId: 'a', lineTransport: 'DESKTOPWIN' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'lineAddAccountQr', requestId: 'r', lineTransport: 'x' }).success).toBe(false);
    // An existing account may switch its login method: lineLoginQr takes the same optional field.
    expect(IpcRequestSchema.safeParse({ type: 'lineLoginQr', requestId: 'r', accountId: 'a' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'lineLoginQr', requestId: 'r', accountId: 'a', lineTransport: 'CHROMEOS' }).success).toBe(true);
    expect(IpcRequestSchema.safeParse({ type: 'lineLoginQr', requestId: 'r', accountId: 'a', lineTransport: 'x' }).success).toBe(false);
  });

  it('validates results and the typed ltsm error', () => {
    const available = { kind: 'available', version: '3.7.2' };
    expect(IpcResultSchema.safeParse({ type: 'getChromeLoginAvailability', requestId: 'r', ok: true, status: available }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'getChromeLoginAvailability', requestId: 'r', ok: true,
      status: { kind: 'wrong-version', required: '3.7.2', detected: ['3.8.0'] } }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'getChromeLoginAvailability', requestId: 'r', ok: true, status: { kind: 'available', version: '3.7.2', dir: 'C:\\x' } }).success).toBe(false);
    expect(IpcResultSchema.safeParse({ type: 'detectChromeLtsm', requestId: 'r', ok: true, result: { kind: 'not-found', required: '3.7.2' } }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'chooseChromeLtsmFolder', requestId: 'r', ok: true, result: { kind: 'cancelled' } }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'detectChromeLtsm', requestId: 'r', ok: true, result: { kind: 'cancelled' } }).success).toBe(false);
    expect(IpcResultSchema.safeParse({ type: 'error', requestId: 'r', ok: false, code: 'CHROME_LTSM_UNAVAILABLE', message: 'm', retryable: false,
      chromeLtsmStatus: { kind: 'missing', required: '3.7.2' } }).success).toBe(true);
    expect(IpcResultSchema.safeParse({ type: 'error', requestId: 'r', ok: false, code: 'CHROME_LTSM_UNAVAILABLE', message: 'm', retryable: false,
      chromeLtsmStatus: available }).success).toBe(false);
  });

  it('exposes lineTransport on the account summary as optional', () => {
    const base = { accountId: 'a', displayName: 'A', status: 'connected', lastSyncedAt: null, mode: 'ACTIVE_CONTROL' };
    expect(LineAccountSummarySchema.parse(base)).not.toHaveProperty('lineTransport');
    expect(LineAccountSummarySchema.parse({ ...base, lineTransport: 'CHROMEOS' }).lineTransport).toBe('CHROMEOS');
    expect(LineAccountSummarySchema.safeParse({ ...base, lineTransport: 'WEB' }).success).toBe(false);
  });

  it('pins the Chrome Web Store URL and validates install results', () => {
    expect(CHROME_EXTENSION_STORE_URL).toBe('https://chromewebstore.google.com/detail/ophjlpahpchlmihnnnihgmmeilfjmjjc');
    expect(ChromeLtsmStatusSchema.safeParse({ kind: 'corrupt', required: '3.7.2', problems: ['ltsm.wasm: md5 mismatch'] }).success).toBe(true);
    expect(ChromeLtsmInstallResultSchema.safeParse({ kind: 'installed', status: { kind: 'available', version: '3.7.2' }, source: { browser: 'edge', profile: 'Default' } }).success).toBe(true);
  });
});
