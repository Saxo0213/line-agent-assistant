import { describe, expect, it, vi } from 'vitest';
import { createSetupAdapter, createSetupCutover } from './setup-ipc.js';
import { EmbeddedPgError } from './services/embedded-postgres/errors.js';

describe('database setup IPC boundary', () => {
  it('never saves after timeout even if shutdown later succeeds', async () => {
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const save=vi.fn(async()=>undefined);
    const cutover=createSetupCutover({isConnected:()=>true,fence:()=>undefined,shutdown:()=>gate,timeoutMs:5} as never);
    const result=cutover.save(save).then(()=> 'saved',()=> 'failed');
    await new Promise(resolve=>setTimeout(resolve,20));release();expect(await result).toBe('failed');
    await expect(cutover.save(save)).rejects.toThrow();expect(save).not.toHaveBeenCalled();
  });
  it('fences connected requests before shutdown and does not save until shutdown succeeds', async () => {
    const order: string[] = [];
    let finishShutdown!: () => void;
    const shutdownGate = new Promise<void>((resolve) => { finishShutdown = resolve; });
    let connected = true;
    const cutover = createSetupCutover({ isConnected: () => connected, fence: () => { order.push('fence'); connected = false; },
      shutdown: async () => { order.push('shutdown-start'); await shutdownGate; order.push('shutdown-complete'); } });
    const save = cutover.save(async () => { order.push('save'); });

    expect(order).toEqual(['fence', 'shutdown-start']);
    finishShutdown();
    await save;
    expect(order).toEqual(['fence', 'shutdown-start', 'shutdown-complete', 'save']);
  });

  it('does not persist setup when connected shutdown fails and keeps runtime fenced', async () => {
    const order: string[] = [];
    let connected = true;
    const cutover = createSetupCutover({ isConnected: () => connected, fence: () => { order.push('fence'); connected = false; },
      shutdown: async () => { order.push('shutdown'); throw new Error('shutdown failed'); } });
    await expect(cutover.save(async () => { order.push('save'); })).rejects.toThrow('shutdown failed');
    expect(order).toEqual(['fence', 'shutdown']);
    await expect(cutover.save(async () => { order.push('unsafe-save'); })).rejects.toThrow('Setup cutover is unavailable after shutdown failure');
    expect(order).toEqual(['fence', 'shutdown']);
  });

  it('rejects an overlapping setup save before the second save can write', async () => {
    let finishSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { finishSave = resolve; });
    const cutover = createSetupCutover({ isConnected: () => false, fence: vi.fn(), shutdown: vi.fn() });
    const first = cutover.save(() => saveGate);
    const secondSave = vi.fn(async () => undefined);
    await expect(cutover.save(secondSave)).rejects.toThrow('Setup cutover already in progress');
    expect(secondSave).not.toHaveBeenCalled();
    finishSave();
    await first;
  });

  it('routes database setup persistence through the supplied cutover boundary', async () => {
    const order: string[] = [];
    const setup = { status: vi.fn(), listDatabases: vi.fn(), createDatabase: vi.fn(),
      saveConfiguration: vi.fn(async () => { order.push('persist'); }) };
    const adapter = createSetupAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', setup: setup as never,
      chooseAttachmentRoot: async () => null, chooseAgentWorkspace: async () => null, restartApplication: vi.fn(),
      runSetupSave: async (save) => { order.push('cutover-start'); await save(); order.push('cutover-end'); } });
    await adapter({ senderId: 7, url: 'file:///app/index.html' }, {
      type: 'saveDatabaseSetup', requestId: '9e2af331-4376-4a43-bc81-ce421cc3cb19',
      connection: { host: 'localhost', port: 5432, username: 'postgres', password: 'pw', ssl: 'disable' },
      database: 'line_agent', attachmentRoot: 'D:\\attachments', agentWorkspace: 'D:\\workspace',
    });
    expect(order).toEqual(['cutover-start', 'persist', 'cutover-end']);
  });

  it('routes folder moves by Main-issued selection ID and opens only the active folder', async () => {
    const attachmentRootChange = { prepare: vi.fn(async () => ({ id: '9e2af331-4376-4a43-bc81-ce421cc3cb19', path: 'D:\\new-attachments' })),
      move: vi.fn(async (id: string) => { if (id !== '9e2af331-4376-4a43-bc81-ce421cc3cb19') throw new Error('unknown selection'); return 'D:\\new-attachments'; }),
      openCurrent: vi.fn(async () => undefined) };
    const adapter = createSetupAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', setup: {} as never,
      chooseAttachmentRoot: async () => null, chooseAgentWorkspace: async () => null, restartApplication: vi.fn(), attachmentRootChange });
    const sender = { senderId: 7, url: 'file:///app/index.html' };
    const requestId = '9e2af331-4376-4a43-bc81-ce421cc3cb19';
    expect(await adapter(sender, { type: 'prepareAttachmentRootChange', requestId })).toMatchObject({ ok: true, selection: { path: 'D:\\new-attachments' } });
    expect(await adapter(sender, { type: 'moveAttachmentRoot', requestId, selectionId: requestId })).toMatchObject({ ok: true, restartRequired: true });
    expect(attachmentRootChange.move).toHaveBeenCalledWith(requestId);
    expect(await adapter(sender, { type: 'openAttachmentRoot', requestId })).toMatchObject({ ok: true });
    expect(attachmentRootChange.openCurrent).toHaveBeenCalledOnce();
  });

  it('returns the actionable shared workspace validation message for invalid setup folders', async () => {
    const setup = { status: vi.fn(), listDatabases: vi.fn(), createDatabase: vi.fn(), saveConfiguration: vi.fn(async () => {
      throw Object.assign(new Error('Select an existing absolute workspace directory in Settings → Agent.'), { code: 'INVALID_WORKSPACE' });
    }) };
    const adapter = createSetupAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', setup: setup as never,
      chooseAttachmentRoot: async () => null, chooseAgentWorkspace: async () => null, restartApplication: vi.fn() });
    const result = await adapter({ senderId: 7, url: 'file:///app/index.html' }, {
      type: 'saveDatabaseSetup', requestId: '9e2af331-4376-4a43-bc81-ce421cc3cb19',
      connection: { host: 'localhost', port: 5432, username: 'postgres', password: 'pw', ssl: 'disable' },
      database: 'line_agent', attachmentRoot: 'D:\\attachments', agentWorkspace: 'D:\\workspace',
    });
    expect(result).toMatchObject({ ok: false, message: 'Select an existing absolute workspace directory in Settings → Agent.' });
  });

  it('maps embedded PostgreSQL failures to a friendly sentence plus the safe error code', async () => {
    const embedded = { start: vi.fn(async () => { throw new EmbeddedPgError('pg_hash_mismatch', 'secret detail'); }), cancel: vi.fn(), changePassword: vi.fn(async () => undefined),
      connectionInfo: vi.fn(async () => ({ version: '18.6', host: '127.0.0.1', port: 55432, username: 'line_agent_admin', database: 'line_agent', url: 'postgresql://x', password: 'pw' })) };
    const setup = { status: vi.fn(), saveEmbeddedConfiguration: vi.fn(async () => undefined) };
    const adapter = createSetupAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', setup: setup as never, embedded,
      chooseAttachmentRoot: async () => null, chooseAgentWorkspace: async () => null, restartApplication: vi.fn() });
    const sender = { senderId: 7, url: 'file:///app/index.html' };
    const id = '9e2af331-4376-4a43-bc81-ce421cc3cb19';
    const failure = await adapter(sender, { type: 'startEmbeddedProvision', requestId: id });
    expect(failure).toEqual({ type: 'error', requestId: id, ok: false, message: '下載的檔案驗證失敗，已刪除，請重試。', errorCode: 'pg_hash_mismatch' });
    expect(JSON.stringify(failure)).not.toContain('secret detail');
    expect(await adapter(sender, { type: 'getEmbeddedConnectionInfo', requestId: id })).toMatchObject({ ok: true, info: { password: 'pw' } });
    expect(await adapter(sender, { type: 'cancelEmbeddedProvision', requestId: id })).toMatchObject({ ok: true });
    expect(embedded.cancel).toHaveBeenCalledOnce();
    expect(await adapter(sender, { type: 'saveEmbeddedSetup', requestId: id, attachmentRoot: 'D:\\a', agentWorkspace: 'D:\\w' })).toMatchObject({ ok: true, restartRequired: true });
    expect(setup.saveEmbeddedConfiguration).toHaveBeenCalledWith('D:\\a', 'D:\\w');
    expect(await adapter({ senderId: 9, url: sender.url }, { type: 'getEmbeddedConnectionInfo', requestId: id })).toMatchObject({ ok: false });
  });

  it('waits for lifecycle shutdown and relaunch to finish before acknowledging restart', async () => {
    const order: string[] = [];
    let finishRestart!: () => void;
    const gate = new Promise<void>((resolve) => { finishRestart = resolve; });
    const setup = { status: vi.fn(), listDatabases: vi.fn(), createDatabase: vi.fn(), saveConfiguration: vi.fn() };
    const adapter = createSetupAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', setup: setup as never,
      chooseAttachmentRoot: async () => null, chooseAgentWorkspace: async () => null,
      restartApplication: async () => { order.push('shutdown-start'); await gate; order.push('relaunch-exit'); } });
    let acknowledged = false;
    const request = adapter({ senderId: 7, url: 'file:///app/index.html' }, {
      type: 'restartApplication', requestId: '9e2af331-4376-4a43-bc81-ce421cc3cb19',
    }).then((result) => { acknowledged = true; return result; });

    await Promise.resolve();
    expect(order).toEqual(['shutdown-start']);
    expect(acknowledged).toBe(false);
    finishRestart();
    await expect(request).resolves.toMatchObject({ type: 'restartApplication', ok: true });
    expect(order).toEqual(['shutdown-start', 'relaunch-exit']);
  });

  it('rejects untrusted renderers and delegates validated setup requests', async () => {
    const setup = { status: vi.fn(async () => ({ configured: false, attachmentRoot: 'D:\\attachments', agentWorkspace: 'D:\\workspace', connection: null })),
      listDatabases: vi.fn(async () => ['postgres']), createDatabase: vi.fn(async () => ['line_agent', 'postgres']), saveConfiguration: vi.fn() };
    const adapter = createSetupAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', setup: setup as never,
      chooseAttachmentRoot: async () => 'D:\\attachments', chooseAgentWorkspace: async () => 'D:\\workspace', restartApplication: vi.fn() });
    const request = { type: 'getDatabaseSetupStatus', requestId: '9e2af331-4376-4a43-bc81-ce421cc3cb19' };
    expect((await adapter({ senderId: 8, url: 'file:///app/index.html' }, request)).ok).toBe(false);
    await expect(adapter({ senderId: 7, url: 'file:///app/index.html' }, request)).resolves.toMatchObject({ ok: true, status: { configured: false } });
    expect(setup.status).toHaveBeenCalledOnce();
  });

  it('does not echo a database password in a connection error', async () => {
    const setup = { status: vi.fn(), listDatabases: vi.fn(async () => { throw new Error('connect postgresql://postgres:top-secret@localhost'); }),
      createDatabase: vi.fn(), saveConfiguration: vi.fn() };
    const adapter = createSetupAdapter({ webContentsId: 7, rendererUrl: 'file:///app/index.html', setup: setup as never,
      chooseAttachmentRoot: async () => null, chooseAgentWorkspace: async () => null, restartApplication: vi.fn() });
    const result = await adapter({ senderId: 7, url: 'file:///app/index.html' }, { type: 'listDatabases', requestId: '9e2af331-4376-4a43-bc81-ce421cc3cb19',
      connection: { host: 'localhost', port: 5432, username: 'postgres', password: 'top-secret', ssl: 'disable' } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('top-secret');
  });
});
