import { describe, expect, it } from 'vitest';
import {
  CHROME_EXTENSION_VERSION, GATEWAY_BASE_URL, OBS_APPLICATION_HEADER, OBS_BASE_URL, USED_ENDPOINTS, specialPath, thriftPath,
  type PhysicalRequest, type ThriftEndpointKey,
} from '@line-agent/line-chrome';
import {
  createChromeMutationGate, type ChromeEffectContext, type ChromeMutationGate,
} from './chrome-mutation-gate.js';
import { EffectDeniedError, type EffectPhase, type ControlLease } from './mutation-gate.js';

const lease: ControlLease = { accountId: 'a', workerInstanceId: 'w', controlEpoch: 1 };
const TOKEN = 'access-token';

function makeGate(overrides: Partial<{ valid: boolean; now: () => number }> = {}): ChromeMutationGate {
  return createChromeMutationGate({
    accountId: 'a', workerInstanceId: 'w', controlEpoch: 1,
    validateControlLease: () => overrides.valid ?? true,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
}

function physical(key: ThriftEndpointKey, over: Partial<PhysicalRequest> = {}): PhysicalRequest {
  const path = thriftPath(key);
  const access = USED_ENDPOINTS[key]!.access;
  return { method: 'POST', url: GATEWAY_BASE_URL + path, path, pathWithQuery: path,
    headers: [['accept', 'application/json'], ['X-Line-Access', TOKEN]], body: '[]',
    mode: access === 'read' ? 'read' : 'write', endpointKey: key, attempt: 0, replay: false, ...over };
}
function sse(query = `version=${CHROME_EXTENSION_VERSION}&language=en_US&lastPartialFullSyncs=%7B%7D&localRev=12`, over: Partial<PhysicalRequest> = {}): PhysicalRequest {
  const path = specialPath('operation.receive');
  return { method: 'GET', url: `${GATEWAY_BASE_URL}${path}?${query}`, path, pathWithQuery: `${path}?${query}`,
    headers: [['accept', 'text/event-stream'], ['X-Line-Access', TOKEN]], body: undefined, mode: 'read',
    endpointKey: undefined, attempt: 0, replay: false, ...over };
}
function tokenRefresh(body = '{"refreshToken":"r"}', over: Partial<PhysicalRequest> = {}): PhysicalRequest {
  const path = specialPath('auth.tokenRefresh');
  return { method: 'POST', url: GATEWAY_BASE_URL + path, path, pathWithQuery: path, headers: [['X-Line-Access', TOKEN]], body,
    mode: 'write', endpointKey: undefined, attempt: 0, replay: false, ...over };
}

function context(phase: EffectPhase): ChromeEffectContext {
  if (phase === 'CONTROL_READ' || phase === 'CONTROL_SEND' || phase === 'MANUAL_SEND') return { phase, lease };
  if (phase === 'SERVER_LOGOUT') return { phase, serverLogoutToken: TOKEN };
  return { phase };
}
async function allowed(gate: ChromeMutationGate, phase: EffectPhase, request: PhysicalRequest): Promise<boolean> {
  const hook = gate.beforeRequest();
  try { await gate.run(context(phase), () => hook(request)); return true; }
  catch (error) { if (error instanceof EffectDeniedError) return false; throw error; }
}

const QR_KEYS: ThriftEndpointKey[] = [
  'LoginQrCode.SecondaryQrCodeLoginService.createSession', 'LoginQrCode.SecondaryQrCodeLoginService.createQrCode',
  'LoginQrCode.SecondaryQrCodeLoginService.verifyCertificate', 'LoginQrCode.SecondaryQrCodeLoginService.createPinCode',
  'LoginQrCode.SecondaryQrCodeLoginService.qrCodeLoginV2',
  'LoginQrCode.SecondaryQrCodeLoginPermitNoticeService.checkQrCodeVerified',
  'LoginQrCode.SecondaryQrCodeLoginPermitNoticeService.checkPinCodeVerified',
];
const SESSION_READS: ThriftEndpointKey[] = ['Talk.TalkService.getProfile', 'Talk.TalkService.getLastOpRevision'];
const CATALOG_READS: ThriftEndpointKey[] = ['Talk.TalkService.getAllChatMids', 'Talk.TalkService.getMessageBoxes',
  'Talk.TalkService.getChats', 'Talk.TalkService.getContactsV2', 'Talk.TalkService.getRecentMessagesV2',
  'Talk.TalkService.getPreviousMessagesV2WithRequest'];
const E2EE_READS: ThriftEndpointKey[] = ['Talk.TalkService.getE2EEPublicKey', 'Talk.TalkService.negotiateE2EEPublicKey',
  'Talk.TalkService.getLastE2EEPublicKeys', 'Talk.TalkService.getE2EEGroupSharedKey',
  'Talk.TalkService.getLastE2EEGroupSharedKey'];
const MEDIA_READS: ThriftEndpointKey[] = ['Talk.TalkService.acquireEncryptedAccessToken', 'Talk.TalkService.determineMediaMessageFlow'];
const RESOURCE_READS: ThriftEndpointKey[] = ['Talk.ChannelService.issueChannelToken'];
const CONTACT_READS: ThriftEndpointKey[] = ['Talk.TalkService.getAllContactIds', 'Talk.TalkService.getBlockedContactIds'];
const SEND_WRITES: ThriftEndpointKey[] = ['Talk.TalkService.sendMessage', 'Talk.TalkService.unsendMessage', 'Talk.TalkService.react',
  'Talk.TalkService.cancelReaction', 'Relation.RelationService.addFriendByMid'];
const KEY_WRITE: ThriftEndpointKey = 'Talk.TalkService.registerE2EEGroupKey';
const LOGOUT: ThriftEndpointKey = 'Talk.AuthService.logoutV2';

const EVERY_KEY = Object.keys(USED_ENDPOINTS) as ThriftEndpointKey[];
const ALL_READS = [...SESSION_READS, ...CATALOG_READS, ...E2EE_READS, ...MEDIA_READS, ...CONTACT_READS, ...RESOURCE_READS];

describe('CHROMEOS gate: endpoint coverage', () => {
  it('classifies every USED_ENDPOINTS entry (a new endpoint must be placed deliberately)', () => {
    const classified = new Set<ThriftEndpointKey>([...QR_KEYS, ...ALL_READS, ...SEND_WRITES, KEY_WRITE, LOGOUT]);
    expect([...classified].sort()).toEqual([...EVERY_KEY].sort());
  });
});

describe('CHROMEOS gate: getE2EEPublicKeysEx is not part of the profile', () => {
  it('is absent from USED_ENDPOINTS and denied in every phase', async () => {
    expect(Object.keys(USED_ENDPOINTS)).not.toContain('Talk.TalkService.getE2EEPublicKeysEx');
    const path = thriftPath('Talk.TalkService.getE2EEPublicKeysEx');
    const request = { ...physical('Talk.TalkService.getE2EEPublicKey'), path, pathWithQuery: path, url: GATEWAY_BASE_URL + path, endpointKey: undefined };
    for (const phase of ['MONITOR_READ', 'CONTROL_READ', 'CONTROL_SEND', 'MANUAL_SEND'] as const) {
      expect(await allowed(makeGate(), phase, request), phase).toBe(false);
    }
  });
});

describe('CHROMEOS gate: allow/deny matrix per phase', () => {
  const expected: Record<string, ThriftEndpointKey[]> = {
    AUTH_BOOTSTRAP: [...QR_KEYS, 'Talk.TalkService.getProfile'],
    MONITOR_READ: [...SESSION_READS, ...CATALOG_READS, ...E2EE_READS, ...MEDIA_READS, ...RESOURCE_READS],
    CONTROL_READ: ALL_READS,
    CONTROL_SEND: [...E2EE_READS, ...MEDIA_READS, ...SEND_WRITES, KEY_WRITE],
    MANUAL_SEND: [...E2EE_READS, ...MEDIA_READS, 'Talk.TalkService.sendMessage', 'Talk.TalkService.unsendMessage', KEY_WRITE],
    SERVER_LOGOUT: [LOGOUT],
  };
  for (const [phase, keys] of Object.entries(expected)) {
    it(`${phase} allows exactly its endpoints`, async () => {
      for (const key of EVERY_KEY) {
        const gate = makeGate();
        expect(await allowed(gate, phase as EffectPhase, physical(key, key === 'Talk.ChannelService.issueChannelToken' ? { body: '["1341209850"]' } : {})), `${phase} ${key}`).toBe(keys.includes(key));
      }
    });
  }
  it('denies the DESKTOPWIN-only channel-token phase outright', async () => {
    const gate = makeGate();
    await expect(gate.run({ phase: 'CHAT_RESOURCE_BOOTSTRAP' }, async () => undefined)).rejects.toBeInstanceOf(EffectDeniedError);
  });
  it('denies a gateway path that is not in the registry and non-registry thrift paths', async () => {
    const gate = makeGate();
    const path = '/api/talk/thrift/Talk/TalkService/getProfile2';
    expect(await allowed(gate, 'CONTROL_READ', physical('Talk.TalkService.getProfile', { path, pathWithQuery: path, url: GATEWAY_BASE_URL + path }))).toBe(false);
    const timeline = '/api/timeline/homeId';
    expect(await allowed(gate, 'CONTROL_READ', physical('Talk.TalkService.getProfile', { path: timeline, pathWithQuery: timeline, url: GATEWAY_BASE_URL + timeline }))).toBe(false);
  });
  it('requires the call mode to match the endpoint access', async () => {
    expect(await allowed(makeGate(), 'CONTROL_SEND', physical('Talk.TalkService.sendMessage', { mode: 'read' }))).toBe(false);
    expect(await allowed(makeGate(), 'CONTROL_READ', physical('Talk.TalkService.getProfile', { mode: 'write' }))).toBe(false);
    expect(await allowed(makeGate(), 'AUTH_BOOTSTRAP', physical(QR_KEYS[0]!, { mode: 'read' }))).toBe(false);
    expect(await allowed(makeGate(), 'CONTROL_READ', physical('Talk.TalkService.getProfile', { endpointKey: 'Talk.TalkService.getContactsV2' }))).toBe(false);
  });
});

describe('CHROMEOS gate: token refresh and the event stream', () => {
  it('allows tokenRefresh only in AUTH_BOOTSTRAP with exactly the refresh token body', async () => {
    expect(await allowed(makeGate(), 'AUTH_BOOTSTRAP', tokenRefresh())).toBe(true);
    for (const phase of ['MONITOR_READ', 'CONTROL_READ', 'CONTROL_SEND', 'MANUAL_SEND', 'SERVER_LOGOUT'] as const) {
      expect(await allowed(makeGate(), phase, tokenRefresh()), phase).toBe(false);
    }
    expect(await allowed(makeGate(), 'AUTH_BOOTSTRAP', tokenRefresh('{"refreshToken":"r","extra":1}'))).toBe(false);
    expect(await allowed(makeGate(), 'AUTH_BOOTSTRAP', tokenRefresh('{"refreshToken":1}'))).toBe(false);
    expect(await allowed(makeGate(), 'AUTH_BOOTSTRAP', tokenRefresh('["r"]'))).toBe(false);
    expect(await allowed(makeGate(), 'AUTH_BOOTSTRAP', tokenRefresh('not json'))).toBe(false);
    expect(await allowed(makeGate(), 'AUTH_BOOTSTRAP', tokenRefresh('{"refreshToken":"r"}', { mode: 'read' }))).toBe(false);
  });
  it('allows the SSE GET only as a read stream with the fixed query shape', async () => {
    expect(await allowed(makeGate(), 'MONITOR_READ', sse())).toBe(true);
    expect(await allowed(makeGate(), 'CONTROL_READ', sse())).toBe(true);
    expect(await allowed(makeGate(), 'CONTROL_READ', sse(`version=${CHROME_EXTENSION_VERSION}&language=en_US&lastPartialFullSyncs=%7B%7D&localRev=0&fullSyncRequestReason=x`))).toBe(false); // exactly four keys (OkLine operations.py:385-386)
    for (const phase of ['AUTH_BOOTSTRAP', 'CONTROL_SEND', 'MANUAL_SEND', 'SERVER_LOGOUT'] as const) {
      expect(await allowed(makeGate(), phase, sse()), phase).toBe(false);
    }
    expect(await allowed(makeGate(), 'CONTROL_READ', sse('version=3.7.1&language=en_US&lastPartialFullSyncs=%7B%7D&localRev=12'))).toBe(false);
    expect(await allowed(makeGate(), 'CONTROL_READ', sse('language=en_US&version=3.7.2&lastPartialFullSyncs=%7B%7D&localRev=12'))).toBe(false);
    expect(await allowed(makeGate(), 'CONTROL_READ', sse(`version=${CHROME_EXTENSION_VERSION}&language=en_US&lastPartialFullSyncs=%7B%7D&localRev=-1`))).toBe(false);
    expect(await allowed(makeGate(), 'CONTROL_READ', sse(`version=${CHROME_EXTENSION_VERSION}&language=en_US&lastPartialFullSyncs=%7B%7D&localRev=1&x=1`))).toBe(false);
    expect(await allowed(makeGate(), 'CONTROL_READ', sse(undefined, { mode: 'write' }))).toBe(false);
    expect(await allowed(makeGate(), 'CONTROL_READ', sse(undefined, { method: 'POST', body: '[]' }))).toBe(false);
  });
  it('allows no other GET', async () => {
    expect(await allowed(makeGate(), 'CONTROL_READ', physical('Talk.TalkService.getProfile', { method: 'GET', body: undefined }))).toBe(false);
  });
});

describe('CHROMEOS gate: host binding', () => {
  it('pins the gateway origin and rejects everything else', async () => {
    const base = physical('Talk.TalkService.getProfile');
    const path = base.path;
    for (const url of [
      `https://evil.example${path}`, `https://obs.line-apps.com${path}`, `http://line-chrome-gw.line-apps.com${path}`,
      `https://line-chrome-gw.line-apps.com:8443${path}`, `https://user:pw@line-chrome-gw.line-apps.com${path}`,
      `https://line-chrome-gw.line-apps.com.evil.example${path}`, `${GATEWAY_BASE_URL}${path}#frag`,
    ]) {
      expect(await allowed(makeGate(), 'CONTROL_READ', { ...base, url }), url).toBe(false);
    }
    expect(await allowed(makeGate(), 'CONTROL_READ', base)).toBe(true);
  });
  it('rejects a query string on a POST, a url/path drift, X-Line-Application and cookies', async () => {
    const base = physical('Talk.TalkService.getProfile');
    expect(await allowed(makeGate(), 'CONTROL_READ', { ...base, url: `${base.url}?a=1`, pathWithQuery: `${base.path}?a=1` })).toBe(false);
    expect(await allowed(makeGate(), 'CONTROL_READ', { ...base, path: thriftPath('Talk.TalkService.getContactsV2') })).toBe(false);
    expect(await allowed(makeGate(), 'CONTROL_READ', { ...base, headers: [...base.headers, ['X-Line-Application', OBS_APPLICATION_HEADER]] })).toBe(false);
    expect(await allowed(makeGate(), 'CONTROL_READ', { ...base, headers: [...base.headers, ['Cookie', 'lct=1']] })).toBe(false);
    expect(await allowed(makeGate(), 'CONTROL_READ', { ...base, body: undefined })).toBe(false);
  });
});

describe('CHROMEOS gate: single-use write permit', () => {
  it('lets a send phase carry one write and one group-key registration', async () => {
    const gate = makeGate();
    const hook = gate.beforeRequest();
    await gate.run(context('CONTROL_SEND'), async () => {
      await hook(physical('Talk.TalkService.getE2EEPublicKey'));
      await hook(physical('Talk.TalkService.getE2EEPublicKey'));
      await hook(physical(KEY_WRITE));
      await expect(hook(physical(KEY_WRITE))).rejects.toBeInstanceOf(EffectDeniedError);
      await hook(physical('Talk.TalkService.sendMessage'));
      await expect(hook(physical('Talk.TalkService.sendMessage'))).rejects.toThrow(/single-use/);
      await expect(hook(physical('Talk.TalkService.unsendMessage'))).rejects.toThrow(/single-use/);
      await hook(physical('Talk.TalkService.getE2EEPublicKey')); // reads stay available
    });
  });
  it('gives every run a fresh permit (the single renegotiation retry opens its own)', async () => {
    const gate = makeGate();
    const hook = gate.beforeRequest();
    await gate.run(context('MANUAL_SEND'), () => hook(physical('Talk.TalkService.sendMessage')));
    await gate.run(context('MANUAL_SEND'), () => hook(physical('Talk.TalkService.sendMessage')));
  });
  it('lets exactly one of two concurrent writes through', async () => {
    const gate = makeGate();
    const hook = gate.beforeRequest();
    const outcomes = await gate.run(context('CONTROL_SEND'), () => Promise.allSettled([
      hook(physical('Talk.TalkService.sendMessage')), hook(physical('Talk.TalkService.sendMessage'))]));
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
  });
  it('allows a server logout once, only with the existing token', async () => {
    const gate = makeGate();
    const hook = gate.beforeRequest();
    await gate.run(context('SERVER_LOGOUT'), async () => {
      await expect(hook(physical(LOGOUT, { headers: [['X-Line-Access', 'other']] }))).rejects.toThrow(/token/);
      await hook(physical(LOGOUT));
      await expect(hook(physical(LOGOUT))).rejects.toThrow(/single-use/);
    });
    await expect(gate.run({ phase: 'SERVER_LOGOUT' }, async () => undefined)).rejects.toBeInstanceOf(EffectDeniedError);
    await expect(gate.run({ phase: 'CONTROL_READ', serverLogoutToken: TOKEN, lease }, async () => undefined)).rejects.toBeInstanceOf(EffectDeniedError);
  });
  it('does not let a standing hook authorise writes or run outside a permit', async () => {
    const gate = makeGate();
    const standing = (phase: EffectPhase) => gate.beforeRequestFor(() => context(phase));
    await expect(standing('CONTROL_SEND')(physical('Talk.TalkService.sendMessage'))).rejects.toBeInstanceOf(EffectDeniedError);
    await expect(standing('MANUAL_SEND')(physical('Talk.TalkService.sendMessage'))).rejects.toBeInstanceOf(EffectDeniedError);
    await expect(standing('SERVER_LOGOUT')(physical(LOGOUT))).rejects.toBeInstanceOf(EffectDeniedError);
    await standing('CONTROL_READ')(physical('Talk.TalkService.getProfile'));
    await standing('CONTROL_READ')(physical('Talk.TalkService.getProfile')); // standing reads are multi-use
    await expect(gate.beforeRequest()(physical('Talk.TalkService.getProfile'))).rejects.toThrow(/no active effect context/);
  });
  it('closes the permit when the run ends', async () => {
    const gate = makeGate();
    const hook = gate.beforeRequest();
    let leaked: Promise<void> | undefined;
    await gate.run(context('CONTROL_READ'), async () => { leaked = new Promise((resolve) => setTimeout(resolve, 5)).then(() => hook(physical('Talk.TalkService.getProfile'))); });
    await expect(leaked).rejects.toBeInstanceOf(EffectDeniedError);
  });
  it('denies a cancelled context', async () => {
    const gate = makeGate();
    const controller = new AbortController();
    const hook = gate.beforeRequest();
    await gate.run({ phase: 'CONTROL_READ', lease, signal: controller.signal }, async () => {
      await hook(physical('Talk.TalkService.getProfile'));
      controller.abort();
      await expect(hook(physical('Talk.TalkService.getProfile'))).rejects.toThrow(/cancelled/);
    });
  });
});

describe('CHROMEOS gate: control lease', () => {
  it('requires a lease with the gate identity for control phases and none elsewhere', async () => {
    const gate = makeGate();
    await expect(gate.run({ phase: 'CONTROL_READ' }, async () => 1)).rejects.toBeInstanceOf(EffectDeniedError);
    await expect(gate.run({ phase: 'CONTROL_SEND', lease: { ...lease, workerInstanceId: 'x' } }, async () => 1)).rejects.toBeInstanceOf(EffectDeniedError);
    await expect(gate.run({ phase: 'CONTROL_SEND', lease: { ...lease, controlEpoch: 2 } }, async () => 1)).rejects.toBeInstanceOf(EffectDeniedError);
    await expect(gate.run({ phase: 'MONITOR_READ', lease }, async () => 1)).rejects.toBeInstanceOf(EffectDeniedError);
  });
  it('re-validates the lease on every request', async () => {
    let valid = true;
    const gate = createChromeMutationGate({ accountId: 'a', workerInstanceId: 'w', controlEpoch: 1, validateControlLease: () => valid });
    const hook = gate.beforeRequest();
    await gate.run(context('CONTROL_SEND'), async () => {
      valid = false;
      await expect(hook(physical('Talk.TalkService.sendMessage'))).rejects.toThrow(/stale or revoked/);
    });
    valid = true;
    await gate.run(context('CONTROL_SEND'), () => hook(physical('Talk.TalkService.sendMessage'))); // a denied lease did not burn a later permit
  });
  it('does not consume the write permit when the lease check fails', async () => {
    let valid = false;
    const gate = createChromeMutationGate({ accountId: 'a', workerInstanceId: 'w', controlEpoch: 1, validateControlLease: () => valid });
    const hook = gate.beforeRequest();
    await gate.run(context('CONTROL_SEND'), async () => {
      await expect(hook(physical('Talk.TalkService.sendMessage'))).rejects.toBeInstanceOf(EffectDeniedError);
      valid = true;
      await hook(physical('Talk.TalkService.sendMessage'));
    });
  });
});

describe('CHROMEOS gate: guarded fetch', () => {
  const fakeFetch = () => {
    const sent: Array<{ url: string; body: unknown }> = [];
    const fetch = async (url: string, init: RequestInit) => { sent.push({ url, body: init.body }); return new Response('{}'); };
    return { sent, fetch };
  };
  const wire = (request: PhysicalRequest): Array<[string, string]> => request.headers.map(([name, value]) => [name, value]);
  it('forwards only a request that a hook approved, once', async () => {
    const gate = makeGate();
    const { sent, fetch } = fakeFetch();
    const guarded = gate.guardFetch(fetch);
    const request = physical('Talk.TalkService.getProfile');
    await expect(guarded(request.url, { redirect: 'error', method: 'POST', body: '[]', headers: wire(request) })).rejects.toBeInstanceOf(EffectDeniedError);
    const hook = gate.beforeRequestFor(() => ({ phase: 'CONTROL_READ', lease }));
    await hook(request);
    await expect(guarded(request.url, { redirect: 'error', method: 'POST', body: '[1]', headers: wire(request) })).rejects.toBeInstanceOf(EffectDeniedError); // other body
    await expect(guarded(`${request.url}?x=1`, { redirect: 'error', method: 'POST', body: '[]', headers: wire(request) })).rejects.toBeInstanceOf(EffectDeniedError); // other url
    await guarded(request.url, { redirect: 'error', method: 'POST', body: '[]', headers: wire(request) });
    await expect(guarded(request.url, { redirect: 'error', method: 'POST', body: '[]', headers: wire(request) })).rejects.toBeInstanceOf(EffectDeniedError); // ticket spent
    expect(sent).toHaveLength(1);
  });
  it('does not forward a denied request and lets an approved ticket expire', async () => {
    let now = 1_000;
    const gate = makeGate({ now: () => now });
    const { sent, fetch } = fakeFetch();
    const guarded = gate.guardFetch(fetch);
    const request = physical('Talk.TalkService.sendMessage');
    await expect(gate.run(context('CONTROL_READ'), () => gate.beforeRequest()(request))).rejects.toBeInstanceOf(EffectDeniedError);
    await expect(guarded(request.url, { redirect: 'error', method: 'POST', body: '[]', headers: wire(request) })).rejects.toBeInstanceOf(EffectDeniedError);
    const read = physical('Talk.TalkService.getProfile');
    await gate.beforeRequestFor(() => ({ phase: 'CONTROL_READ', lease }))(read);
    now += 61_000;
    await expect(guarded(read.url, { redirect: 'error', method: 'POST', body: '[]', headers: wire(read) })).rejects.toBeInstanceOf(EffectDeniedError);
    expect(sent).toHaveLength(0);
  });
  it('approves a GET stream by method, url and headers', async () => {
    const gate = makeGate();
    const { sent, fetch } = fakeFetch();
    const request = sse();
    await gate.beforeRequestFor(() => ({ phase: 'MONITOR_READ' }))(request);
    await gate.guardFetch(fetch)(request.url, { redirect: 'error', method: 'GET', headers: wire(request) });
    expect(sent).toHaveLength(1);
  });
  it('binds the approval to the ordered header pairs: a changed value, name, order or an extra header is denied', async () => {
    const request = physical('Talk.TalkService.getProfile', { headers: [['accept', 'a'], ['X-Line-Access', TOKEN], ['X-Hmac', 'h']] });
    const variants: Array<Array<[string, string]>> = [
      [['accept', 'a'], ['X-Line-Access', 'other'], ['X-Hmac', 'h']], // other value
      [['accept', 'a'], ['X-Line-Access', TOKEN], ['X-Hmac', 'h2']],
      [['accept', 'a'], ['X-Line-Access', TOKEN]], // header removed
      [['accept', 'a'], ['X-Line-Access', TOKEN], ['X-Hmac', 'h'], ['X-Extra', '1']], // extra header
      [['X-Line-Access', TOKEN], ['accept', 'a'], ['X-Hmac', 'h']], // other order
      [['accept', 'a'], ['X-Line-Access', TOKEN], ['X-Other', 'h']], // other name
    ];
    for (const headers of variants) {
      const gate = makeGate();
      const { sent, fetch } = fakeFetch();
      const guarded = gate.guardFetch(fetch);
      await gate.beforeRequestFor(() => ({ phase: 'CONTROL_READ', lease }))(request);
      await expect(guarded(request.url, { redirect: 'error', method: 'POST', body: '[]', headers }), JSON.stringify(headers)).rejects.toBeInstanceOf(EffectDeniedError);
      expect(sent).toHaveLength(0);
    }
    // Header names compare in lower case, as HTTP does.
    const gate = makeGate();
    const { sent, fetch } = fakeFetch();
    await gate.beforeRequestFor(() => ({ phase: 'CONTROL_READ', lease }))(request);
    await gate.guardFetch(fetch)(request.url, { redirect: 'error', method: 'POST', body: '[]', headers: [['ACCEPT', 'a'], ['x-line-access', TOKEN], ['x-hmac', 'h']] });
    expect(sent).toHaveLength(1);
  });
  it('denies a request that does not block redirects before the network and keeps the ticket live', async () => {
    const gate = makeGate();
    const { sent, fetch } = fakeFetch();
    const guarded = gate.guardFetch(fetch);
    const request = physical('Talk.TalkService.getProfile');
    await gate.beforeRequestFor(() => ({ phase: 'CONTROL_READ', lease }))(request);
    await expect(guarded(request.url, { redirect: 'follow', method: 'POST', body: '[]', headers: wire(request) })).rejects.toThrow(/block redirects/);
    await expect(guarded(request.url, { method: 'POST', body: '[]', headers: wire(request) })).rejects.toThrow(/block redirects/);
    expect(sent).toHaveLength(0);
    await guarded(request.url, { redirect: 'error', method: 'POST', body: '[]', headers: wire(request) });
    expect(sent).toHaveLength(1);
    await expect(guarded(request.url, { redirect: 'error', method: 'POST', body: '[]', headers: wire(request) })).rejects.toBeInstanceOf(EffectDeniedError);
  });
  it('drops the tickets of a permit when its run ends', async () => {
    const gate = makeGate();
    const { sent, fetch } = fakeFetch();
    const guarded = gate.guardFetch(fetch);
    const request = physical('Talk.TalkService.sendMessage');
    await gate.run(context('CONTROL_SEND'), () => gate.beforeRequest()(request));
    await expect(guarded(request.url, { redirect: 'error', method: 'POST', body: '[]', headers: wire(request) })).rejects.toBeInstanceOf(EffectDeniedError);
    expect(sent).toHaveLength(0);
    // Inside the run the same ticket is still usable.
    await gate.run(context('CONTROL_SEND'), async () => {
      await gate.beforeRequest()(request);
      await guarded(request.url, { redirect: 'error', method: 'POST', body: '[]', headers: wire(request) });
    });
    expect(sent).toHaveLength(1);
  });
});

describe('CHROMEOS gate: OBS rules', () => {
  const obs = (path: string, over: Record<string, unknown> = {}) => ({
    method: 'GET' as const, url: `${OBS_BASE_URL}${path}`,
    headers: [['X-Line-Access', 'enc'], ['X-Line-Application', OBS_APPLICATION_HEADER]] as Array<[string, string]>, ...over,
  });
  it('approves private downloads on the pinned host with the pinned headers', async () => {
    const gate = makeGate();
    await gate.run(context('MONITOR_READ'), async () => {
    await gate.approveObsDownload({ phase: 'MONITOR_READ' }, obs('/r/talk/emi/abc123'));
    await gate.approveObsDownload({ phase: 'CONTROL_READ', lease }, obs('/r/talk/m/12345'));
    await gate.approveObsDownload({ phase: 'CONTROL_READ', lease }, obs('/r/talk/m/12345/original'));
    await gate.approveObsDownload({ phase: 'MONITOR_READ' }, obs('/r/talk/emf/abc123?p=pop-1'));
    for (const bad of [
      // DESKTOPWIN-only shapes: other namespaces, preview, preflight
      obs('/r/talk/m/12345/object_info.obs'), obs('/r/talk/m/12345/preview'), obs('/r/g2/m/12345'), obs('/r/talk/emi/abc123/object_info.obs'),
      obs('/r/talk/emi/abc123', { url: 'https://evil.example/r/talk/emi/abc123' }),
      obs('/r/talk/emi/abc123', { url: 'https://obs.line-apps.com:444/r/talk/emi/abc123' }),
      obs('/r/talk/xyz/abc123'), obs('/r/talk/emi/abc123?other=1'), obs('/r/talk/emi/abc123', { method: 'POST' }),
      obs('/r/talk/emi/abc123', { headers: [['X-Line-Access', 'enc']] }),
      obs('/r/talk/emi/abc123', { headers: [['X-Line-Application', 'CHROMEOS\t3.7.2\tChrome_OS']] }),
      obs('/r/talk/emi/abc123', { headers: [['X-Line-Application', OBS_APPLICATION_HEADER]] }),
      obs('/r/talk/emi/abc123', { headers: [['X-Line-Access', 'enc'], ['X-Line-Application', OBS_APPLICATION_HEADER], ['Cookie', 'x']] }),
    ]) {
      await expect(gate.approveObsDownload({ phase: 'MONITOR_READ' }, bad as never)).rejects.toBeInstanceOf(EffectDeniedError);
    }
    await expect(gate.approveObsDownload({ phase: 'CONTROL_READ' }, obs('/r/talk/emi/abc123'))).rejects.toBeInstanceOf(EffectDeniedError);
    });
  });
  it('denies a download approval outside a run', async () => {
    const gate = makeGate();
    await expect(gate.approveObsDownload({ phase: 'MONITOR_READ' }, obs('/r/talk/emi/abc123'))).rejects.toThrow(/active permit/);
    await expect(gate.approveAlbumPhotoDownload({ phase: 'MONITOR_READ' }, { method: 'GET', url: OBS_BASE_URL + '/r/album/a/oid-1/f482x482',
      headers: [['User-Agent', 'ua'], ['X-Line-ChannelToken', 'c'], ['X-Line-Mid', 'c1'], ['X-Line-Access', TOKEN]] })).rejects.toThrow(/active permit/);
  });
  it('consumes a standing approval once: a second identical fetch inside 60 s is denied', async () => {
    const gate = makeGate();
    const sent: string[] = [];
    const guarded = gate.guardFetch(async (url: string) => { sent.push(url); return new Response('x'); });
    const request = physical('Talk.TalkService.getProfile', { mode: 'read' });
    await gate.beforeRequestFor(() => ({ phase: 'MONITOR_READ' }))(request);
    await guarded(request.url, { redirect: 'error', method: 'POST', body: request.body, headers: request.headers });
    await expect(guarded(request.url, { redirect: 'error', method: 'POST', body: request.body, headers: request.headers })).rejects.toBeInstanceOf(EffectDeniedError);
    expect(sent).toHaveLength(1);
  });
  it('approves uploads only inside an open scope: exactly one POST per scope, for both kinds', async () => {
    const gate = makeGate();
    const id = '0123abcd-0123-4abc-8abc-0123456789ab';
    await expect(gate.approveMediaUpload(Object.freeze({ kind: 'image', lease, manual: false, close() {} }), obs(`/r/talk/emi/reqid-${id}`, { method: 'POST' }))).rejects.toBeInstanceOf(EffectDeniedError);
    const scope = gate.openMediaUploadScope(lease, 'image');
    await gate.approveMediaUpload(scope, obs(`/r/talk/emi/reqid-${id}`, { method: 'POST' }));
    await expect(gate.approveMediaUpload(scope, obs(`/r/talk/emi/reqid-${id}`, { method: 'POST' }))).rejects.toThrow(/limit/);
    // No second POST for an image either, and no preview upload path.
    await expect(gate.approveMediaUpload(scope, obs(`/r/talk/emi/reqid-${id.replace('0123abcd', '3123abcd')}`, { method: 'POST' }))).rejects.toThrow(/limit/);
    const previewScope = gate.openMediaUploadScope(lease, 'image');
    await expect(gate.approveMediaUpload(previewScope, obs('/r/talk/emi/0abc123__ud-preview', { method: 'POST' }))).rejects.toThrow(/allowlisted/);
    previewScope.close();
    await expect(gate.approveMediaUpload(scope, obs(`/r/talk/emf/reqid-${id}`, { method: 'POST' }))).rejects.toBeInstanceOf(EffectDeniedError);
    await expect(gate.approveMediaUpload(scope, obs(`/r/talk/emi/reqid-${id}?x=1`, { method: 'POST' }))).rejects.toBeInstanceOf(EffectDeniedError);
    scope.close();
    await expect(gate.approveMediaUpload(scope, obs(`/r/talk/emi/reqid-${id.replace('0123abcd', '1123abcd')}`, { method: 'POST' }))).rejects.toThrow(/open scope/);
    const files = gate.openMediaUploadScope(lease, 'file', true);
    await gate.approveMediaUpload(files, obs(`/r/talk/emf/reqid-${id}`, { method: 'POST' }));
    await expect(gate.approveMediaUpload(files, obs(`/r/talk/emf/reqid-${id.replace('0123abcd', '2123abcd')}`, { method: 'POST' }))).rejects.toThrow(/limit/);
    expect(() => gate.openMediaUploadScope({ ...lease, accountId: 'other' }, 'image')).toThrow(EffectDeniedError);
  });
  it('lets an approved OBS request reach the guarded fetch exactly once, with the approved headers', async () => {
    const gate = makeGate();
    const sent: string[] = [];
    const guarded = gate.guardFetch(async (url: string) => { sent.push(url); return new Response('x'); });
    const request = obs('/r/talk/emi/abc123');
    await gate.run(context('MONITOR_READ'), async () => {
      await gate.approveObsDownload({ phase: 'MONITOR_READ' }, request);
      await expect(guarded(request.url, { redirect: 'error', method: 'GET', headers: [['X-Line-Access', 'other'], ['X-Line-Application', OBS_APPLICATION_HEADER]] }))
        .rejects.toBeInstanceOf(EffectDeniedError);
      await guarded(request.url, { redirect: 'error', method: 'GET', headers: request.headers });
      await expect(guarded(request.url, { redirect: 'error', method: 'GET', headers: request.headers })).rejects.toBeInstanceOf(EffectDeniedError);
    });
    expect(sent).toHaveLength(1);
  });
  it('binds an upload ticket to its bytes and ends it when the scope closes', async () => {
    const gate = makeGate();
    const sent: string[] = [];
    const guarded = gate.guardFetch(async (url: string) => { sent.push(url); return new Response('x'); });
    const id = '0123abcd-0123-4abc-8abc-0123456789ab';
    const body = new Uint8Array([1, 2, 3, 4]);
    const request = { ...obs(`/r/talk/emi/reqid-${id}`, { method: 'POST' }), body };
    const scope = gate.openMediaUploadScope(lease, 'image');
    await gate.approveMediaUpload(scope, request);
    await expect(guarded(request.url, { redirect: 'error', method: 'POST', headers: request.headers, body: new Uint8Array([1, 2, 3, 5]) })).rejects.toBeInstanceOf(EffectDeniedError);
    await expect(guarded(request.url, { redirect: 'error', method: 'POST', headers: request.headers, body: new Uint8Array([1, 2, 3]) })).rejects.toBeInstanceOf(EffectDeniedError);
    await guarded(request.url, { redirect: 'error', method: 'POST', headers: request.headers, body: new Uint8Array([1, 2, 3, 4]) });
    expect(sent).toHaveLength(1);
    // A second scope: the ticket dies with the scope.
    const second = gate.openMediaUploadScope(lease, 'image');
    await gate.approveMediaUpload(second, request);
    second.close();
    await expect(guarded(request.url, { redirect: 'error', method: 'POST', headers: request.headers, body })).rejects.toBeInstanceOf(EffectDeniedError);
    expect(sent).toHaveLength(1);
  });
});

// -- albums (step 7): channel token + album photo GET, both from line-cli --------------------------------------------------

describe('CHROMEOS gate: album channel token', () => {
  const TOKEN_KEY: ThriftEndpointKey = 'Talk.ChannelService.issueChannelToken';
  it('allows issueChannelToken only in the read phases and only for the album channel id', async () => {
    for (const phase of ['MONITOR_READ', 'CONTROL_READ'] as const) {
      expect(await allowed(makeGate(), phase, physical(TOKEN_KEY, { body: '["1341209850"]' })), phase).toBe(true);
    }
    for (const phase of ['AUTH_BOOTSTRAP', 'CONTROL_SEND', 'MANUAL_SEND', 'SERVER_LOGOUT'] as const) {
      expect(await allowed(makeGate(), phase, physical(TOKEN_KEY, { body: '["1341209850"]' })), phase).toBe(false);
    }
    for (const body of ['[]', '["1375220249"]', '["1341209850","x"]', '[1341209850]', '["1341209850" ]', '{"channelId":"1341209850"}']) {
      expect(await allowed(makeGate(), 'CONTROL_READ', physical(TOKEN_KEY, { body })), body).toBe(false);
    }
    expect(await allowed(makeGate(), 'CONTROL_READ', physical(TOKEN_KEY, { body: '["1341209850"]', mode: 'write' }))).toBe(false);
  });
  it('still refuses the timeline gateway paths', async () => {
    const path = '/api/timeline/post/list';
    expect(await allowed(makeGate(), 'CONTROL_READ', physical('Talk.TalkService.getProfile', { path, pathWithQuery: path, url: GATEWAY_BASE_URL + path }))).toBe(false);
  });
});

describe('CHROMEOS gate: album photo download', () => {
  const albumUrl = (path = '/r/album/a/oid-1/f482x482') => OBS_BASE_URL + path;
  const albumHeaders = (over: Array<[string, string]> | null = null): Array<[string, string]> => over ?? [
    ['User-Agent', 'ua'], ['X-Line-ChannelToken', 'channel-token'], ['X-Line-Mid', 'c1'], ['X-Line-Album', 'album-1'], ['X-Line-Access', TOKEN]];
  const albumRequest = (over: Partial<{ method: 'GET' | 'POST'; url: string; headers: Array<[string, string]> }> = {}) =>
    ({ method: 'GET' as const, url: albumUrl(), headers: albumHeaders(), ...over });
  async function approve(phase: 'MONITOR_READ' | 'CONTROL_READ', request: ReturnType<typeof albumRequest>, gate = makeGate()): Promise<boolean> {
    try { await gate.run(context(phase), () => gate.approveAlbumPhotoDownload(phase === 'CONTROL_READ' ? { phase, lease } : { phase }, request)); return true; }
    catch (error) { if (error instanceof EffectDeniedError) return false; throw error; }
  }
  it('allows exactly the line-cli request in the read phases', async () => {
    expect(await approve('MONITOR_READ', albumRequest())).toBe(true);
    expect(await approve('CONTROL_READ', albumRequest())).toBe(true);
    expect(await approve('CONTROL_READ', albumRequest({ headers: albumHeaders().filter(([n]) => n !== 'X-Line-Album') }))).toBe(true);
  });
  it('denies other phases, methods, hosts, paths, queries and missing or forbidden headers', async () => {
    const gate = makeGate();
    await expect(gate.run(context('CONTROL_READ'), () => gate.approveAlbumPhotoDownload({ phase: 'CONTROL_SEND' as never, lease }, albumRequest()))).rejects.toBeInstanceOf(EffectDeniedError);
    expect(await approve('CONTROL_READ', albumRequest({ method: 'POST' }))).toBe(false);
    for (const url of [
      'https://evil.example/r/album/a/oid-1/f482x482', 'http://obs.line-apps.com/r/album/a/oid-1/f482x482', albumUrl('/r/album/v/oid-1/f482x482'),
      albumUrl('/r/album/a/oid-1/original'), albumUrl('/r/album/a/oid-1'), albumUrl('/r/album/a/oid-1/f482x482/extra'), albumUrl('/r/album/a//f482x482'),
      albumUrl('/r/talk/m/oid-1'), albumUrl('/r/myhome/h/oid-1'), albumUrl('/r/album/a/oid-1/f482x482?x=1'), albumUrl('/r/album/a/oid-1/f482x482#f'),
      albumUrl('/r/album/a/a/b/f482x482'),
    ]) expect(await approve('CONTROL_READ', albumRequest({ url })), url).toBe(false);
    for (const missing of ['X-Line-ChannelToken', 'X-Line-Mid', 'X-Line-Access']) {
      expect(await approve('CONTROL_READ', albumRequest({ headers: albumHeaders().filter(([n]) => n !== missing) })), missing).toBe(false);
    }
    expect(await approve('CONTROL_READ', albumRequest({ headers: [...albumHeaders(), ['X-Line-Application', OBS_APPLICATION_HEADER]] }))).toBe(false);
    expect(await approve('CONTROL_READ', albumRequest({ headers: [...albumHeaders(), ['Cookie', 'lct=1']] }))).toBe(false);
    expect(await approve('CONTROL_READ', albumRequest({ headers: [...albumHeaders(), ['Accept-Language', 'en_US']] }))).toBe(false);
    expect(await approve('CONTROL_READ', albumRequest({ headers: [...albumHeaders(), ['X-Line-Chrome-Version', CHROME_EXTENSION_VERSION]] }))).toBe(false);
  });
  it('checks the control lease in CONTROL_READ and gives a one-shot ticket to guardFetch', async () => {
    expect(await approve('CONTROL_READ', albumRequest(), makeGate({ valid: false }))).toBe(false);
    const gate = makeGate();
    let sent = 0;
    const guarded = gate.guardFetch(async () => { sent += 1; return new Response('x'); });
    await expect(guarded(albumUrl(), { redirect: 'error', method: 'GET', headers: albumHeaders() })).rejects.toBeInstanceOf(EffectDeniedError);
    await gate.run(context('CONTROL_READ'), async () => {
      await gate.approveAlbumPhotoDownload({ phase: 'CONTROL_READ', lease }, albumRequest());
      await expect(guarded(albumUrl(), { redirect: 'error', method: 'GET', headers: albumHeaders().filter(([n]) => n !== 'X-Line-Mid') })).rejects.toBeInstanceOf(EffectDeniedError);
      await guarded(albumUrl(), { redirect: 'error', method: 'GET', headers: albumHeaders() });
      await expect(guarded(albumUrl(), { redirect: 'error', method: 'GET', headers: albumHeaders() })).rejects.toBeInstanceOf(EffectDeniedError);
    });
    expect(sent).toBe(1);
  });
  it('keeps the private-media rules unchanged: an album-shaped request is not a message download', async () => {
    const gate = makeGate();
    await expect(gate.run(context('CONTROL_READ'), () => gate.approveObsDownload({ phase: 'CONTROL_READ', lease }, albumRequest()))).rejects.toBeInstanceOf(EffectDeniedError);
  });
});
