import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import path, { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import type { Attachment, AttachmentStorageJob, AttachmentStorageRepository } from '@line-agent/database';
import type { WritableConversationKey } from '@line-agent/contracts';
import { buildAttachmentLocation, storeAttachment, type AttachmentFilesystemSafetyBroker } from '@line-agent/line-worker/attachment-storage';

type ActiveJob = { key: WritableConversationKey; controller: AbortController; promise: Promise<void> };
type ClaimRound = { excludedChatIds: ReadonlySet<string>; admission: Promise<void>; pending: boolean; resolveAdmission(): void };
const keyId = (key: WritableConversationKey) => JSON.stringify([key.accountId,key.chatType,key.chatId]);
const samePath = (a: string,b: string) => (process.platform === 'win32' ? win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase() : path.normalize(a) === path.normalize(b));
const inside = (parent: string, child: string) => { const rel=relative(parent,child); return rel==='' || (rel!=='..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const validRelative = (value: string) => !!value && !isAbsolute(value) && !value.includes('\\') && !value.includes(':') && value.split('/').every((part)=>!!part&&part!=='.'&&part!=='..');
const sourceError = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as {code:unknown}).code) : '';
  return /^[A-Z0-9_]{2,48}$/.test(code) ? code : 'COPY_FAILED';
};

export interface AttachmentStorageServiceOptions {
  repository: AttachmentStorageRepository;
  messages: Pick<import('@line-agent/database').MessageRepository, 'getAttachment'>;
  attachmentRoot: string;
  windowsSafetyBroker?: AttachmentFilesystemSafetyBroker;
  protectedPaths?: readonly string[];
  workspaceRoot?(): Promise<string | null>;
  ownChatWorkspaceFolder?(key: WritableConversationKey): Promise<string | null>;
  onError?(error: unknown): void;
}

/** Durable, bounded secondary-copy and primary reclassification queue. */
export class AttachmentStorageService {
  private readonly active = new Set<ActiveJob>();
  private readonly admissions = new Set<Promise<unknown>>();
  private readonly pausedChats = new Map<string, WritableConversationKey>();
  private readonly claimRounds = new Set<ClaimRound>();
  private readonly lanes = new Map<string, Promise<string>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pumping: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: AttachmentStorageServiceOptions) {}

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.pump(); }, 1_000);
    this.timer.unref?.();
    void this.trackAdmission(this.recoverQueues()).catch((error: unknown) => this.options.onError?.(error));
    void this.pump();
  }

  onPrimaryReady(key: WritableConversationKey, attachmentId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.trackAdmission((async () => {
      const setting = await this.options.repository.getSetting(key);
      if (!setting.secondaryRoot || this.closed) return;
      await this.options.repository.admitReadyAttachment(key, attachmentId, setting.generation);
      void this.pump();
    })());
  }

  executeFolderCommand(key: WritableConversationKey, _actor: string, command: import('./trigger-router.js').FolderCommand): Promise<string> {
    const id = keyId(key);
    const prior = this.lanes.get(id) ?? Promise.resolve('');
    const run = prior.then(async () => {
      if (command.action === 'temp_show') {
        const [setting, progress] = await Promise.all([this.options.repository.getSetting(key),this.options.repository.getProgress(key)]);
        return setting.secondaryRoot
          ? `本聊天室第二儲存位置：${setting.secondaryRoot}\n複製進度：佇列 ${progress.queued}、處理中 ${progress.claimed}、完成 ${progress.completed}、失敗 ${progress.failed}`
          : '本聊天室尚未設定第二儲存位置';
      }
      if (command.action === 'temp_retry') {
        const count = await this.options.repository.retryFailed(key);
        void this.pump();
        return count ? `已排入 ${count} 個失敗附件重試` : '目前沒有失敗的第二份附件';
      }
      if (command.action !== 'temp_off' && command.action !== 'temp_set') throw new Error('Invalid secondary folder command');
      const root = command.action === 'temp_set' ? await this.validateSecondaryRoot(command.path,key) : null;
      this.pausedChats.set(id,key);
      try {
        await this.cancelAndDrain(key);
        const setting = await this.options.repository.setSecondaryRoot(key,root);
        if (!root) return '已停用本聊天室第二儲存位置；既有檔案會保留';
        void this.trackAdmission(this.admitPages(key,setting.generation,'secondary')).catch((error: unknown)=>this.options.onError?.(error));
        void this.pump();
        return `已設定本聊天室第二儲存位置：${root}；歷史附件正在背景補複製`;
      } finally {
        this.pausedChats.delete(id);
        void this.pump();
      }
    }).catch((error: unknown) => { this.options.onError?.(error); return '第二儲存位置設定失敗，請檢查資料夾後重試'; });
    this.lanes.set(id,run);
    void run.finally(()=>{ if(this.lanes.get(id)===run)this.lanes.delete(id); });
    return run;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const job of this.active) job.controller.abort(new Error('Storage service stopping'));
    await Promise.allSettled([...this.active].map((job)=>job.promise));
    await this.pumping?.catch(()=>undefined);
    while(this.admissions.size)await Promise.allSettled([...this.admissions]);
  }

  private trackAdmission<T>(task: Promise<T>): Promise<T> {
    this.admissions.add(task);
    void task.finally(()=>this.admissions.delete(task)).catch(()=>undefined);
    return task;
  }

  private async validateSecondaryRoot(candidate: string,key: WritableConversationKey): Promise<string> {
    if (!isAbsolute(candidate) || candidate.startsWith('\\\\') || candidate.includes('\0')) throw new Error('Secondary root must be a local absolute directory');
    const configured = resolve(candidate);
    const rootInfo = await lstat(configured);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Secondary root must be an existing real directory');
    let current = path.parse(configured).root;
    for (const segment of configured.slice(current.length).split(/[\\/]+/).filter(Boolean)) {
      current = path.join(current,segment);
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Secondary root cannot contain reparse points');
    }
    const canonical = await realpath(configured);
    const protectedPaths = await Promise.all([this.options.attachmentRoot,...(this.options.protectedPaths ?? []),
      process.env.SystemRoot,process.env.WINDIR,process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.ProgramData,
      process.env.CommonProgramFiles,process.env['CommonProgramFiles(x86)']].filter((value): value is string => Boolean(value))
      .map(async (value)=>realpath(resolve(value)).catch(()=>resolve(value))));
    for (const protectedPath of protectedPaths) if (inside(protectedPath,canonical) || inside(canonical,protectedPath)) throw new Error('Secondary root overlaps a protected system folder');
    const workspace = await this.options.workspaceRoot?.();
    if (workspace) {
      const canonicalWorkspace = await realpath(workspace).catch(()=>resolve(workspace));
      if (inside(canonicalWorkspace,canonical)) {
        const own = await this.options.ownChatWorkspaceFolder?.(key);
        if (!own) throw new Error('Secondary root cannot use another chat workspace folder');
        const ownCanonical = await realpath(own);
        if (!inside(ownCanonical,canonical)) throw new Error('Secondary root must stay in this chat workspace folder');
      }
    }
    return canonical;
  }

  private async cancelAndDrain(key: WritableConversationKey): Promise<void> {
    const id=keyId(key);
    for (;;) {
      // A claim request that started before this chat was paused may still
      // return one of its jobs. Wait until that result has been classified and
      // dispatched, but do not wait for copies belonging to other chats.
      const rounds=[...this.claimRounds].filter((round)=>round.pending&&!round.excludedChatIds.has(id));
      await Promise.all(rounds.map((round)=>round.admission));
      const jobs=[...this.active].filter((job)=>keyId(job.key)===id);
      for(const job of jobs)job.controller.abort(new Error('Secondary storage generation changed'));
      await Promise.allSettled(jobs.map((job)=>job.promise));
      const hasRelevantRound=[...this.claimRounds].some((round)=>round.pending&&!round.excludedChatIds.has(id));
      if(!hasRelevantRound&&![...this.active].some((job)=>keyId(job.key)===id))return;
    }
  }

  private async recoverQueues(): Promise<void> {
    const chats=await this.options.repository.listRecoveryChats();
    for(const chat of chats){
      if(this.closed)return;
      const key=chat as WritableConversationKey;
      const setting=await this.options.repository.getSetting(key);
      if(setting.secondaryRoot)await this.admitPages(key,setting.generation,'secondary');
      if(key.chatType!=='direct')await this.admitPages(key,0,'reclassify');
    }
    await this.pump();
  }

  private async admitPages(key: WritableConversationKey,generation: number,target: 'secondary'|'reclassify'): Promise<void> {
    let after: string|null=null;
    for(let page=0;page<100_000&&!this.closed;page+=1){
      const result=await this.options.repository.admitReadyPage(key,generation,target,after,200);
      if(!result.selected||!result.lastAttachmentId||result.lastAttachmentId===after)break;
      after=result.lastAttachmentId;
      if(result.selected<200)break;
    }
  }

  private pump(): Promise<void> {
    if(this.closed)return Promise.resolve();
    if(this.pumping)return this.pumping;
    const run=(async()=>{
      while(!this.closed){
        const excluded=[...this.pausedChats.values()];
        let settleAdmission!:()=>void;
        const admission=new Promise<void>((resolve)=>{settleAdmission=resolve;});
        const round:ClaimRound={excludedChatIds:new Set(excluded.map(keyId)),admission,pending:true,resolveAdmission:()=>{
          if(!round.pending)return;
          round.pending=false;
          settleAdmission();
        }};
        this.claimRounds.add(round);
        try{
          const jobs=await this.options.repository.claimJobs(4,excluded);
          let pendingAdmissions=jobs.length;
          if(!pendingAdmissions)round.resolveAdmission();
          const admitted=()=>{pendingAdmissions-=1;if(pendingAdmissions===0)round.resolveAdmission();};
          const dispatched=jobs.map((job)=>this.runClaim(job,admitted));
          if(!jobs.length)break;
          await Promise.all(dispatched);
        }finally{
          round.resolveAdmission();
          this.claimRounds.delete(round);
        }
      }
    })().catch((error:unknown)=>this.options.onError?.(error)).finally(()=>{if(this.pumping===run)this.pumping=null;});
    this.pumping=run;
    return run;
  }

  private async runClaim(job: AttachmentStorageJob,onAdmission:()=>void=()=>undefined): Promise<void> {
    const key: WritableConversationKey={accountId:job.accountId,chatType:job.chatType,chatId:job.chatId};
    if(this.closed||this.pausedChats.has(keyId(key))){try{await this.options.repository.releaseClaim(job);}finally{onAdmission();}return;}
    const controller=new AbortController();
    const active: ActiveJob={key,controller,promise:Promise.resolve()};
    active.promise=this.copyClaim(job,controller.signal).catch(async(error:unknown)=>{
      await this.options.repository.failClaim(job,sourceError(error)).catch((writeError:unknown)=>this.options.onError?.(writeError));
    }).finally(()=>this.active.delete(active));
    this.active.add(active);
    onAdmission();
    await active.promise;
  }

  private async copyClaim(job: AttachmentStorageJob,signal: AbortSignal): Promise<void> {
    const key: WritableConversationKey={accountId:job.accountId,chatType:job.chatType,chatId:job.chatId};
    const attachment=await this.options.messages.getAttachment(job.attachmentId);
    if(signal.aborted)throw new Error('COPY_CANCELLED');
    if(!attachment||attachment.status!=='ready'||!attachment.relativePath||!attachment.sha256||attachment.sizeBytes===null)throw new Error('SOURCE_NOT_READY');
    const setting=job.targetKind==='secondary'?await this.options.repository.getSetting(key):null;
    if(job.targetKind==='secondary'&&(!setting?.secondaryRoot||setting.generation!==job.generation))throw new Error('GENERATION_STALE');
    const root=job.targetKind==='secondary'?setting!.secondaryRoot!:this.options.attachmentRoot;
    const identity={accountId:attachment.accountId,chatType:job.chatType,chatId:attachment.chatId,messageId:attachment.messageId,externalAttachmentId:attachment.externalAttachmentId};
    const sender={id:attachment.senderId??'unknown',displayName:attachment.senderDisplayName??null};
    const target=buildAttachmentLocation({root,identity,occurredAt:attachment.occurredAt,originalFileName:attachment.name??'attachment.bin',sender,
      ...(job.targetKind==='secondary'?{layout:'secondary' as const}:{layout:'primary' as const})});
    const source=await this.openManagedSource(attachment.relativePath);
    try{
      const copied=await storeAttachment({root,identity,occurredAt:attachment.occurredAt,originalFileName:attachment.name??'attachment.bin',sender,
        ...(job.targetKind==='secondary'?{layout:'secondary' as const}:{layout:'primary' as const}),source:this.verifiedSource(source,attachment,signal),
        maxBytes:Math.max(attachment.sizeBytes,1),timeoutMs:120_000,signal},
        this.options.windowsSafetyBroker?{windowsSafetyBroker:this.options.windowsSafetyBroker}:{});
      if(copied.sha256!==attachment.sha256||copied.size!==attachment.sizeBytes)throw new Error('COPY_VERIFY_FAILED');
      if(signal.aborted)throw new Error('COPY_CANCELLED');
      const committed=await this.options.repository.completeClaim(job,attachment.relativePath,copied.managedRelativePath);
      if(!committed)throw new Error('GENERATION_STALE');
      if(job.targetKind==='reclassify'&&!samePath(source.path,target.absolutePath)){
        await source.handle.close();
        await this.removeExactOldPath(source,attachment.relativePath);
      }
    }finally{await source.handle.close().catch(()=>undefined);}
  }

  private async openManagedSource(relativePath: string): Promise<{handle:FileHandle;path:string;dev:number;ino:number;size:number;mtimeMs:number}> {
    if(!validRelative(relativePath))throw new Error('SOURCE_PATH_INVALID');
    const root=resolve(this.options.attachmentRoot),rootStat=await lstat(root),rootReal=await realpath(root);
    if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error('SOURCE_ROOT_INVALID');
    let current=rootReal;
    for(const segment of relativePath.split('/')){
      current=path.join(current,segment);
      const named=await lstat(current),canonical=await realpath(current),rel=relative(rootReal,canonical);
      if(named.isSymbolicLink()||!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('SOURCE_PATH_UNSAFE');
    }
    const handle=await open(current,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try{
      const held=await handle.stat(),named=await lstat(current);
      if(!held.isFile()||named.isSymbolicLink()||!named.isFile()||held.dev!==named.dev||held.ino!==named.ino||held.size!==named.size)throw new Error('SOURCE_IDENTITY_CHANGED');
      return{handle,path:current,dev:held.dev,ino:held.ino,size:held.size,mtimeMs:held.mtimeMs};
    }catch(error){await handle.close();throw error;}
  }

  private async *verifiedSource(source:{handle:FileHandle;path:string;dev:number;ino:number;size:number;mtimeMs:number},attachment:Attachment,signal:AbortSignal):AsyncIterable<Uint8Array>{
    if(source.size!==attachment.sizeBytes)throw new Error('SOURCE_SIZE_MISMATCH');
    const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let position=0;
    while(position<source.size){
      if(signal.aborted)throw new Error('COPY_CANCELLED');
      const read=await source.handle.read(buffer,0,Math.min(buffer.length,source.size-position),position);
      if(read.bytesRead<=0)throw new Error('SOURCE_TRUNCATED');
      const chunk=Buffer.from(buffer.subarray(0,read.bytesRead));hash.update(chunk);position+=read.bytesRead;yield chunk;
    }
    const final=await source.handle.stat(),named=await lstat(source.path);
    if(!final.isFile()||final.dev!==source.dev||final.ino!==source.ino||final.size!==source.size||final.mtimeMs!==source.mtimeMs
      ||named.isSymbolicLink()||!named.isFile()||named.dev!==source.dev||named.ino!==source.ino||named.size!==source.size)throw new Error('SOURCE_IDENTITY_CHANGED');
    if(hash.digest('hex')!==attachment.sha256)throw new Error('SOURCE_HASH_MISMATCH');
  }

  private async removeExactOldPath(source:{path:string;dev:number;ino:number},relativePath:string):Promise<void>{
    if(!validRelative(relativePath))return;
    try{
      const stat=await lstat(source.path);
      if(stat.isFile()&&!stat.isSymbolicLink()&&stat.dev===source.dev&&stat.ino===source.ino)await unlink(source.path);
      let directory=path.dirname(source.path);const root=resolve(this.options.attachmentRoot);
      while(directory!==root&&inside(root,directory)){
        await rmdir(directory).catch(()=>undefined);
        const parent=path.dirname(directory);if(parent===directory)break;directory=parent;
      }
    }catch{/* A failed exact cleanup leaves the committed file readable at its new canonical path. */}
  }
}
