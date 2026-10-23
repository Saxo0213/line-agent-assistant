import { describe, expect, it, vi } from 'vitest';
import type { AgentRepository } from '@line-agent/database';
import { newAgentService } from './agent-service-test-support.js';

const key = { accountId: 'a', chatType: 'direct' as const, chatId: 'c' };
const bridge = { async *run() {}, async cancel() {} };
describe('workspace submission and retry', () => {
  it.each([true,false])('binds only the bridge canonical started cwd (metadata present: %s)', async canonical => {
    let claimed=false;
    const job={jobId:'job',...key,provider:'codex' as const,sourceType:'ui' as const,sourceRequestId:'r',sourceMessageId:null,
      prompt:'work',workspacePath:'C:\\alias',generation:0,status:'running' as const,creationEpoch:null};
    const bind=vi.fn(async()=>true);
    const service=newAgentService({claimNext:async()=>{if(claimed)return null;claimed=true;return job;},getJob:async()=>job,
      lookupSession:async()=>null,appendEvent:async()=>undefined,bindSession:bind,failJob:async()=>true} as unknown as AgentRepository,
      {current:async()=>job.workspacePath},{async *run(){yield {type:'started' as const,externalSessionId:'external',...(canonical?{workspacePath:'C:\\canonical'}:{})};},async cancel(){}});
    service.kick(key);await service.idle();
    if(canonical) expect(bind).toHaveBeenCalledWith(expect.objectContaining({workspacePath:'C:\\canonical'}));
    else expect(bind).not.toHaveBeenCalled();
  });
  it('uses the authority for submission and ignores renderer workspace', async () => {
    const enqueue = vi.fn(async () => ({ disposition: 'inserted' as const, jobId: 'job' }));
    const service = newAgentService({ enqueueUiJob: enqueue, claimNext: async () => null } as unknown as AgentRepository,
      { current: async () => 'C:\\canonical' } as never, bridge);
    await service.submitFromUi({ requestId: 'r', provider: 'codex', prompt: 'work', workspacePath: 'C:\\evil' });
    await service.idle();
    expect(enqueue.mock.calls[0]).toEqual([{ requestId: 'r', provider: 'codex', prompt: 'work', workspacePath: 'C:\\canonical' }]);
  });
  it('holds a per-job fence before validation through rebind and kick', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const current = vi.fn(async () => { await gate; return 'C:\\new'; });
    const update = vi.fn(async () => true);
    const service = newAgentService({ retryJobForKey: update, claimNext: async () => null } as unknown as AgentRepository,
      { current } as never, bridge);
    const kick = vi.spyOn(service, 'kick');
    const first = service.retryJob(key, 'job');
    const overlap = service.retryJob(key, 'job');
    release(); expect(await first).toBe(true); expect(await overlap).toBe(false); await service.idle();
    expect(current).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledExactlyOnceWith(key, 'job', 'C:\\new');
    expect(kick).toHaveBeenCalledTimes(1);
    expect(await service.retryJob(key, 'job')).toBe(true); await service.idle();
  });
  it('does not transition or kick when fresh validation fails and releases its fence', async () => {
    const update = vi.fn(async () => true);
    const service = newAgentService({ retryJobForKey: update } as unknown as AgentRepository,
      { current: async () => { throw new Error('INVALID_WORKSPACE'); } } as never, bridge);
    const kick = vi.spyOn(service, 'kick');
    await expect(service.retryJob(key, 'job')).rejects.toThrow('INVALID_WORKSPACE');
    await expect(service.retryJob(key, 'job')).rejects.toThrow('INVALID_WORKSPACE');
    expect(update).not.toHaveBeenCalled(); expect(kick).not.toHaveBeenCalled();
  });
  it('does not kick an ineligible retry or a failed repository update', async () => {
    const update = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('database failure'));
    const service = newAgentService({ retryJobForKey: update } as unknown as AgentRepository,
      { current: async () => 'C:\\new' } as never, bridge);
    const kick = vi.spyOn(service, 'kick');
    expect(await service.retryJob(key, 'job')).toBe(false);
    await expect(service.retryJob(key, 'job')).rejects.toThrow('database failure');
    expect(kick).not.toHaveBeenCalled();
  });
});
