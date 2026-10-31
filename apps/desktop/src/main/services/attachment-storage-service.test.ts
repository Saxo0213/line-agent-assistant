import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentStorageService } from './attachment-storage-service.js';

describe('AttachmentStorageService folder command', () => {
  let directory: string | undefined;
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

  it('returns after persisting the root while historical pagination continues in the background', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'line-secondary-root-'));
    const root = path.join(directory, 'secondary');
    await mkdir(root);
    let finishAdmission!: () => void;
    const admission = new Promise<void>((resolve) => { finishAdmission = resolve; });
    const repository = {
      getSetting: vi.fn().mockResolvedValue({ secondaryRoot: null, generation: 1 }),
      setSecondaryRoot: vi.fn().mockResolvedValue({ secondaryRoot: root, generation: 1 }),
      admitReadyPage: vi.fn().mockReturnValue(admission),
      claimJobs: vi.fn().mockResolvedValue([]),
      releaseClaim: vi.fn(),
      listRecoveryChats: vi.fn().mockResolvedValue([]),
    };
    const onError = vi.fn();
    const service = new AttachmentStorageService({
      repository: repository as never,
      messages: { getAttachment: vi.fn() } as never,
      attachmentRoot: path.join(directory, 'primary'),
      onError,
    });
    try {
      const reply = await Promise.race([
        service.executeFolderCommand({ accountId: 'account', chatType: 'group', chatId: 'chat' }, 'admin',
          { type: 'folder', action: 'temp_set', path: root }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('folder command waited for backfill')), 250)),
      ]);
      expect(reply, String(onError.mock.calls[0]?.[0])).toContain('歷史附件正在背景補複製');
      expect(onError).not.toHaveBeenCalled();
      expect(repository.setSecondaryRoot).toHaveBeenCalledOnce();
      expect(repository.admitReadyPage).toHaveBeenCalledOnce();
    } finally {
      finishAdmission();
      await service.shutdown();
    }
  });

  (process.platform === 'win32' && process.env.SystemRoot ? it : it.skip)('rejects the canonical Windows system root before persistence or copy admission', async () => {
    const repository = {
      setSecondaryRoot: vi.fn(),
      admitReadyPage: vi.fn(),
      claimJobs: vi.fn().mockResolvedValue([]),
    };
    const service = new AttachmentStorageService({ repository: repository as never,
      messages: { getAttachment: vi.fn() } as never, attachmentRoot: path.join(tmpdir(),'primary') });
    const reply = await service.executeFolderCommand({ accountId: 'account', chatType: 'direct', chatId: 'peer' }, 'admin',
      { type: 'folder', action: 'temp_set', path: process.env.SystemRoot! });
    expect(reply).toContain('設定失敗');
    expect(repository.setSecondaryRoot).not.toHaveBeenCalled();
    expect(repository.admitReadyPage).not.toHaveBeenCalled();
    await service.shutdown();
  });

  it('keeps the current chat workspace exception for a temp directory inside its own chat folder', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'line-secondary-workspace-'));
    const workspace = path.join(directory,'workspace');
    const ownChatFolder = path.join(workspace,'chats','group-chat');
    const root = path.join(ownChatFolder,'temp');
    await mkdir(root,{recursive:true});
    const repository = { setSecondaryRoot: vi.fn().mockResolvedValue({secondaryRoot:root,generation:1}),
      admitReadyPage: vi.fn().mockResolvedValue({selected:0,lastAttachmentId:null}), claimJobs: vi.fn().mockResolvedValue([]) };
    const service = new AttachmentStorageService({ repository:repository as never,messages:{getAttachment:vi.fn()} as never,
      attachmentRoot:path.join(directory,'primary'),workspaceRoot:async()=>workspace,ownChatWorkspaceFolder:async()=>ownChatFolder });
    const reply=await service.executeFolderCommand({accountId:'account',chatType:'group',chatId:'chat'},'admin',
      {type:'folder',action:'temp_set',path:root});
    expect(reply).toContain('已設定本聊天室第二儲存位置');
    expect(repository.setSecondaryRoot).toHaveBeenCalledOnce();
    await service.shutdown();
  });

  it('lets an idle chat change its root while another chat copy remains held', async () => {
    let finishLookup!: (value: null) => void;
    let lookupStarted!: () => void;
    const lookupGate = new Promise<null>((resolve) => { finishLookup = resolve; });
    const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
    const chatA = { accountId: 'account', chatType: 'group' as const, chatId: 'chat-a' };
    const chatB = { accountId: 'account', chatType: 'group' as const, chatId: 'chat-b' };
    const jobB = { accountId: 'account', chatType: 'group', chatId: 'chat-b', attachmentId: 'attachment-b',
      targetKind: 'secondary', generation: 1, claimToken: 'claim-b' };
    const repository = {
      claimJobs: vi.fn().mockResolvedValueOnce([jobB]).mockResolvedValue([]),
      listRecoveryChats: vi.fn().mockResolvedValue([]),
      setSecondaryRoot: vi.fn().mockResolvedValue({ secondaryRoot: null, generation: 2 }),
      failClaim: vi.fn().mockResolvedValue(undefined), releaseClaim: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AttachmentStorageService({ repository: repository as never,
      messages: { getAttachment: vi.fn(() => { lookupStarted(); return lookupGate; }) } as never,
      attachmentRoot: path.join(tmpdir(), 'primary') });
    service.start();
    try {
      await started;
      const reply = await Promise.race([
        service.executeFolderCommand(chatA, 'admin', { type: 'folder', action: 'temp_off' }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('idle chat waited on other chat')), 250)),
      ]);
      expect(reply).toContain('已停用');
      expect(repository.setSecondaryRoot).toHaveBeenCalledWith(chatA, null);
      finishLookup(null);
      await service.shutdown();
    } finally {
      finishLookup(null);
      await service.shutdown();
    }
  });

  it('drains an old-generation active job for the same chat before changing its root', async () => {
    let finishLookup!: (value: null) => void;
    let lookupStarted!: () => void;
    const lookupGate = new Promise<null>((resolve) => { finishLookup = resolve; });
    const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
    const chat = { accountId: 'account', chatType: 'direct' as const, chatId: 'peer' };
    const job = { accountId: 'account', chatType: 'direct', chatId: 'peer', attachmentId: 'attachment-a',
      targetKind: 'secondary', generation: 1, claimToken: 'claim-a' };
    const repository = {
      claimJobs: vi.fn().mockResolvedValueOnce([job]).mockResolvedValue([]),
      listRecoveryChats: vi.fn().mockResolvedValue([]),
      setSecondaryRoot: vi.fn().mockResolvedValue({ secondaryRoot: null, generation: 2 }),
      failClaim: vi.fn().mockResolvedValue(undefined), completeClaim: vi.fn(), releaseClaim: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AttachmentStorageService({ repository: repository as never,
      messages: { getAttachment: vi.fn(() => { lookupStarted(); return lookupGate; }) } as never,
      attachmentRoot: path.join(tmpdir(), 'primary') });
    service.start();
    try {
      await started;
      const change = service.executeFolderCommand(chat, 'admin', { type: 'folder', action: 'temp_off' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(repository.setSecondaryRoot).not.toHaveBeenCalled();
      finishLookup(null);
      expect(await change).toContain('已停用');
      expect(repository.completeClaim).not.toHaveBeenCalled();
      expect(repository.setSecondaryRoot).toHaveBeenCalledOnce();
    } finally {
      finishLookup(null);
      await service.shutdown();
    }
  });

  it('fences a claim request that began before the chat was paused', async () => {
    let finishClaimRequest!: (jobs: unknown[]) => void;
    let claimRequestStarted!: () => void;
    const claimRequest = new Promise<unknown[]>((resolve) => { finishClaimRequest = resolve; });
    const started = new Promise<void>((resolve) => { claimRequestStarted = resolve; });
    const events: string[] = [];
    const chat = { accountId: 'account', chatType: 'group' as const, chatId: 'chat-a' };
    const job = { accountId: 'account', chatType: 'group', chatId: 'chat-a', attachmentId: 'attachment-a',
      targetKind: 'secondary', generation: 1, claimToken: 'claim-a' };
    const repository = {
      claimJobs: vi.fn().mockImplementationOnce(() => { claimRequestStarted(); return claimRequest; }).mockResolvedValue([]),
      listRecoveryChats: vi.fn().mockResolvedValue([]),
      releaseClaim: vi.fn().mockImplementation(async () => { events.push('release'); }),
      setSecondaryRoot: vi.fn().mockImplementation(async () => { events.push('setting'); return { secondaryRoot: null, generation: 2 }; }),
    };
    const getAttachment = vi.fn();
    const service = new AttachmentStorageService({ repository: repository as never,
      messages: { getAttachment } as never, attachmentRoot: path.join(tmpdir(), 'primary') });
    service.start();
    try {
      await started;
      const change = service.executeFolderCommand(chat, 'admin', { type: 'folder', action: 'temp_off' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(repository.setSecondaryRoot).not.toHaveBeenCalled();
      finishClaimRequest([job]);
      expect(await change).toContain('已停用');
      expect(repository.releaseClaim).toHaveBeenCalledWith(job);
      expect(getAttachment).not.toHaveBeenCalled();
      expect(events).toEqual(['release', 'setting']);
    } finally {
      finishClaimRequest([]);
      await service.shutdown();
    }
  });
});
