import { describe, expect, it } from 'vitest';
import { BridgeDownloadError, OfficialDownloadBridgeDownloader } from './bridge-download.js';
import { attachmentRawFields } from '../../../../../../packages/database/src/message-repository.js';
import { buildMessageFromNativeRow, nativeRowFromEnvelope, type NativeRowInput } from './native-message.js';

// Synthetic values only.
function row(overrides: { metadata?: Record<string, unknown>; info?: Record<string, unknown>; contentType?: number } = {}): NativeRowInput {
  const metadata = { SID: 'emi', OID: 'oid-1', e2eeMark: 2, MEDIA_CONTENT_INFO: '{"category":"original"}', FILE_SIZE: '3', ...overrides.metadata };
  const info = { keyMaterial: 'a2V5LW1hdGVyaWFsLXN5bnRoZXRpYy0wMDAwMDAwMDAwMDA=', fileName: 'info-name.pdf', ...overrides.info };
  return {
    columns: ['_id', '_contentType', '_contentMetadata', '_contentInfo', '_text'],
    cells: ['msg-1', overrides.contentType ?? 1, JSON.stringify(metadata), JSON.stringify(info), 'ignored'],
  };
}

describe('buildMessageFromNativeRow', () => {
  it('builds the message from a complete row and copies no other field', () => {
    expect(buildMessageFromNativeRow(row())).toEqual({
      id: 'msg-1', contentType: 1,
      contentMetadata: { SID: 'emi', e2eeVersion: '2', ENC_KM: 'a2V5LW1hdGVyaWFsLXN5bnRoZXRpYy0wMDAwMDAwMDAwMDA=', OID: 'oid-1',
        MEDIA_CONTENT_INFO: '{"category":"original"}', FILE_SIZE: '3' },
    });
  });

  it('takes FILE_NAME from the content info only for a file', () => {
    expect(buildMessageFromNativeRow(row({ contentType: 14 }))?.contentMetadata.FILE_NAME).toBe('info-name.pdf');
    expect(buildMessageFromNativeRow(row({ contentType: 1 }))?.contentMetadata.FILE_NAME).toBeUndefined();
  });

  it('returns null without keyMaterial, SID, e2ee version or a supported content type', () => {
    expect(buildMessageFromNativeRow(row({ info: { keyMaterial: undefined } }))).toBeNull();
    expect(buildMessageFromNativeRow(row({ metadata: { SID: undefined } }))).toBeNull();
    expect(buildMessageFromNativeRow(row({ metadata: { e2eeMark: undefined } }))).toBeNull();
    expect(buildMessageFromNativeRow(row({ contentType: 2 }))).toBeNull();
    expect(buildMessageFromNativeRow(null)).toBeNull();
  });
});

describe('native envelope of a stored External Monitor row', () => {
  // Real stored shape: raw.message for the worker, raw.native for the bridge. Synthetic values only.
  const raw = {
    message: { id: 'msg-1', contentType: 1 },
    native: {
      format: 2, encoding: 'plain', table: '_message',
      row: {
        columns: ['_id', '_contentType', '_contentMetadata', '_contentInfo'],
        cells: ['msg-1', { value: '1', sqliteType: 'integer' },
          JSON.stringify({ SID: 'emi', OID: 'oid-1', e2eeMark: 2 }), JSON.stringify({ keyMaterial: 'a2V5LW1hdGVyaWFsLXN5bnRoZXRpYy0wMDAwMDAwMDAwMDA=' })],
      },
    },
  };

  it('reaches the message builder through the repository mapping and keeps the worker message', () => {
    const fields = attachmentRawFields(raw as never);
    expect(fields.lineMessage).toEqual(raw.message);
    expect(buildMessageFromNativeRow(nativeRowFromEnvelope(fields.nativeEnvelope))).not.toBeNull();
  });

  it('gives no native row for a message without an envelope', () => {
    expect(attachmentRawFields({ id: 'x' } as never).nativeEnvelope).toBeNull();
    expect(nativeRowFromEnvelope(null)).toBeNull();
  });
});

type EbOutcome = { ok: false; code: string } | { ok: true };

function fakeLive(outcomes: EbOutcome[], options: { inStore?: boolean } = {}) {
  const calls: Array<{ kind: string; args?: Array<Record<string, unknown>> }> = [];
  let wrapper = 0;
  const wrapperOutcome = new Map<string, EbOutcome>();
  const cdp = {
    isClosed: false,
    async send(method: string, params: Record<string, any> = {}): Promise<Record<string, unknown>> {
      if (method === 'Runtime.releaseObject') return {};
      if (method === 'Runtime.getProperties') {
        const outcome = wrapperOutcome.get(params.objectId as string);
        if (!outcome) return { result: [] };
        return { result: outcome.ok
          ? [{ name: 'ok', value: { value: true } }, { name: 'file', value: { type: 'object', objectId: 'file-1' } }]
          : [{ name: 'ok', value: { value: false } }, { name: 'code', value: { value: outcome.code } }, { name: 'status', value: { value: null } }] };
      }
      const decl = String(params.functionDeclaration);
      if (params.objectId === 'eB') {
        calls.push({ kind: 'eB', args: params.arguments });
        const id = `wrapper-${wrapper++}`;
        wrapperOutcome.set(id, outcomes.shift() ?? { ok: false, code: 'UNKNOWN' });
        return { result: { type: 'object', objectId: id } };
      }
      if (decl.includes('hasOwnProperty')) {
        calls.push({ kind: 'find' });
        return { result: options.inStore === false ? { type: 'object', subtype: 'null' } : { type: 'object', objectId: 'store-msg' } };
      }
      if (decl.includes('this.dispatch')) { calls.push({ kind: 'dispatch' }); return { result: { value: { type: 'x/fulfilled', code: null, status: null } } }; }
      if (decl.includes('fileSize')) return { result: { value: { contentType: 1, fileSize: 3 } } };
      if (decl.includes('this.name')) return { result: { value: { name: 'photo.jpg', size: 3 } } };
      if (decl.includes('arrayBuffer')) return { result: { value: Buffer.from([1, 2, 3]).toString('base64') } };
      throw new Error(`unexpected call ${method} ${decl.slice(0, 40)}`);
    },
  };
  const live = { cdp, handles: { sessionId: 's', ids: { IA: 'IA', XC: 'XC', eB: 'eB', QO: 'QO', zD: 'zD' } } };
  return { live, calls };
}

const request = { chatType: 'group', messageId: 'msg-1', kind: 'file' as const, maxBytes: 1024 };

async function runWith(outcomes: EbOutcome[], source: 'native' | 'store', nativeRow: NativeRowInput | null, options: { inStore?: boolean } = {}) {
  const { live, calls } = fakeLive(outcomes, options);
  const downloader = new OfficialDownloadBridgeDownloader({ getLive: () => live as never, sleep: async () => undefined });
  const attemptsSeen: unknown[] = [];
  const result = await downloader.run({ ...request, source, nativeRow }, async (file) => {
    attemptsSeen.push(...file.attempts);
    const bytes: number[] = [];
    for await (const chunk of file.chunks) bytes.push(...chunk);
    return { name: file.name, bytes };
  });
  return { result, calls, attemptsSeen };
}

describe('bridge download', () => {
  it('calls eB one time with the built message and does not touch the store', async () => {
    const { result, calls, attemptsSeen } = await runWith([{ ok: true }], 'native', row());
    expect(result).toEqual({ name: 'photo.jpg', bytes: [1, 2, 3] });
    expect(calls.map((call) => call.kind)).toEqual(['eB']);
    expect(calls[0]?.args?.[0]).toHaveProperty('value');
    expect(calls[0]?.args?.[1]).toEqual({ value: 'media_viewer' });
    expect(attemptsSeen).toEqual([{ stage: 'native', code: null, httpStatus: null }]);
  });

  it('calls eB one time with the store message by object id', async () => {
    const { calls, attemptsSeen } = await runWith([{ ok: true }], 'store', row());
    expect(calls.map((call) => call.kind)).toEqual(['find', 'eB']);
    expect(calls[1]?.args?.[0]).toEqual({ objectId: 'store-msg' });
    expect(attemptsSeen).toEqual([{ stage: 'store', code: null, httpStatus: null }]);
  });

  it.each(['E2EE_HMAC_NOT_MATCHED', 'OBJECT_NOT_EXIST'])('makes no second attempt after native %s', async (code) => {
    const { live, calls } = fakeLive([{ ok: false, code }, { ok: true }]);
    const downloader = new OfficialDownloadBridgeDownloader({ getLive: () => live as never, sleep: async () => undefined });
    const error = await downloader.run({ ...request, source: 'native', nativeRow: row() }, async () => 'unused').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeDownloadError);
    expect((error as BridgeDownloadError).code).toBe(code);
    expect((error as BridgeDownloadError).isExpired).toBe(code === 'OBJECT_NOT_EXIST');
    expect((error as BridgeDownloadError).attempts).toEqual([{ stage: 'native', code, httpStatus: null }]);
    expect(calls.map((call) => call.kind)).toEqual(['eB']);
  });

  it('does not call eB when the row cannot build a message', async () => {
    const { live, calls } = fakeLive([{ ok: true }]);
    const downloader = new OfficialDownloadBridgeDownloader({ getLive: () => live as never, sleep: async () => undefined });
    const error = await downloader.run({ ...request, source: 'native', nativeRow: row({ info: { keyMaterial: undefined } }) }, async () => 'unused').catch((e: unknown) => e);
    expect((error as BridgeDownloadError).code).toBe('NATIVE_MESSAGE_INCOMPLETE');
    expect((error as BridgeDownloadError).attempts).toEqual([{ stage: 'native', code: 'NATIVE_MESSAGE_INCOMPLETE', httpStatus: null }]);
    expect(calls).toHaveLength(0);
  });

  it('does not load a chat or call eB when the store source has no message', async () => {
    const { live, calls } = fakeLive([{ ok: true }], { inStore: false });
    const downloader = new OfficialDownloadBridgeDownloader({ getLive: () => live as never, sleep: async () => undefined });
    const error = await downloader.run({ ...request, source: 'store', nativeRow: row() }, async () => 'unused').catch((e: unknown) => e);
    expect((error as BridgeDownloadError).code).toBe('MESSAGE_NOT_FOUND');
    expect((error as BridgeDownloadError).attempts).toEqual([{ stage: 'store', code: 'MESSAGE_NOT_FOUND', httpStatus: null }]);
    expect(calls.map((call) => call.kind)).toEqual(['find']);
  });

  it('never calls the extension for a community chat', async () => {
    const { live, calls } = fakeLive([{ ok: true }]);
    const downloader = new OfficialDownloadBridgeDownloader({ getLive: () => live as never, sleep: async () => undefined });
    const error = await downloader.run({ ...request, chatType: 'community', source: 'native', nativeRow: row() }, async () => 'unused').catch((e: unknown) => e);
    expect((error as BridgeDownloadError).code).toBe('BRIDGE_CHAT_TYPE_UNSUPPORTED');
    expect(calls).toHaveLength(0);
  });
});
