import { afterEach, expect, it, vi } from 'vitest';
import { createLinejsAdapter } from './linejs-adapter.js';
import type { ChatResourceReadCommand } from '@line-agent/contracts';

const { Login } = await import(new URL('../../../node_modules/@evex/linejs/base/login/mod.js', import.meta.url).href) as {
  Login: { prototype: { login: (...args: any[]) => Promise<unknown> } };
};
const { ChannelService } = await import(new URL('../../../node_modules/@evex/linejs/base/service/channel/mod.js', import.meta.url).href) as {
  ChannelService: { prototype: { approveChannelAndIssueChannelToken: (...args: any[]) => Promise<unknown> } };
};
const { Timeline } = await import(new URL('../../../node_modules/@evex/linejs/base/timeline/mod.js', import.meta.url).href) as {
  Timeline: { prototype: { initTimeline: (...args: any[]) => Promise<unknown>; listPost: (...args: any[]) => Promise<unknown> } };
};

const lease = { accountId: 'account-A', workerInstanceId: 'worker-1', controlEpoch: 7 };
const jwt = [Buffer.from('{"alg":"HS256"}').toString('base64url'),
  Buffer.from('{"sub":"u-self"}').toString('base64url'), 'signature'].join('.');
const tokenLogin = vi.spyOn(Login.prototype, 'login').mockImplementation(async function (this: any, options: any) {
  this.client.authToken = options.authToken;
  this.client.profile = { mid: 'u-self', displayName: 'Fixture' };
  return { authToken: options.authToken } as any;
});
const originalApprove = ChannelService.prototype.approveChannelAndIssueChannelToken;
const channelIssue = vi.spyOn(ChannelService.prototype, 'approveChannelAndIssueChannelToken').mockImplementation(
  async function (this: any, ...args: any[]) {
    await originalApprove.apply(this, args);
    return { channelAccessToken: 'fixture-channel-token' };
  },
);
afterEach(() => { tokenLogin.mockClear(); channelIssue.mockClear(); });

it.each([
  ['bootstrap_failure', 'bootstrap'] ,
  ['list_get_transport_failure', 'transport'],
  ['response_code_invalid', 'code'],
  ['response_shape_invalid', 'shape'],
  ['normalization_failure', 'normalization'],
] as const)('reports a fixed local adapter category for fake %s outcome', async (category, fault) => {
  const bootstrap = vi.spyOn(Timeline.prototype, 'initTimeline').mockImplementation(async () => {
    if (fault === 'bootstrap') throw new Error('private bootstrap token detail');
  });
  const listPost = vi.spyOn(Timeline.prototype, 'listPost').mockImplementation(async () => {
    if (fault === 'transport') throw new Error('private transport URL and response body');
    if (fault === 'code') return { code: 7, message: 'private response content', result: {} } as any;
    if (fault === 'shape') return { code: 0, result: null } as any;
    return { code: 0, result: { posts: [null] } } as any;
  });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false,
    physicalTransport: async () => { throw new Error('No network traffic is allowed in this fixture'); } });
  await adapter.loginToken(jwt);
  try {
    await expect(adapter.readChatResource({ action: 'listNotes', chatId: 'c-selected-chat', limit: 10 } as ChatResourceReadCommand,
      { signal: new AbortController().signal })).rejects.toMatchObject({ category, message: category });
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(listPost).toHaveBeenCalledTimes(fault === 'bootstrap' ? 0 : 1);
  } finally {
    adapter.revoke();
    listPost.mockRestore();
    bootstrap.mockRestore();
  }
});

it.each([
  ['invalid JSON', () => new Response('{'), 'response_shape_invalid'],
  ['invalid response object', () => Response.json([]), 'response_shape_invalid'],
  ['HTTP failure', () => new Response('private body', { status: 503 }), 'list_get_transport_failure'],
  ['nonzero response code', () => Response.json({ code: 7, message: 'private response content', result: {} }), 'response_code_invalid'],
] as const)('classifies fake Moa Album %s without exposing library details', async (_name, albumResponse, category) => {
  channelIssue.mockImplementation(async function (this: any, ...args: any[]) {
    await originalApprove.apply(this, args);
    return { channelAccessToken: 'fixture-channel-token' };
  });
  const physicalTransport = vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname === '/CH4') return channelTokenResponse();
    return albumResponse();
  });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false, physicalTransport });
  await adapter.loginToken(jwt);
  try {
    await expect(adapter.readChatResource({ action: 'listAlbums', chatId: 'c-selected-chat', limit: 10 } as ChatResourceReadCommand,
      { signal: new AbortController().signal })).rejects.toMatchObject({ category, message: category });
    expect(physicalTransport).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(physicalTransport.mock.calls.map(([request]) => request.url))).not.toContain('private');
  } finally {
    adapter.revoke();
  }
});

async function channelTokenResponse(): Promise<Response> {
  const thrift = (await import('thrift')).default;
  const chunks: Buffer[] = [];
  const transport = new thrift.TBufferedTransport(null, (chunk: Buffer) => chunks.push(chunk));
  const protocol = new thrift.TCompactProtocol(transport);
  protocol.writeMessageBegin('approveChannelAndIssueChannelToken', 2, 0);
  protocol.writeStructBegin('result');
  protocol.writeFieldBegin('success', 12, 0);
  protocol.writeStructBegin('success');
  protocol.writeFieldBegin('channelAccessToken', 11, 1);
  protocol.writeString('fixture-channel-token');
  protocol.writeFieldEnd();
  protocol.writeFieldStop();
  protocol.writeStructEnd();
  protocol.writeFieldEnd();
  protocol.writeFieldStop();
  protocol.writeStructEnd();
  protocol.writeMessageEnd();
  transport.flush();
  return new Response(chunks[0]);
}

function oversizedStreamingResponse(onCancel: () => void): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return;
      sent = true;
      controller.enqueue(new Uint8Array(64 * 1024));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() { onCancel(); },
  });
  return new Response(body);
}

it.each([
  { action: 'listNotes', channelId: '1341209850', restPath: '/mh/api/v57/post/list.json', rest: { code: 0, result: { posts: [] } } },
  { action: 'listAlbums', channelId: '1375220249', restPath: '/ext/album/moa/v2/albums', rest: { code: 0, result: { albums: [], nextCursor: null } } },
] as const)('bounds the actual $channelId /CH4 bootstrap stream and recovers on retry', async ({ action, channelId, restPath, rest }) => {
  channelIssue.mockImplementation(async function (this: any, ...args: any[]) {
    expect(args[0]).toEqual({ channelId });
    await originalApprove.apply(this, args);
    return { channelAccessToken: 'fixture-channel-token' };
  });
  let cancelled = false;
  let bootstrapCalls = 0;
  const physicalTransport = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === '/CH4') {
      bootstrapCalls += 1;
      expect(request.method).toBe('POST');
      if (bootstrapCalls === 1) return oversizedStreamingResponse(() => { cancelled = true; });
      return await channelTokenResponse();
    }
    expect(url.pathname).toBe(restPath);
    return Response.json(rest);
  });
  const adapter = await createLinejsAdapter({ ...lease, mode: 'MONITOR_ONLY', validateLease: () => false, physicalTransport });
  await adapter.loginToken(jwt);
  const command = { action, chatId: 'c-selected-chat', limit: 10 } as ChatResourceReadCommand;
  try {
    const firstError = await adapter.readChatResource(command, { signal: new AbortController().signal }).then(() => null, (error) => error);
    expect(firstError).toBeInstanceOf(Error);
    expect(firstError).toMatchObject({ category: 'bootstrap_failure', message: 'bootstrap_failure' });
    expect(bootstrapCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
    expect(bootstrapCalls).toBe(1);

    const result = await adapter.readChatResource(command, { signal: new AbortController().signal });
    expect(action === 'listNotes' ? result.notes : result.albums).toEqual([]);
    expect(bootstrapCalls).toBe(2);
    expect(physicalTransport).toHaveBeenCalledTimes(3);
    const bootstrapRequest = physicalTransport.mock.calls[1]![0];
    expect(new URL(bootstrapRequest.url).pathname).toBe('/CH4');
    expect(channelIssue).toHaveBeenCalledTimes(2);
  } finally {
    adapter.revoke();
  }
});
