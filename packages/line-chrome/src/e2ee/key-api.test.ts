import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FakeServer, ok, thrift } from '../auth/auth.testkit.js';
import { THRIFT_ENDPOINTS, USED_ENDPOINTS } from '../endpoints.js';
import { ChromeApiError } from '../errors.js';
import { ChromeGateway } from '../gateway.js';
import { FakeHmacSigner } from '../signer.js';
import { classifyE2eeSendError, E2EE_ERROR_CODE, isRetryableE2eeSendError } from './send-errors.js';
import { E2EE_KEY_VERSION, GatewayE2eeKeyApi, type E2eeKeyApi } from './key-api.js';

const TALK = (m: string): string => thrift('Talk', 'TalkService', m);

function harness() {
  const server = new FakeServer();
  const gateway = new ChromeGateway({ fetch: server.fetch, signer: new FakeHmacSigner(), getAccessToken: () => 'tok' });
  return { server, api: new GatewayE2eeKeyApi(gateway) };
}

const bodyOf = (server: FakeServer, method: string): unknown => JSON.parse(server.to(TALK(method))[0]!.body!);

describe('GatewayE2eeKeyApi wire shape (OkLine services/e2ee.py:19-76)', () => {
  it('enforces keyVersion 1 on every key call', async () => {
    const { server, api } = harness();
    for (const m of ['getE2EEPublicKey', 'getE2EEGroupSharedKey', 'getLastE2EEGroupSharedKey', 'registerE2EEGroupKey']) {
      server.on(TALK(m), ok({}));
    }
    await api.getPublicKey('uPEER', 22);
    await api.getGroupSharedKey('cGROUP', 7);
    await api.getLastGroupSharedKey('cGROUP');
    await api.registerGroupKey('cGROUP', ['u1', 'u2'], [11, '22'], ['w1', 'w2']);
    expect(E2EE_KEY_VERSION).toBe(1);
    expect(bodyOf(server, 'getE2EEPublicKey')).toEqual(['uPEER', 1, 22]);
    expect(bodyOf(server, 'getE2EEGroupSharedKey')).toEqual([1, 'cGROUP', 7]);
    expect(bodyOf(server, 'getLastE2EEGroupSharedKey')).toEqual([1, 'cGROUP']);
    expect(bodyOf(server, 'registerE2EEGroupKey')).toEqual([1, 'cGROUP', ['u1', 'u2'], [11, 22], ['w1', 'w2']]);
  });

  it('negotiate, last public keys, own keys and media flow', async () => {
    const { server, api } = harness();
    for (const m of ['negotiateE2EEPublicKey', 'getLastE2EEPublicKeys', 'getE2EEPublicKeysEx', 'determineMediaMessageFlow']) {
      server.on(TALK(m), ok({}));
    }
    await api.negotiatePublicKey('uPEER');
    await api.getLastPublicKeys('cGROUP');
    await api.getOwnPublicKeys();
    await api.determineMediaMessageFlow('cGROUP');
    expect(bodyOf(server, 'negotiateE2EEPublicKey')).toEqual(['uPEER']);
    expect(bodyOf(server, 'getLastE2EEPublicKeys')).toEqual(['cGROUP']);
    expect(bodyOf(server, 'getE2EEPublicKeysEx')).toEqual([false, 1]);
    expect(bodyOf(server, 'determineMediaMessageFlow')).toEqual([{ chatMid: 'cGROUP' }]);
  });

  it('classes registerE2EEGroupKey as a write: a 5xx is not retried', async () => {
    const { server, api } = harness();
    server.on(TALK('registerE2EEGroupKey'), new Response('{"message":"x"}', { status: 500 }), ok({}));
    await expect(api.registerGroupKey('cGROUP', ['u1'], [1], ['w'])).rejects.toBeInstanceOf(Error);
    expect(server.to(TALK('registerE2EEGroupKey'))).toHaveLength(1);
  });
});

describe('registerE2EEPublicKey is never called', () => {
  it('is absent from the interface, the endpoint registry and the used set', () => {
    const { api } = harness();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(api)).concat(Object.keys(api));
    expect(surface.some((n) => /registerE2EEPublicKey|registerPublicKey/i.test(n))).toBe(false);
    expect(Object.keys(THRIFT_ENDPOINTS).some((k) => k.includes('registerE2EEPublicKey'))).toBe(false);
    expect(Object.keys(USED_ENDPOINTS).some((k) => k.includes('registerE2EEPublicKey'))).toBe(false);
    const typed: Array<keyof E2eeKeyApi> = [
      'getPublicKey',
      'negotiatePublicKey',
      'getOwnPublicKeys',
      'getLastPublicKeys',
      'getLastGroupSharedKey',
      'getGroupSharedKey',
      'registerGroupKey',
      'determineMediaMessageFlow',
    ];
    expect(typed).not.toContain('registerPublicKey' as never);
  });

  it('cannot be reached through the gateway at all', () => {
    const { server } = harness();
    const gateway = new ChromeGateway({ fetch: server.fetch, signer: new FakeHmacSigner(), getAccessToken: () => 'tok' });
    expect(() => gateway.call('Talk.TalkService.registerE2EEPublicKey' as never, [], { mode: 'write' })).toThrow(RangeError);
    expect(server.requests).toHaveLength(0);
  });

  it('no E2EE source line mentions it outside comments', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.testkit.ts'))) {
      const code = readFileSync(join(dir, file), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join('\n');
      expect(code, file).not.toMatch(/registerE2EEPublicKey/);
    }
  });
});

describe('send error classification (OkLine e2ee.py:68-79, :667-710)', () => {
  const err = (code: number): ChromeApiError => new ChromeApiError('e', { code, innerCode: code });

  it('maps the renegotiation codes, 99 and 122', () => {
    for (const code of [84, 86, 87, 88, 90]) {
      const cls = classifyE2eeSendError(err(code));
      expect(cls).toEqual({ kind: 'renegotiate', code });
      expect(isRetryableE2eeSendError(cls)).toBe(true);
    }
    expect(classifyE2eeSendError(err(99))).toEqual({ kind: 'recreate-group-key', code: 99 });
    expect(isRetryableE2eeSendError(classifyE2eeSendError(err(99)))).toBe(true);
    expect(classifyE2eeSendError(err(122))).toEqual({ kind: 'refresh-media-flow', code: 122 });
    expect(isRetryableE2eeSendError(classifyE2eeSendError(err(122)))).toBe(false);
  });

  it('does not treat 82, 89 or foreign errors as renegotiation', () => {
    expect(classifyE2eeSendError(err(E2EE_ERROR_CODE.RETRY_ENCRYPT)).kind).toBe('other');
    expect(classifyE2eeSendError(err(E2EE_ERROR_CODE.SENDER_NOT_ALLOWED)).kind).toBe('other');
    expect(classifyE2eeSendError(new Error('x'))).toEqual({ kind: 'other', code: undefined });
  });

  it('reads the inner code when the surfaced code is absent', () => {
    expect(classifyE2eeSendError(new ChromeApiError('e', { innerCode: 88 })).kind).toBe('renegotiate');
  });
});
