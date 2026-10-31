import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttachmentStorageRepository, MessageRepository } from '@line-agent/database';
import { createTestDatabase } from '../../../../../packages/database/src/test-database.js';
import { buildAttachmentLocation, createWindowsAttachmentBroker, type AttachmentFilesystemSafetyBroker } from '@line-agent/line-worker/attachment-storage';
import { resolveWorkerEntry } from '../resources.js';
import { AttachmentStorageService } from './attachment-storage-service.js';

const database = process.env.TEST_DATABASE_URL && process.platform === 'win32' ? describe : describe.skip;

database('attachment storage service with isolated PostgreSQL and native broker', () => {
  let pool: Awaited<ReturnType<typeof createTestDatabase>>['pool'];
  let closeDatabase: () => Promise<void>;
  let directory: string;
  let service!: AttachmentStorageService;
  let repository: AttachmentStorageRepository;
  let helperPath: string;
  let primaryRoot: string;
  const backgroundErrors: unknown[]=[];
  const primaryRelative = 'legacy/2026/10/original file.pdf';
  const bytes = Buffer.from('%PDF-1.7 focused attachment archive fixture\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const accountId = `storage-${randomUUID()}`;
  const chatId = `group-${randomUUID()}`;
  const messageId = `message-${randomUUID()}`;
  const attachmentId = randomUUID();

  beforeAll(async () => {
    ({ pool, close: closeDatabase } = await createTestDatabase());
    repository = new AttachmentStorageRepository(pool);
    directory = await mkdtemp(path.join(tmpdir(), 'line-storage-service-integration-'));
    primaryRoot = path.join(directory, 'primary');
    const source = path.join(primaryRoot, ...primaryRelative.split('/'));
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, bytes);
    await mkdir(path.join(directory, 'secondary'));
    await pool.query('INSERT INTO line_accounts(account_id) VALUES ($1)', [accountId]);
    await pool.query('INSERT INTO conversations(account_id,chat_id,chat_type,title) VALUES ($1,$2,\'group\',\'Integration\')', [accountId,chatId]);
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_id,chat_type,sender_id,kind,ingestion_source,occurred_at,raw)
      VALUES ($1,$2,$3,$4,'group','sender-😀-stable','file','live','2026-10-31T23:30:00Z','{}'::jsonb)`, [accountId,messageId,`event-${messageId}`,chatId]);
    await pool.query("INSERT INTO line_contacts(account_id,mid,display_name,nickname) VALUES ($1,'sender-😀-stable','Profile Name','Display Name')", [accountId]);
    await pool.query(`INSERT INTO attachments(attachment_id,external_attachment_id,account_id,chat_type,chat_id,message_id,kind,name,mime_type,size_bytes,status,relative_path,sha256)
      VALUES ($1,'external-archive-1',$2,'group',$3,$4,'file','original file.pdf','application/pdf',$5,'ready',$6,$7)`,
      [attachmentId,accountId,chatId,messageId,bytes.byteLength,primaryRelative,sha256]);
    const resources=path.join(directory,'resources');
    const workerEntry = resolveWorkerEntry(true, path.join(directory,'main.js'), resources);
    helperPath = path.join(path.dirname(workerEntry),'native','AttachmentBroker.exe');
    await mkdir(path.dirname(helperPath),{recursive:true});
    await copyFile(path.resolve('packages/line-worker/dist/native/AttachmentBroker.exe'),helperPath);
    service = new AttachmentStorageService({ repository, messages: new MessageRepository(pool), attachmentRoot: primaryRoot,
      windowsSafetyBroker: createWindowsAttachmentBroker({ helperPath }), onError: (error) => { backgroundErrors.push(error); } });
    service.start();
  }, 20_000);
  afterAll(async () => {
    await service?.shutdown();
    await closeDatabase?.();
    if (directory) await rm(directory,{recursive:true,force:true});
  });

  it('reclassifies and temp-copies with the native broker, cleaning only after commit; missing source preserves canonical ready data', async () => {
    const waitForStatus = async (target: 'primary'|'secondary', status: string, id = attachmentId) => {
      const deadline = Date.now()+10_000;
      while(Date.now()<deadline){
        const result=await pool.query<{status:string}>(`SELECT status FROM attachment_storage_jobs WHERE attachment_id=$1 AND target_kind=$2`,
          [id,target==='primary'?'reclassify':'secondary']);
        if(result.rows[0]?.status===status)return;
        await new Promise((resolve)=>setTimeout(resolve,50));
      }
      const debug=await pool.query(`SELECT status,safe_error_code FROM attachment_storage_jobs WHERE attachment_id=$1 AND target_kind=$2`,
        [id,target==='primary'?'reclassify':'secondary']);
      throw new Error(`timed out waiting for ${target} ${status}: ${JSON.stringify(debug.rows)}`);
    };
    await repository.queueReclassification({accountId,chatType:'group',chatId},attachmentId);
    await waitForStatus('primary','completed');
    let row=(await pool.query<{relative_path:string;status:string}>(`SELECT relative_path,status FROM attachments WHERE attachment_id=$1`,[attachmentId])).rows[0]!;
    expect(row.status).toBe('ready');
    expect(row.relative_path).not.toMatch(/\/(?:19|20)\d{2}\/\d{2}\//);
    expect(row.relative_path).toContain('Display Name-');
    expect(row.relative_path).toContain('2026-11-01_07-30-00_');
    expect(row.relative_path.endsWith('/original file.pdf')).toBe(true);
    const primaryFile=path.join(directory,'primary',...row.relative_path.split('/'));
    expect(await readFile(primaryFile)).toEqual(bytes);
    await expect(readFile(path.join(directory,'primary',...primaryRelative.split('/')))).rejects.toMatchObject({code:'ENOENT'});

    const tempRoot=path.join(directory,'secondary');
    await service.executeFolderCommand({accountId,chatType:'group',chatId},'admin',{type:'folder',action:'temp_set',path:tempRoot});
    await waitForStatus('secondary','completed');
    const tempRow=(await pool.query<{target_relative_path:string}>(`SELECT target_relative_path FROM attachment_storage_jobs WHERE attachment_id=$1 AND target_kind='secondary'`,[attachmentId])).rows[0]!;
    const expectedGroupTempPath=buildAttachmentLocation({root:tempRoot,identity:{accountId,chatType:'group',chatId,messageId,
      externalAttachmentId:'external-archive-1'},occurredAt:'2026-10-31T23:30:00Z',originalFileName:'original file.pdf',
      sender:{id:'sender-😀-stable',displayName:'Display Name'},layout:'secondary'}).managedRelativePath;
    expect(tempRow.target_relative_path).toBe(expectedGroupTempPath);
    expect(tempRow.target_relative_path).not.toMatch(/\/(?:19|20)\d{2}\/\d{2}\//);
    expect(await readFile(path.join(tempRoot,...tempRow.target_relative_path.split('/')))).toEqual(bytes);

    const directChatId=`peer-${randomUUID()}`;
    const directMessageId=`direct-${randomUUID()}`;
    const directAttachmentId=randomUUID();
    const directBytes=Buffer.from('direct secondary bytes');
    const directRelative='direct/2026/10/direct source.txt';
    const directSource=path.join(primaryRoot,...directRelative.split('/'));
    await mkdir(path.dirname(directSource),{recursive:true});
    await writeFile(directSource,directBytes);
    await pool.query('INSERT INTO conversations(account_id,chat_id,chat_type,title) VALUES ($1,$2,\'direct\',\'Peer\')',[accountId,directChatId]);
    await pool.query(`INSERT INTO messages(account_id,message_id,event_id,chat_id,chat_type,sender_id,kind,ingestion_source,occurred_at,raw)
      VALUES ($1,$2,$3,$4,'direct',$5,'file','live','2026-10-31T23:30:00Z','{}'::jsonb)`,
      [accountId,directMessageId,`event-${directMessageId}`,directChatId,directChatId]);
    await pool.query(`INSERT INTO attachments(attachment_id,external_attachment_id,account_id,chat_type,chat_id,message_id,kind,name,mime_type,size_bytes,status,relative_path,sha256)
      VALUES ($1,'external-direct',$2,'direct',$3,$4,'file','direct source.txt','text/plain',$5,'ready',$6,$7)`,
      [directAttachmentId,accountId,directChatId,directMessageId,directBytes.byteLength,directRelative,createHash('sha256').update(directBytes).digest('hex')]);
    const directKey={accountId,chatType:'direct' as const,chatId:directChatId};
    const directSetting=await repository.setSecondaryRoot(directKey,tempRoot);
    expect(await repository.admitReadyAttachment(directKey,directAttachmentId,directSetting.generation)).toBe(true);
    await waitForStatus('secondary','completed',directAttachmentId);
    const directTarget=(await pool.query<{target_relative_path:string}>(`SELECT target_relative_path FROM attachment_storage_jobs WHERE attachment_id=$1 AND target_kind='secondary'`,[directAttachmentId])).rows[0]!.target_relative_path;
    expect(directTarget).toBe(buildAttachmentLocation({root:tempRoot,identity:{accountId,chatType:'direct',chatId:directChatId,
      messageId:directMessageId,externalAttachmentId:'external-direct'},occurredAt:'2026-10-31T23:30:00Z',originalFileName:'direct source.txt',
      sender:{id:directChatId,displayName:null},layout:'secondary'}).managedRelativePath);
    expect(await readFile(path.join(tempRoot,...directTarget.split('/')))).toEqual(directBytes);

    const missingAttachmentId=randomUUID();
    await pool.query(`INSERT INTO attachments(attachment_id,external_attachment_id,account_id,chat_type,chat_id,message_id,kind,name,mime_type,size_bytes,status,relative_path,sha256)
      VALUES ($1,'external-missing-1',$2,'group',$3,$4,'file','missing.pdf','application/pdf',4,'ready','legacy/2025/12/missing.pdf',repeat('b',64))`,
      [missingAttachmentId,accountId,chatId,messageId]);
    await repository.queueReclassification({accountId,chatType:'group',chatId},missingAttachmentId);
    const deadline=Date.now()+10_000;
    let failed=false;
    while(Date.now()<deadline){
      const job=await pool.query<{status:string}>(`SELECT status FROM attachment_storage_jobs WHERE attachment_id=$1 AND target_kind='reclassify'`,[missingAttachmentId]);
      if(job.rows[0]?.status==='failed'){failed=true;break;}
      await new Promise((resolve)=>setTimeout(resolve,50));
    }
    expect(failed).toBe(true);
    expect((await pool.query<{status:string;relative_path:string}>(`SELECT status,relative_path FROM attachments WHERE attachment_id=$1`,[missingAttachmentId])).rows[0])
      .toEqual({status:'ready',relative_path:'legacy/2025/12/missing.pdf'});

    await service.shutdown();
    const pendingAttachmentId=randomUUID();
    await pool.query(`INSERT INTO attachments(attachment_id,external_attachment_id,account_id,chat_type,chat_id,message_id,kind,name,mime_type,size_bytes,status,relative_path,sha256)
      VALUES ($1,'external-pending-1',$2,'group',$3,$4,'file','pending copy.pdf','application/pdf',$5,'ready',$6,$7)`,
      [pendingAttachmentId,accountId,chatId,messageId,bytes.byteLength,row.relative_path,sha256]);
    const currentSetting=await repository.getSetting({accountId,chatType:'group',chatId});
    expect(await repository.admitReadyAttachment({accountId,chatType:'group',chatId},pendingAttachmentId,currentSetting.generation)).toBe(true);
    const nativeBroker=createWindowsAttachmentBroker({helperPath});
    let brokerEntered!:()=>void;
    const entered=new Promise<void>((resolve)=>{brokerEntered=resolve;});
    let releaseBroker!:()=>void;
    const held=new Promise<void>((resolve)=>{releaseBroker=resolve;});
    const pendingBroker:AttachmentFilesystemSafetyBroker={guarantees:nativeBroker.guarantees,storeAnchored:async(request)=>{
      brokerEntered();
      await held;
      return nativeBroker.storeAnchored(request);
    }};
    const drainingService=new AttachmentStorageService({repository,messages:new MessageRepository(pool),attachmentRoot:primaryRoot,
      windowsSafetyBroker:pendingBroker,onError:(error)=>backgroundErrors.push(error)});
    drainingService.start();
    await Promise.race([entered,new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error('pending copy did not start')),10_000))]);
    let shutdownFinished=false;
    const shutdown=drainingService.shutdown().then(()=>{shutdownFinished=true;});
    await new Promise((resolve)=>setTimeout(resolve,30));
    expect(shutdownFinished).toBe(false);
    releaseBroker();
    await shutdown;
    expect((await pool.query<{status:string;relative_path:string}>(`SELECT status,relative_path FROM attachments WHERE attachment_id=$1`,[pendingAttachmentId])).rows[0])
      .toEqual({status:'ready',relative_path:row.relative_path});
    expect((await pool.query<{status:string}>(`SELECT status FROM attachment_storage_jobs WHERE attachment_id=$1 AND target_kind='secondary'`,[pendingAttachmentId])).rows[0]?.status)
      .toBe('failed');
    expect(backgroundErrors).toEqual([]);
  },20_000);
});
