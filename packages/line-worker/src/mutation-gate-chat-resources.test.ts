import { describe, expect, it, vi } from 'vitest';
import { limitChatResourceBootstrapResponse } from './linejs-adapter.js';
import { createMutationGate, type TrustedRequestClient } from './mutation-gate.js';

const accountId = 'account-a';
const workerInstanceId = 'worker-a';

function makeGate() {
  const transport = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
  const requestClient: TrustedRequestClient<() => Promise<unknown>, unknown, Response> = {
    invoke: async (call) => await call(),
  };
  return { transport, gate: createMutationGate({ accountId, workerInstanceId, controlEpoch: 7,
    validateControlLease: () => true, requestClient, physicalTransport: transport }) };
}

describe('chat resource REST permits', () => {
  it('permits only bounded authenticated LINE resource endpoints', async () => {
    const { gate, transport } = makeGate();
    const request = new Request('https://legy.line-apps.com/mh/api/v57/post/list.json?homeId=c123&sourceType=TALKROOM&likeLimit=0&commentLimit=0',
      { method: 'GET', redirect: 'error', headers: { 'X-Line-ChannelToken': 'channel', 'X-Line-Mid': 'u-self' } });
    await gate.runChatResourceFetch({ accountId, workerInstanceId, controlEpoch: 7, signal: new AbortController().signal,
      maxBytes: 64 * 1024, chatId: 'c123', ownMid: 'u-self', action: 'listNotes' }, request);
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    ['wrong host', 'https://evil.example/mh/api/v57/post/list.json?homeId=c123&sourceType=TALKROOM&likeLimit=0&commentLimit=0', 'GET'],
    ['wrong path', 'https://legy.line-apps.com/mh/api/v57/post/delete.json?homeId=c123&postId=1', 'POST'],
    ['wrong method', 'https://legy.line-apps.com/mh/api/v57/post/list.json?homeId=c123&sourceType=TALKROOM&likeLimit=0&commentLimit=0', 'POST'],
    ['redirects enabled', 'https://legy.line-apps.com/mh/api/v57/post/list.json?homeId=c123&sourceType=TALKROOM&likeLimit=0&commentLimit=0', 'GET'],
  ])('rejects %s', async (label, url, method) => {
    const { gate, transport } = makeGate();
    const request = new Request(url, { method, redirect: label === 'redirects enabled' ? 'follow' : 'error',
      headers: { 'X-Line-ChannelToken': 'channel', 'X-Line-Mid': 'u-self' } });
    await expect(gate.runChatResourceFetch({ accountId, workerInstanceId, controlEpoch: 7,
      signal: new AbortController().signal, maxBytes: 64 * 1024, chatId: 'c123', ownMid: 'u-self', action: 'listNotes' }, request)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects a stale account binding before transport', async () => {
    const { gate, transport } = makeGate();
    const request = new Request('https://legy.line-apps.com/mh/api/v57/post/list.json?homeId=c123&sourceType=TALKROOM&likeLimit=0&commentLimit=0');
    await expect(gate.runChatResourceFetch({ accountId: 'account-b', workerInstanceId, controlEpoch: 7,
      signal: new AbortController().signal, maxBytes: 64 * 1024, chatId: 'c123', ownMid: 'u-self', action: 'listNotes' }, request)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects a stale control epoch before transport', async () => {
    const { gate, transport } = makeGate();
    const request = new Request('https://legy.line-apps.com/mh/api/v57/post/list.json?homeId=c123&sourceType=TALKROOM&likeLimit=0&commentLimit=0',
      { redirect: 'error', headers: { 'X-Line-ChannelToken': 'channel', 'X-Line-Mid': 'u-self' } });
    await expect(gate.runChatResourceFetch({ accountId, workerInstanceId, controlEpoch: 8,
      signal: new AbortController().signal, maxBytes: 64 * 1024, chatId: 'c123', ownMid: 'u-self', action: 'listNotes' }, request)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('resource channel-token bootstrap permits', () => {
  function makeBootstrapGate(physicalTransport: (request: Request) => Promise<Response>) {
    const requestClient: TrustedRequestClient<{ channelId: string }, Response, Response> = {
      invoke: async (call, dispatch) => {
        const logicalRequest = new Request('https://legy.line-apps.com/CH4', { method: 'POST', body: 'thrift' });
        return dispatch({ actualMethodName: 'approveChannelAndIssueChannelToken', actualPath: '/CH4',
          actualValue: [[11, 1, call.channelId]], transport: { mode: 'direct', tokenState: 'v3-jwt' }, logicalRequest,
          execute: async (fetch) => await fetch(logicalRequest) });
      },
    };
    return createMutationGate({ accountId, workerInstanceId, controlEpoch: 7,
      validateControlLease: () => true, requestClient, physicalTransport });
  }
  const context = (signal: AbortSignal, channelId: '1341209850' | '1375220249') => ({
    phase: 'CHAT_RESOURCE_BOOTSTRAP' as const,
    chatResourceBootstrap: { accountId, workerInstanceId, controlEpoch: 7, channelId, signal, maxBytes: 64 * 1024 },
  });

  it.each(['MONITOR_READ', 'CONTROL_READ'] as const)('denies generic %s access to /CH4', async (phase) => {
    const physicalTransport = vi.fn(async () => new Response());
    const gate = makeBootstrapGate(physicalTransport);
    await expect(gate.invokeRpc({ phase }, { channelId: '1341209850' })).rejects.toThrow();
    expect(physicalTransport).not.toHaveBeenCalled();
  });

  it.each(['1341209850', '1375220249'] as const)('permits only the bound channel %s and propagates cancellation', async (channelId) => {
    let started!: (request: Request) => void;
    const began = new Promise<Request>((resolve) => { started = resolve; });
    const physicalTransport = vi.fn(async (request: Request) => {
      started(request);
      await new Promise<void>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
      return new Response();
    });
    const gate = makeBootstrapGate(physicalTransport);
    const controller = new AbortController();
    const pending = gate.invokeRpc(context(controller.signal, channelId), { channelId });
    const request = await began;
    expect(request.signal.aborted).toBe(false);
    expect(request.redirect).toBe('error');
    controller.abort(new Error('resource deadline'));
    await vi.waitFor(() => expect(request.signal.aborted).toBe(true));
    await expect(pending).rejects.toThrow('resource deadline');
  });

  it('releases a timed-out token bootstrap so the next bounded request can proceed', async () => {
    let calls = 0;
    const gate = makeBootstrapGate(async (request) => {
      calls += 1;
      if (calls === 1) return await new Promise<Response>((_resolve, reject) =>
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const expired = new AbortController();
    const pending = gate.invokeRpc(context(expired.signal, '1375220249'), { channelId: '1375220249' });
    await vi.waitFor(() => expect(calls).toBe(1));
    expired.abort(new Error('deadline'));
    await expect(pending).rejects.toThrow('deadline');
    const retry = await gate.invokeRpc(context(new AbortController().signal, '1375220249'), { channelId: '1375220249' });
    expect(calls).toBe(2);
    expect((await retry.arrayBuffer()).byteLength).toBe(3);
  });

  it('caps oversized channel-token bootstrap response bodies before LINEJS buffers them', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }));
    await expect(limitChatResourceBootstrapResponse(response, 128 * 1024).arrayBuffer()).rejects.toThrow(/limit|exceed/i);
    expect(cancelled).toBe(true);
  });

  it('rejects unrelated channels, stale worker bindings, and malformed channel args', async () => {
    const physicalTransport = vi.fn(async () => new Response());
    const gate = makeBootstrapGate(physicalTransport);
    const controller = new AbortController();
    await expect(gate.invokeRpc(context(controller.signal, '1341209850'), { channelId: 'other' })).rejects.toThrow();
    await expect(gate.invokeRpc({ ...context(controller.signal, '1341209850'), chatResourceBootstrap: {
      ...context(controller.signal, '1341209850').chatResourceBootstrap, workerInstanceId: 'stale-worker' } }, { channelId: '1341209850' })).rejects.toThrow();
    await expect(gate.invokeRpc({ ...context(controller.signal, '1341209850'), chatResourceBootstrap: {
      ...context(controller.signal, '1341209850').chatResourceBootstrap, controlEpoch: 8 } }, { channelId: '1341209850' })).rejects.toThrow();
    expect(physicalTransport).not.toHaveBeenCalled();
  });
});
