import { describe, expect, it } from 'vitest';
import { BridgeDownloadError, OfficialDownloadBridgeDownloader } from './bridge-download.js';
import { attachmentRawFields } from '../../../../../../packages/database/src/message-repository.js';
import { BRIDGE_IDENTITY_FUNCTION, classifyBridgeComparison, classifyBridgeIdentity } from './bridge-verification.js';
import { buildMessageFromNativeRow, buildPlainMessageFromNativeRow, nativeRowFromEnvelope, type NativeRowInput } from './native-message.js';

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

function plainRow(metadata: Record<string, unknown> = {}, info: Record<string, unknown> = {}): NativeRowInput {
  return {
    columns: ['_id', '_contentType', '_contentMetadata', '_contentInfo'],
    cells: ['123456789012345678', 1, JSON.stringify({ OID: 'oid-1', OBS_POP: 'pop-1', MEDIA_CONTENT_INFO: '{"category":"original"}', FILE_SIZE: '3', ...metadata }), JSON.stringify(info)],
  };
}

describe('buildPlainMessageFromNativeRow', () => {
  it('builds a message from a plain row and copies no key field', () => {
    expect(buildPlainMessageFromNativeRow(plainRow())).toEqual({
      id: '123456789012345678', contentType: 1,
      contentMetadata: { OID: 'oid-1', OBS_POP: 'pop-1', MEDIA_CONTENT_INFO: '{"category":"original"}', FILE_SIZE: '3' },
    });
  });

  it('returns null for an encrypted row and for an UNSENT row', () => {
    expect(buildPlainMessageFromNativeRow(plainRow({ SID: 'emi' }))).toBeNull();
    expect(buildPlainMessageFromNativeRow(plainRow({ e2eeMark: 2 }))).toBeNull();
    expect(buildPlainMessageFromNativeRow(plainRow({ UNSENT: '1' }))).toBeNull();
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

describe('classifyBridgeComparison', () => {
  const same = { SID: 'same', OID: 'same', OBS_POP: 'same', DOWNLOAD_URL: 'same', e2eeVersion: 'same', ENC_KM: 'same',
    FILE_NAME: 'same', FILE_SIZE: 'same', MEDIA_CONTENT_INFO: 'same', id: true, contentType: true, path: true, headPath: true };
  it('gives store_incomplete for a placeholder store message and mismatch when a strict item differs', () => {
    const placeholder = classifyBridgeComparison({ ...same, contentType: false, path: false, headPath: false,
      ENC_KM: 'missing_chrome', e2eeVersion: 'missing_chrome', SID: 'missing_chrome' });
    expect(placeholder?.result).toBe('store_incomplete');
    expect(placeholder?.detail.startsWith('store_incomplete.false:contentType:path:headPath.missing_chrome:')).toBe(true);
    expect(classifyBridgeComparison({ ...same, ENC_KM: 'diff', SID: 'missing_chrome' })?.result).toBe('mismatch');
    expect(classifyBridgeComparison({ ...same, id: false, SID: 'missing_chrome' })?.result).toBe('mismatch');
    expect(classifyBridgeComparison(same)?.result).toBe('match');
  });
});

describe('bridge download', () => {
  it('calls eB one time with the built message and does not touch the store', async () => {
    const { result, calls, attemptsSeen } = await runWith([{ ok: true }], 'native', row());
    expect(result).toEqual({ name: 'photo.jpg', bytes: [1, 2, 3] });
    expect(calls.map((call) => call.kind)).toEqual(['eB']);
    expect(calls[0]?.args?.[0]).toHaveProperty('value');
    expect(calls[0]?.args?.[1]).toEqual({ value: 'media_viewer' });
    expect(attemptsSeen).toEqual([{ stage: 'native', code: null, httpStatus: null }]);
  });

  it('calls eB with the plain message when the native row is plain', async () => {
    const { result, calls } = await runWith([{ ok: true }], 'native', plainRow());
    expect(result).toEqual({ name: 'photo.jpg', bytes: [1, 2, 3] });
    expect(calls.map((call) => call.kind)).toEqual(['eB']);
    expect(calls[0]?.args?.[0]).toEqual({ value: buildPlainMessageFromNativeRow(plainRow()) });
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

describe('identity verification of an incomplete official row', () => {
  const flags = { id: true, contentType: true, createdTime: true, toType: true, keys: true, plain: false };
  const incompleteRow = (): NativeRowInput => {
    const base = row({ info: { keyMaterial: undefined }, metadata: { SID: undefined } });
    return { columns: [...base.columns, '_createdTime'], cells: [...base.cells, 1700000000000] };
  };
  const plainRow = (metadata: Record<string, unknown> = {}): NativeRowInput => ({
    columns: ['_id', '_contentType', '_contentMetadata', '_contentInfo', '_createdTime'],
    cells: ['msg-1', 1, JSON.stringify({ GID: 'g', GSEQ: '1', ...metadata }), '{}', 1700000000000],
  });
  // Runs the real page function on a synthetic store message.
  const runIdentityFunction = (store: Record<string, unknown>, argument: Record<string, unknown>): unknown =>
    (new Function(`return (${BRIDGE_IDENTITY_FUNCTION})`)() as (this: unknown, a: unknown) => unknown).call(store, argument);
  const plainStore = { id: 'msg-1', contentType: 1, createdTime: 1700000000000, toType: 2, contentMetadata: { GID: 'g' } };
  const plainArgument = { id: 'msg-1', contentType: 1, createdTime: '1700000000000', chatType: 'group', plain: true };
  const identity = { chatType: 'group', kind: 'image' as const };

  function identityLive(answers: unknown[], inStore = true) {
    const identityCalls: Array<Record<string, unknown>> = [];
    const cdp = {
      isClosed: false,
      async send(method: string, params: Record<string, any> = {}): Promise<Record<string, unknown>> {
        if (method === 'Runtime.releaseObject') return {};
        const decl = String(params.functionDeclaration);
        if (decl.includes('hasOwnProperty')) return { result: inStore ? { type: 'object', objectId: 'store-msg' } : { type: 'object', subtype: 'null' } };
        if (decl.includes('keys:')) {
          identityCalls.push(params.arguments[0].value as Record<string, unknown>);
          return { result: { value: answers.length > 1 ? answers.shift() : answers[0] } };
        }
        throw new Error('unexpected call');
      },
    };
    return { live: { cdp, handles: { sessionId: 's', ids: { IA: 'IA', QO: 'QO' } } }, identityCalls };
  }

  it('classifies the page answer', () => {
    expect(classifyBridgeIdentity(flags)).toEqual({ result: 'identity_match', detail: 'identity_match' });
    expect(classifyBridgeIdentity({ ...flags, keys: false })?.result).toBe('store_incomplete');
    expect(classifyBridgeIdentity({ ...flags, createdTime: false, toType: false })).toEqual({ result: 'mismatch', detail: 'identity:false:createdTime:toType' });
    expect(classifyBridgeIdentity({ ...flags, id: false, keys: false })?.result).toBe('mismatch');
    expect(classifyBridgeIdentity({ id: true })).toBeNull();
    expect(classifyBridgeIdentity({ ...flags, keys: false })).toEqual({ result: 'store_incomplete', detail: 'identity:store_incomplete' });
    expect(classifyBridgeIdentity({ ...flags, keys: false, plain: true })).toEqual({ result: 'identity_match', detail: 'identity_match.plain' });
    const { plain: _plain, ...withoutPlain } = flags;
    expect(classifyBridgeIdentity(withoutPlain)).toBeNull();
  });

  it('gives identity_match.plain for a plain official row and a plain store message', async () => {
    const answer = runIdentityFunction(plainStore, plainArgument);
    expect(answer).toMatchObject({ keys: false, plain: true });
    const { live, identityCalls } = identityLive([answer]);
    const downloader = new OfficialDownloadBridgeDownloader({ getLive: () => live as never, sleep: async () => undefined });
    expect(await downloader.verify({ messageId: 'msg-1', nativeRow: plainRow(), waitMs: 0, identity }))
      .toEqual({ result: 'identity_match', detail: 'identity_match.plain' });
    expect(identityCalls[0]?.plain).toBe(true);
  });

  it('gives store_incomplete for a plain official row and a store message with chunks', async () => {
    const answer = runIdentityFunction({ ...plainStore, chunks: [{}] }, plainArgument);
    expect(answer).toMatchObject({ plain: false });
    const { live } = identityLive([answer]);
    const downloader = new OfficialDownloadBridgeDownloader({ getLive: () => live as never, sleep: async () => undefined });
    expect((await downloader.verify({ messageId: 'msg-1', nativeRow: plainRow(), waitMs: 0, identity })).result).toBe('store_incomplete');
  });

  it('gives identity:unsent without a page call when the official row has UNSENT', async () => {
    const { live, identityCalls } = identityLive([flags]);
    const downloader = new OfficialDownloadBridgeDownloader({ getLive: () => live as never, sleep: async () => undefined });
    expect(await downloader.verify({ messageId: 'msg-1', nativeRow: plainRow({ UNSENT: 'true' }), waitMs: 0, identity }))
      .toEqual({ result: 'mismatch', detail: 'identity:unsent' });
    expect(identityCalls).toHaveLength(0);
  });

  it('gives identity_match, passes the identity by value and reads no key', async () => {
    const { live, identityCalls } = identityLive([flags]);
    const downloader = new OfficialDownloadBridgeDownloader({ getLive: () => live as never, sleep: async () => undefined });
    const result = await downloader.verify({ messageId: 'msg-1', nativeRow: incompleteRow(), waitMs: 0, identity });
    expect(result.result).toBe('identity_match');
    expect(identityCalls).toEqual([{ id: 'msg-1', contentType: 1, createdTime: '1700000000000', chatType: 'group', plain: false }]);
  });

  it('gives mismatch identity:false:createdTime when the created time differs', async () => {
    const { live } = identityLive([{ ...flags, createdTime: false }]);
    const downloader = new OfficialDownloadBridgeDownloader({ getLive: () => live as never, sleep: async () => undefined });
    expect(await downloader.verify({ messageId: 'msg-1', nativeRow: incompleteRow(), waitMs: 0, identity }))
      .toEqual({ result: 'mismatch', detail: 'identity:false:createdTime' });
  });

  it('gives native_incomplete without a page read when the official row has no _createdTime', async () => {
    const { live, identityCalls } = identityLive([flags]);
    const downloader = new OfficialDownloadBridgeDownloader({ getLive: () => live as never, sleep: async () => undefined });
    const noTime = row({ info: { keyMaterial: undefined }, metadata: { SID: undefined } });
    expect((await downloader.verify({ messageId: 'msg-1', nativeRow: noTime, waitMs: 0, identity })).result).toBe('native_incomplete');
    expect(identityCalls).toHaveLength(0);
  });

  it('gives mismatch without a page read when the row content type is not the kind', async () => {
    const { live, identityCalls } = identityLive([flags]);
    const downloader = new OfficialDownloadBridgeDownloader({ getLive: () => live as never, sleep: async () => undefined });
    const result = await downloader.verify({ messageId: 'msg-1', nativeRow: { ...incompleteRow(), cells: ['msg-1', 14, '{}', '{}', 'x', 1700000000000] }, waitMs: 0, identity });
    expect(result.result).toBe('mismatch');
    expect(identityCalls).toHaveLength(0);
  });

  it('waits while the store message has no keys, then gives identity_match', async () => {
    const { live, identityCalls } = identityLive([{ ...flags, keys: false }, flags]);
    const downloader = new OfficialDownloadBridgeDownloader({ getLive: () => live as never, sleep: async () => undefined });
    const result = await downloader.verify({ messageId: 'msg-1', nativeRow: incompleteRow(), waitMs: 4_000, identity });
    expect(result.result).toBe('identity_match');
    expect(identityCalls).toHaveLength(2);
  });

  it('keeps store_incomplete when the keys never come', async () => {
    const { live } = identityLive([{ ...flags, keys: false }]);
    const downloader = new OfficialDownloadBridgeDownloader({ getLive: () => live as never, sleep: async () => undefined });
    expect((await downloader.verify({ messageId: 'msg-1', nativeRow: incompleteRow(), waitMs: 2_000, identity })).result).toBe('store_incomplete');
  });

  it('gives native_incomplete without identity', async () => {
    const { live, identityCalls } = identityLive([flags]);
    const downloader = new OfficialDownloadBridgeDownloader({ getLive: () => live as never, sleep: async () => undefined });
    expect((await downloader.verify({ messageId: 'msg-1', nativeRow: incompleteRow(), waitMs: 0 })).result).toBe('native_incomplete');
    expect(identityCalls).toHaveLength(0);
  });
});

describe('bridge download gap', () => {
  function gapped(options: { gap?: (kind: string) => number } = {}) {
    const { live } = fakeLive([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
    const sleeps: number[] = [];
    const gapKinds: string[] = [];
    let clock = 1_000_000;
    const downloader = new OfficialDownloadBridgeDownloader({
      getLive: () => live as never, now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      downloadGapMs: (kind) => { gapKinds.push(kind); return options.gap?.(kind) ?? 5_000; },
    });
    const run = (extra: { live?: boolean; kind?: 'image' | 'file' } = {}) =>
      downloader.run({ ...request, source: 'native', nativeRow: row(), ...extra }, async () => 'done').catch((error: unknown) => error);
    return { run, sleeps, gapKinds };
  }

  it('waits for the gap of the kind of the earlier download before a download that is not live', async () => {
    const { run, sleeps, gapKinds } = gapped({ gap: (kind) => (kind === 'image' ? 1_000 : 4_000) });
    // A photo of 3 bytes fails the format check after the download. The gap still starts for the kind photo.
    await run({ kind: 'image' });
    await run({ kind: 'file' });
    await run({ kind: 'file' });
    expect(gapKinds).toEqual(['image', 'file', 'file']);
    expect(sleeps).toEqual([1_000, 4_000]);
  });

  it('starts a live download without waiting, and the live download sets the gap for the next download that is not live', async () => {
    const { run, sleeps } = gapped();
    expect(await run()).toBe('done');
    expect(await run({ live: true })).toBe('done');
    expect(sleeps).toEqual([]);
    expect(await run()).toBe('done');
    expect(sleeps).toEqual([5_000]);
  });

  it('does not hold the lock for a gap: a live request starts while a request that is not live waits', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const { live } = fakeLive([{ ok: true }, { ok: true }, { ok: true }]);
    let clock = 0;
    const downloader = new OfficialDownloadBridgeDownloader({
      getLive: () => live as never, now: () => clock,
      sleep: async (ms) => { order.push(`sleep:${ms}`); await held; clock += ms; },
      downloadGapMs: () => 5_000,
    });
    await downloader.run({ ...request, source: 'native', nativeRow: row() }, async () => 'first');
    const slow = downloader.run({ ...request, source: 'native', nativeRow: row() }, async () => { order.push('slow'); return 'slow'; });
    const fast = downloader.run({ ...request, source: 'native', nativeRow: row(), live: true }, async () => { order.push('live'); return 'live'; });
    expect(await fast).toBe('live');
    expect(order).toEqual(['sleep:5000', 'live']);
    release();
    expect(await slow).toBe('slow');
  });
});
