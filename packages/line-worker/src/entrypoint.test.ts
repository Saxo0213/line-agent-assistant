import { expect, it, vi } from 'vitest';
import { FakeLineTransport } from './fake-transport.js';
import { fetchLineRequest, fetchWithTimeout, runWorkerLoopOnPort } from './entrypoint.js';
import { LineServerRejection } from './line-server-error.js';

const binding = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };

it('projects a rejected reaction into fixed event text and numeric audit diagnostic', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  const secret = 'token=private MID=u12345678901234567890123456789012 text=private';
  const rejection = Object.assign(new LineServerRejection('LINE_TALK_MESSAGE_NOT_FOUND', 64),
    { reason: secret, parameterMap: { token: secret }, rawBody: secret });
  transport.react = async () => { throw rejection; };
  runWorkerLoopOnPort(channel, async () => transport, { validateLease: () => true });
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  await channel.send({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
  await channel.send({ type: 'reactMessage', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'reaction-rejected',
    messageId: '9', reaction: 'NICE' });
  await vi.waitFor(() => expect(channel.events).toContainEqual(expect.objectContaining({ type: 'error',
    requestId: 'reaction-rejected', code: 'LINE_TALK_MESSAGE_NOT_FOUND',
    message: 'LINE_TALK_MESSAGE_NOT_FOUND',
    diagnostic: expect.objectContaining({ category: 'denied', recovery: 'none', upstreamCode: 64 }) })));
  expect(JSON.stringify(channel.events)).not.toContain(secret);
});

it('passes the native LINE request signal and body straight to production fetch', async () => {
  const controller = new AbortController();
  const request = new Request('https://legy.line-apps.com/S4', { method: 'POST', body: 'native-body',
    headers: { 'content-type': 'application/octet-stream' }, signal: controller.signal });
  const nativeFetch = vi.fn(async (input: Request) => new Response(new Uint8Array([1, 2, 3])));
  vi.stubGlobal('fetch', nativeFetch);
  try {
    const response = await fetchLineRequest(request);
    expect(nativeFetch).toHaveBeenCalledOnce();
    expect(nativeFetch.mock.calls[0]?.[0]).toBe(request);
    expect(nativeFetch.mock.calls[0]?.[0].signal).toBe(request.signal);
    expect(await nativeFetch.mock.calls[0]?.[0].text()).toBe('native-body');
    expect((await response.arrayBuffer()).byteLength).toBe(3);
  } finally { vi.unstubAllGlobals(); }
});

it('aborts a stalled physical LINE request before the outer worker timeout', async () => {
  vi.useFakeTimers();
  try {
    const request = new Request('https://legy.line-apps.com/S4', { method: 'POST' });
    const pending = fetchWithTimeout(request, 5, async (input) => {
      await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
      throw new Error('unreachable');
    });
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5);
    await rejected;
  } finally { vi.useRealTimers(); }
});

it('keeps the physical timeout active after headers until the response body finishes', async () => {
  vi.useFakeTimers();
  let bodyAborted = false;
  try {
    const pending = fetchWithTimeout(new Request('https://legy.line-apps.com/S4'), 5, async (input) => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          input.signal.addEventListener('abort', () => { bodyAborted = true; controller.error(input.signal.reason); }, { once: true });
        },
      })));
    const response = await pending;
    const reader = response.body!.getReader();
    await reader.read();
    const stalledRead = reader.read();
    void stalledRead.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(5);
    expect(bodyAborted).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('keeps caller cancellation effective after response headers have arrived', async () => {
  const caller = new AbortController();
  let bodyAborted = false;
  const result = await fetchWithTimeout(new Request('https://legy.line-apps.com/S4', { signal: caller.signal }), 10_000,
    async (input) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        input.signal.addEventListener('abort', () => { bodyAborted = true; controller.error(input.signal.reason); }, { once: true });
      },
    })));
  const reader = result.body!.getReader();
  await reader.read();
  const stalledRead = reader.read();
  void stalledRead.catch(() => undefined);
  caller.abort(new Error('caller cancelled'));
  expect(bodyAborted).toBe(true);
});

it('releases the physical timeout after a response body completes', async () => {
  vi.useFakeTimers();
  try {
    let requestSignal: AbortSignal | undefined;
    const result = await fetchWithTimeout(new Request('https://legy.line-apps.com/S4'), 5, async (input) => {
      requestSignal = input.signal;
      return new Response(new Uint8Array([1]));
    });
    await result.arrayBuffer();
    await vi.advanceTimersByTimeAsync(5);
    expect(requestSignal?.aborted).toBe(false);
  } finally { vi.useRealTimers(); }
});

it('keeps poll and text sends moving while the independent Reaction lane is unresolved', async () => {
  const channel = port();
  let releaseReaction!: () => void;
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  Object.defineProperty(transport, 'react', { value: async () => await new Promise<void>((resolve) => { releaseReaction = resolve; }) });
  runWorkerLoopOnPort(channel, async () => transport);
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  await channel.send({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });

  await channel.send({ type: 'reactMessage', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'reaction-1',
    messageId: '9', reaction: 'AMAZING' });
  await channel.send({ type: 'poll', ...binding });
  await channel.send({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'send-1',
    text: 'still responsive', replyToMessageId: null });

  expect(transport.syncCalls).toHaveLength(1);
  expect(transport.sendCalls).toHaveLength(1);
  releaseReaction();
});

it('cancels a resource read without fencing later authorized sends', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  let readSignal: AbortSignal | undefined;
  transport.readChatResource = async (_command, options) => await new Promise((_resolve, reject) => {
    readSignal = options.signal;
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  runWorkerLoopOnPort(channel, async () => transport, { validateLease: () => true });
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  await channel.send({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
  const request = { accountId: binding.accountId, workerInstanceId: binding.workerInstanceId, controlEpoch: binding.controlEpoch,
    chatType: 'group' as const, chatId: 'c-group', requestId: 'read-cancelled', action: 'listNotes' as const, timeoutMs: 10_000 };
  channel.post({ type: 'chatResourceRead', ...request });
  await vi.waitFor(() => expect(readSignal).toBeDefined());
  channel.post({ type: 'cancelChatResourceRead', accountId: binding.accountId, workerInstanceId: binding.workerInstanceId,
    controlEpoch: binding.controlEpoch, chatType: request.chatType, chatId: request.chatId, requestId: request.requestId });
  await vi.waitFor(() => expect(readSignal?.aborted).toBe(true));
  await vi.waitFor(() => expect(channel.events).toContainEqual(expect.objectContaining({
    type: 'chatResourceResult', requestId: request.requestId, error: 'CANCELLED' })));
  await channel.send({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'after-cancel',
    text: 'authorized send', replyToMessageId: null });
  await vi.waitFor(() => expect(transport.sendCalls).toHaveLength(1));
  expect(channel.events).toContainEqual(expect.objectContaining({ type: 'sendResult', requestId: 'after-cancel', status: 'sent' }));
});

it('bounds Reaction work to one active and one coalesced pending command per worker', async () => {
  const channel = port();
  let releaseFirst!: () => void;
  let active = 0;
  let maximumActive = 0;
  const seen: string[] = [];
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  Object.defineProperty(transport, 'react', { value: async (_chat: unknown, messageId: string) => {
    active += 1; maximumActive = Math.max(maximumActive, active); seen.push(messageId);
    if (messageId === '9') await new Promise<void>((resolve) => { releaseFirst = resolve; });
    active -= 1;
  } });
  runWorkerLoopOnPort(channel, async () => transport);
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  const react = (requestId: string, messageId: string) => channel.send({ type: 'reactMessage', ...binding,
    chatType: 'direct', chatId: 'u-peer', requestId, messageId, reaction: 'AMAZING' });

  await react('reaction-1', '9');
  await react('reaction-2', '10');
  await react('reaction-3', '11');
  expect(maximumActive).toBe(1);
  expect(seen).toEqual(['9']);
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(seen).toEqual(['9', '11']);
  expect(maximumActive).toBe(1);
});

function port() {
  const events: any[] = [];
  let handler: ((value: unknown) => void) | undefined;
  return { events,
    onMessage: (next: (value: unknown) => void) => { handler = next; },
    postMessage: (value: unknown) => { events.push(value); },
    post: (value: unknown) => { handler?.(value); },
    send: async (value: unknown) => { handler?.(value); await new Promise((resolve) => setTimeout(resolve, 0)); },
  };
}

it('binds the port to its first account and emits a correlated grant acknowledgement', async () => {
  const channel = port();
  let created = 0;
  runWorkerLoopOnPort(channel, async () => { created += 1; return new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' }); });
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor });
  expect(channel.events).toContainEqual({ type: 'modeAck', ...binding, mode: 'MONITOR_ONLY', drained: true });
  await channel.send({ type: 'init', ...binding, accountId: 'account-B', protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  expect(created).toBe(1);
  expect(channel.events.at(-1)).toMatchObject({ type: 'error', ...binding, code: 'INVALID_COMMAND' });
});

it('retains command and admission stage without exposing rejected command content', async () => {
  const channel = port();
  runWorkerLoopOnPort(channel, async () => new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' }));
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor });
  await channel.send({ type: 'history', ...binding, accountId: 'other-account', chatType: 'direct', chatId: 'private-chat',
    requestId: 'history-request', cursor: null, limit: 10 });
  expect(channel.events.at(-1)).toMatchObject({ type: 'error', code: 'INVALID_COMMAND', requestId: 'history-request',
    diagnostic: { operation: 'history', stage: 'admission', category: 'unknown' } });
  expect(JSON.stringify(channel.events.at(-1))).not.toContain('private-chat');
});

it('rejects a cross-binding addFriendByMid command before it reaches the worker transport', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  runWorkerLoopOnPort(channel, async () => transport, { validateLease: () => true });
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  await channel.send({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
  await channel.send({ type: 'addFriendByMid', ...binding, accountId: 'account-B', requestId: 'cross-add',
    targetMid: `u${'a'.repeat(32)}` });
  expect(channel.events.at(-1)).toMatchObject({ type: 'error', ...binding, code: 'INVALID_COMMAND' });
  expect(transport.friendAddCalls).toHaveLength(0);
});

it('rejects protocol drift before login and exposes no secret in status/error events', async () => {
  const channel = port();
  runWorkerLoopOnPort(channel, async () => { throw Object.assign(new Error('secret token abc'), { code: 'PROTOCOL_UNVERIFIED' }); });
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor });
  expect(channel.events).toContainEqual({ type: 'status', ...binding, state: 'PROTOCOL_UNVERIFIED', message: null });
  expect(JSON.stringify(channel.events)).not.toContain('secret token abc');
});

it('reports login timeouts through a fixed correlated diagnostic without exposing the exception', async () => {
  const channel = port();
  const timeout = Object.assign(new Error('token abc PIN 123456 QR data and response body'), { name: 'TimeoutError' });
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  Object.defineProperty(transport, 'loginQr', { value: async () => { throw timeout; } });
  runWorkerLoopOnPort(channel, async () => transport);
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor });
  await channel.send({ type: 'loginQr', ...binding, loginAttemptId: 'timeout-attempt' });

  expect(channel.events.at(-1)).toMatchObject({ type: 'loginFailure', ...binding, loginAttemptId: 'timeout-attempt',
    code: 'LOGIN_TIMEOUT', message: 'LINE login timed out. Try again.' });
  expect(JSON.stringify(channel.events)).not.toContain('token abc');
  expect(channel.events.some((event) => event.type === 'error' && event.code === 'INVALID_COMMAND')).toBe(false);
});

it('classifies a rejected history command with a fixed safe operation code', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  Object.defineProperty(transport, 'history', { value: async () => { throw new Error('private chat text and access token'); } });
  runWorkerLoopOnPort(channel, async () => transport);
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor });
  await channel.send({ type: 'history', ...binding, chatType: 'direct', chatId: `u${'a'.repeat(32)}`,
    requestId: 'history-1', cursor: null, limit: 20 });

  expect(channel.events.at(-1)).toMatchObject({ type: 'error', code: 'HISTORY_READ_FAILED',
    message: 'LINE chat history could not be read.' });
  expect(JSON.stringify(channel.events)).not.toContain('private chat text');
  expect(JSON.stringify(channel.events)).not.toContain('access token');
});

it('maps the exact local stale-attempt rejection to the replacement code', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  runWorkerLoopOnPort(channel, async () => transport);
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor });
  await channel.send({ type: 'loginQr', ...binding, loginAttemptId: 'attempt-one' });
  await channel.send({ type: 'loginQr', ...binding, loginAttemptId: 'attempt-two' });

  expect(channel.events.at(-1)).toMatchObject({ type: 'loginFailure', loginAttemptId: 'attempt-two',
    code: 'LOGIN_ATTEMPT_REPLACED', message: 'This LINE login attempt was replaced. Try again.' });
});

it('lets a triggered authentication invalidation own the terminal result', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  let invalidate!: () => void;
  const register = transport.on.bind(transport);
  transport.on = ((event: string, listener: (value: unknown) => void) => {
    if (event === 'authInvalidated') invalidate = listener as () => void;
    else register(event as never, listener as never);
  }) as typeof transport.on;
  Object.defineProperty(transport, 'loginQr', { value: async () => {
    invalidate();
    throw new Error('authentication was invalidated with private data');
  } });
  runWorkerLoopOnPort(channel, async () => transport);
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor });
  await channel.send({ type: 'loginQr', ...binding, loginAttemptId: 'invalidated-attempt' });

  expect(channel.events).toContainEqual(expect.objectContaining({ type: 'authInvalidated' }));
  expect(channel.events.some((event) => event.type === 'loginFailure')).toBe(false);
  expect(channel.events.filter((event) => ['authInvalidated', 'loginFailure', 'error'].includes(event.type))
    .map((event) => event.type)).toEqual(['authInvalidated']);
  expect(JSON.stringify(channel.events)).not.toContain('private data');
});

it('classifies a failed credential restore without exposing the exception', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  runWorkerLoopOnPort(channel, async () => transport);
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor });
  await channel.send({ type: 'setSecretState', ...binding, loginAttemptId: 'first-attempt',
    secrets: { token: null, qrCert: null, e2eeStorage: null } });
  await channel.send({ type: 'setSecretState', ...binding, loginAttemptId: 'second-attempt',
    secrets: { token: null, qrCert: null, e2eeStorage: null } });
  expect(channel.events.at(-1)).toMatchObject({ type: 'error', code: 'CREDENTIAL_RESTORE_FAILED',
    message: 'LINE credentials could not be restored.' });
});

it('serializes commands received while the LINE transport is still initializing', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  let releaseFactory!: () => void;
  const factoryReady = new Promise<void>((resolve) => { releaseFactory = resolve; });
  runWorkerLoopOnPort(channel, async () => {
    await factoryReady;
    return transport;
  });

  void channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor });
  void channel.send({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1',
    secrets: { token: 'token-1', qrCert: null, e2eeStorage: null } });
  void channel.send({ type: 'loginToken', ...binding, loginAttemptId: 'login-1' });
  void channel.send({ type: 'poll', ...binding });
  releaseFactory();

  await vi.waitFor(() => {
    expect(transport.loginCalls).toEqual(['token']);
    expect(transport.syncCalls).toEqual([cursor]);
  });
  expect(channel.events.some((event) => event.type === 'error')).toBe(false);
});

it('fences sends queued behind an in-flight send when revoke arrives on the worker port', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  const release = transport.pauseSend();
  runWorkerLoopOnPort(channel, async () => transport, { validateLease: () => true });
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  const first = { type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'first',
    text: 'first', replyToMessageId: null };
  channel.events.length = 0;
  await channel.post(first);
  await transport.sendStarted;
  await channel.post({ ...first, requestId: 'second', text: 'second' });
  await channel.post({ type: 'revokeControl', ...binding });
  release();
  await vi.waitFor(() => {
    expect(channel.events).toContainEqual({ type: 'modeAck', ...binding, mode: 'MONITOR_ONLY', drained: true });
    expect(channel.events).toContainEqual({ type: 'sendResult', ...binding, requestId: 'second',
      status: 'failed', messageId: null, error: 'SIDE_EFFECT_DENIED' });
  });
  expect(transport.sendCalls.map((call) => call.text)).toEqual(['first']);
});

it('coalesces repeated port polls while preserving the ordered worker command queue', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  runWorkerLoopOnPort(channel, async () => transport);
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  await channel.send({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1',
    secrets: { token: 'token-1', qrCert: null, e2eeStorage: null } });
  await channel.send({ type: 'loginToken', ...binding, loginAttemptId: 'login-1' });
  const release = transport.pauseSend();
  channel.post({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'first',
    text: 'first', replyToMessageId: null });
  await transport.sendStarted;
  for (let index = 0; index < 50; index += 1) channel.post({ type: 'poll', ...binding });
  release();
  await vi.waitFor(() => expect(transport.syncCalls).toHaveLength(1));
  expect(transport.sendCalls.map((call) => call.text)).toEqual(['first']);
});

it('admits a send while a previously dispatched poll is still waiting on LINE', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  let releasePoll!: () => void;
  let signalPollStarted!: () => void;
  const pollStarted = new Promise<void>((resolve) => { signalPollStarted = resolve; });
  const pollWait = new Promise<void>((resolve) => { releasePoll = resolve; });
  transport.sync = async (syncCursor) => {
    transport.syncCalls.push(syncCursor);
    signalPollStarted();
    await pollWait;
    return { cursorAfter: syncCursor as typeof cursor, operations: [] };
  };
  runWorkerLoopOnPort(channel, async () => transport, { validateLease: () => true });
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  await channel.send({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1',
    secrets: { token: 'token-1', qrCert: null, e2eeStorage: null } });
  await channel.send({ type: 'loginToken', ...binding, loginAttemptId: 'login-1' });

  channel.post({ type: 'poll', ...binding });
  try {
    await pollStarted;
    channel.post({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'during-poll',
      text: 'hello', replyToMessageId: null });
    await vi.waitFor(() => expect(channel.events).toContainEqual({ type: 'sendResult', ...binding,
      requestId: 'during-poll', status: 'sent', messageId: 'sent-1', error: null }));
    expect(transport.sendCalls.map((call) => call.text)).toEqual(['hello']);
  } finally {
    releasePoll();
  }
});

it('keeps receiving while an admitted physical send is still in flight', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  let releaseSend!: () => void;
  let signalSendStarted!: () => void;
  let signalReceiveFinished!: () => void;
  const sendStarted = new Promise<void>((resolve) => { signalSendStarted = resolve; });
  const receiveFinished = new Promise<void>((resolve) => { signalReceiveFinished = resolve; });
  transport.send = async () => {
    signalSendStarted();
    await new Promise<void>((resolve) => { releaseSend = resolve; });
    return { messageId: 'sent-after-receive' };
  };
  transport.sync = async (syncCursor) => {
    transport.syncCalls.push(syncCursor);
    signalReceiveFinished();
    return { cursorAfter: { ...syncCursor as typeof cursor, revision: '1' }, operations: [] };
  };
  runWorkerLoopOnPort(channel, async () => transport, { validateLease: () => true });
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  await channel.send({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1',
    secrets: { token: 'token-1', qrCert: null, e2eeStorage: null } });
  await channel.send({ type: 'loginToken', ...binding, loginAttemptId: 'login-1' });
  try {
    channel.post({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'held-send',
      text: 'held', replyToMessageId: null });
    await sendStarted;
    channel.post({ type: 'poll', ...binding });
    const receivedBeforeSendSettled = await Promise.race([receiveFinished.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))]);
    expect(receivedBeforeSendSettled).toBe(true);
    await vi.waitFor(() => expect(channel.events).toContainEqual({ type: 'batch', ...binding,
      batchId: expect.any(String), cursorBefore: cursor, cursorAfter: { ...cursor, revision: '1' }, envelopes: [] }));
  } finally {
    releaseSend?.();
  }
});

it('serializes multiple sends admitted during a held poll without waiting for the poll to finish', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  let releasePoll!: () => void;
  let signalPollStarted!: () => void;
  const pollStarted = new Promise<void>((resolve) => { signalPollStarted = resolve; });
  const pollWait = new Promise<void>((resolve) => { releasePoll = resolve; });
  let releaseFirstSend!: () => void;
  let signalFirstSendStarted!: () => void;
  const firstSendStarted = new Promise<void>((resolve) => { signalFirstSendStarted = resolve; });
  let signalSecondSendStarted!: () => void;
  const secondSendStarted = new Promise<void>((resolve) => { signalSecondSendStarted = resolve; });
  let sendCount = 0;
  transport.sync = async (syncCursor) => {
    transport.syncCalls.push(syncCursor);
    signalPollStarted();
    await pollWait;
    return { cursorAfter: syncCursor as typeof cursor, operations: [] };
  };
  transport.send = async (_conversation, text) => {
    transport.sendCalls.push({ text });
    sendCount += 1;
    if (sendCount === 1) {
      signalFirstSendStarted();
      await new Promise<void>((resolve) => { releaseFirstSend = resolve; });
    } else if (sendCount === 2) signalSecondSendStarted();
    return { messageId: `sent-${sendCount}` };
  };
  runWorkerLoopOnPort(channel, async () => transport, { validateLease: () => true });
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  await channel.send({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1',
    secrets: { token: 'token-1', qrCert: null, e2eeStorage: null } });
  await channel.send({ type: 'loginToken', ...binding, loginAttemptId: 'login-1' });

  channel.post({ type: 'poll', ...binding });
  try {
    await pollStarted;
    channel.post({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'first',
      text: 'first', replyToMessageId: null });
    await firstSendStarted;
    channel.post({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'second',
      text: 'second', replyToMessageId: null });
    releaseFirstSend();
    await secondSendStarted;
    await vi.waitFor(() => expect(channel.events).toContainEqual({ type: 'sendResult', ...binding, requestId: 'second',
      status: 'sent', messageId: 'sent-2', error: null }));
    expect(transport.sendCalls.map((call) => call.text)).toEqual(['first', 'second']);
    expect(channel.events).toContainEqual({ type: 'sendResult', ...binding, requestId: 'first',
      status: 'sent', messageId: 'sent-1', error: null });
    expect(channel.events).toContainEqual({ type: 'sendResult', ...binding, requestId: 'second',
      status: 'sent', messageId: 'sent-2', error: null });
  } finally {
    releaseFirstSend?.();
    releasePoll();
  }
});

it('keeps history independent of the FIFO send capability while receive is pending', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  let releasePoll!: () => void;
  let signalPollStarted!: () => void;
  const pollStarted = new Promise<void>((resolve) => { signalPollStarted = resolve; });
  const pollWait = new Promise<void>((resolve) => { releasePoll = resolve; });
  let releaseFirstSend!: () => void;
  let signalFirstSendStarted!: () => void;
  const firstSendStarted = new Promise<void>((resolve) => { signalFirstSendStarted = resolve; });
  transport.sync = async (syncCursor) => {
    transport.syncCalls.push(syncCursor);
    signalPollStarted();
    await pollWait;
    return { cursorAfter: syncCursor as typeof cursor, operations: [] };
  };
  transport.send = async (_conversation, text) => {
    transport.sendCalls.push({ text });
    if (text === 'first') {
      signalFirstSendStarted();
      await new Promise<void>((resolve) => { releaseFirstSend = resolve; });
    }
    return { messageId: `sent-${text}` };
  };
  runWorkerLoopOnPort(channel, async () => transport, { validateLease: () => true });
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  await channel.send({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1',
    secrets: { token: 'token-1', qrCert: null, e2eeStorage: null } });
  await channel.send({ type: 'loginToken', ...binding, loginAttemptId: 'login-1' });
  channel.post({ type: 'poll', ...binding });
  try {
    await pollStarted;
    channel.post({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'first',
      text: 'first', replyToMessageId: null });
    await firstSendStarted;
    channel.post({ type: 'history', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'history',
      cursor: null, limit: 10 });
    channel.post({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'second',
      text: 'second', replyToMessageId: null });
    await vi.waitFor(() => expect(channel.events).toContainEqual({ type: 'historyResult', ...binding,
      requestId: 'history', chatType: 'direct', chatId: 'u-peer', nextCursor: null, envelopes: [] }));
    expect(transport.sendCalls.map((call) => call.text)).toEqual(['first']);
    releaseFirstSend();
    await vi.waitFor(() => expect(channel.events).toContainEqual({ type: 'sendResult', ...binding, requestId: 'first',
      status: 'sent', messageId: 'sent-first', error: null }));
    expect(transport.sendCalls.map((call) => call.text)).toEqual(['first', 'second']);
    await vi.waitFor(() => expect(channel.events).toContainEqual({ type: 'sendResult', ...binding, requestId: 'second',
      status: 'sent', messageId: 'sent-second', error: null }));
    expect(transport.historyCalls).toHaveLength(1);
  } finally {
    releaseFirstSend?.();
    releasePoll();
  }
});

it('fences priority-queued sends on revoke and stop while the poll remains blocked', async () => {
  for (const fenceType of ['revokeControl', 'stop'] as const) {
    const channel = port();
    const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
    let releasePoll!: () => void;
    let signalPollStarted!: () => void;
    const pollStarted = new Promise<void>((resolve) => { signalPollStarted = resolve; });
    const pollWait = new Promise<void>((resolve) => { releasePoll = resolve; });
    const releaseSend = transport.pauseSend();
    transport.sync = async (syncCursor) => {
      transport.syncCalls.push(syncCursor);
      signalPollStarted();
      await pollWait;
      return { cursorAfter: syncCursor as typeof cursor, operations: [] };
    };
    runWorkerLoopOnPort(channel, async () => transport, { validateLease: () => true });
    await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
    await channel.send({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1',
      secrets: { token: 'token-1', qrCert: null, e2eeStorage: null } });
    await channel.send({ type: 'loginToken', ...binding, loginAttemptId: 'login-1' });
    channel.post({ type: 'poll', ...binding });
    try {
      await pollStarted;
      channel.post({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'first',
        text: 'first', replyToMessageId: null });
      await transport.sendStarted;
      channel.post({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'queued',
        text: 'queued', replyToMessageId: null });
      channel.post({ type: fenceType, ...binding });
      releaseSend();
      if (fenceType === 'revokeControl') {
        await vi.waitFor(() => expect(channel.events).toContainEqual({ type: 'modeAck', ...binding,
          mode: 'MONITOR_ONLY', drained: true }));
      } else {
        await vi.waitFor(() => expect(channel.events).toContainEqual({ type: 'status', ...binding,
          state: 'stopped', message: null }));
      }
      await vi.waitFor(() => expect(channel.events).toContainEqual({ type: 'sendResult', ...binding,
        requestId: 'queued', status: 'failed', messageId: null, error: 'SIDE_EFFECT_DENIED' }));
      expect(transport.sendCalls.map((call) => call.text)).toEqual(['first']);
    } finally {
      releaseSend();
      releasePoll();
    }
  }
});

it('bounds the priority send queue by the ordinary command capacity', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  let releasePoll!: () => void;
  let signalPollStarted!: () => void;
  const pollStarted = new Promise<void>((resolve) => { signalPollStarted = resolve; });
  const pollWait = new Promise<void>((resolve) => { releasePoll = resolve; });
  let releaseFirstSend!: () => void;
  let signalFirstSendStarted!: () => void;
  const firstSendStarted = new Promise<void>((resolve) => { signalFirstSendStarted = resolve; });
  let sendCount = 0;
  transport.sync = async (syncCursor) => {
    transport.syncCalls.push(syncCursor);
    signalPollStarted();
    await pollWait;
    return { cursorAfter: syncCursor as typeof cursor, operations: [] };
  };
  transport.send = async (_conversation, text) => {
    sendCount += 1;
    transport.sendCalls.push({ text });
    if (sendCount === 1) {
      signalFirstSendStarted();
      await new Promise<void>((resolve) => { releaseFirstSend = resolve; });
    }
    return { messageId: `sent-${sendCount}` };
  };
  runWorkerLoopOnPort(channel, async () => transport, { validateLease: () => true });
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  await channel.send({ type: 'setSecretState', ...binding, loginAttemptId: 'login-1',
    secrets: { token: 'token-1', qrCert: null, e2eeStorage: null } });
  await channel.send({ type: 'loginToken', ...binding, loginAttemptId: 'login-1' });
  channel.post({ type: 'poll', ...binding });
  try {
    await pollStarted;
    channel.post({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'send-0',
      text: 'send-0', replyToMessageId: null });
    await firstSendStarted;
    for (let index = 1; index <= 64; index += 1) {
      channel.post({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: `send-${index}`,
        text: `send-${index}`, replyToMessageId: null });
    }
    expect(channel.events).toContainEqual({ type: 'sendResult', ...binding, requestId: 'send-64',
      status: 'failed', messageId: null, error: 'QUEUE_FULL' });
    releaseFirstSend();
    await vi.waitFor(() => expect(channel.events.filter((event) => event.type === 'sendResult')).toHaveLength(65));
    expect(transport.sendCalls).toHaveLength(64);
  } finally {
    releaseFirstSend?.();
    releasePoll();
  }
});

it('keeps polling and sends responsive while a Relation lookup is pending', async () => {
  const channel = port();
  const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
  let releaseRelation!: () => void;
  let signalRelation!: () => void;
  const relationStarted = new Promise<void>((resolve) => { signalRelation = resolve; });
  const relationWait = new Promise<void>((resolve) => { releaseRelation = resolve; });
  transport.checkFriendRelation = async () => { signalRelation(); await relationWait; return 'friend'; };
  runWorkerLoopOnPort(channel, async () => transport, { validateLease: () => true });
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
  await channel.send({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
  channel.post({ type: 'checkFriendRelation', ...binding, requestId: 'relation-1', targetMid: `u${'a'.repeat(32)}` });
  try {
    await relationStarted;
    channel.post({ type: 'poll', ...binding });
    channel.post({ type: 'sendText', ...binding, chatType: 'direct', chatId: 'u-peer', requestId: 'send-during-relation',
      text: 'hello', replyToMessageId: null });
    await vi.waitFor(() => expect(transport.syncCalls).toHaveLength(1));
    await vi.waitFor(() => expect(channel.events).toContainEqual(expect.objectContaining({ type: 'sendResult',
      requestId: 'send-during-relation', status: 'sent' })));
    expect(transport.friendCheckCalls).toHaveLength(0);
  } finally { releaseRelation(); }
  await vi.waitFor(() => expect(channel.events).toContainEqual(expect.objectContaining({ type: 'friendRelationResult',
    requestId: 'relation-1', status: 'friend' })));
});

it('lets revokeControl and stop fence a relation add queued behind an in-flight read', async () => {
  for (const fenceType of ['revokeControl', 'stop'] as const) {
    const channel = port();
    const transport = new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' });
    let releaseRelation!: () => void;
    let signalRelation!: () => void;
    const relationStarted = new Promise<void>((resolve) => { signalRelation = resolve; });
    const relationWait = new Promise<void>((resolve) => { releaseRelation = resolve; });
    transport.checkFriendRelation = async () => { signalRelation(); await relationWait; return 'friend'; };
    runWorkerLoopOnPort(channel, async () => transport, { validateLease: () => true });
    await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'ACTIVE_CONTROL', durableCursor: cursor });
    await channel.send({ type: 'loginQr', ...binding, loginAttemptId: 'login-1' });
    channel.post({ type: 'checkFriendRelation', ...binding, requestId: 'relation-1', targetMid: `u${'a'.repeat(32)}` });
    try {
      await relationStarted;
      channel.post({ type: 'addFriendByMid', ...binding, requestId: 'add-queued', targetMid: `u${'b'.repeat(32)}` });
      channel.post({ type: fenceType, ...binding });
      const fenceEvent = fenceType === 'stop' ? 'status' : 'modeAck';
      await vi.waitFor(() => expect(channel.events).toContainEqual(expect.objectContaining({ type: fenceEvent,
        ...(fenceType === 'stop' ? { state: 'stopped' } : { mode: 'MONITOR_ONLY' }) })));
    } finally { releaseRelation(); }
    await vi.waitFor(() => expect(channel.events).toContainEqual(expect.objectContaining({ type: 'addFriendResult',
      requestId: 'add-queued', status: 'failed' })));
    expect(transport.friendAddCalls).toHaveLength(0);
  }
});

it('names the rejected command type and a bounded requestId when the command fails schema parsing', async () => {
  const channel = port();
  runWorkerLoopOnPort(channel, async () => new FakeLineTransport({ ownMid: 'u-self', displayName: 'Agent' }));
  await channel.send({ type: 'init', ...binding, protocolVersion: 4, mode: 'MONITOR_ONLY', durableCursor: cursor });
  await channel.send({ type: 'history', ...binding, chatType: 'direct', chatId: 'private-chat', requestId: 'bad-history', cursor: null, limit: 9999 });
  expect(channel.events.at(-1)).toMatchObject({ type: 'error', code: 'INVALID_COMMAND', requestId: 'bad-history',
    diagnostic: { operation: 'history', stage: 'admission' } });
  expect(JSON.stringify(channel.events.at(-1))).not.toContain('private-chat');
  await channel.send({ type: 'notACommand', ...binding, requestId: 'x'.repeat(129) });
  const unknown = channel.events.at(-1) as { diagnostic: { operation: string }; requestId?: string };
  expect(unknown).toMatchObject({ type: 'error', code: 'INVALID_COMMAND', diagnostic: { operation: 'unknown', stage: 'admission' } });
  expect(unknown.requestId).toBeUndefined();
});
