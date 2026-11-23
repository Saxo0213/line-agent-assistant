import {asIdentifier,asObject,parseJsonl} from './jsonl.js';
import {claudeIsTaskNotification,claudeIsTurnActivity,claudeResultOf,claudeUserTurnLine} from './claude.js';
import {MAX_RELAY_QUEUE,planRelay,RELAY_POLL_MS,RELAY_SPAWN_GRACE_MS,type RelayItem} from './relay.js';
import type {RunningProcess} from './process-runner.js';

/**
 * Resident stream-json host. Port of CliTalkAgent stream_json_host.rs.
 * One process serves many turns. One reader reads stdout for the whole life of the process.
 * AgentCliBridge does not use this module yet.
 */

/** CliTalkAgent TURN_POLL_INTERVAL (stream_json_host.rs:45). */
export const RESIDENT_POLL_MS=500;
/** Fresh drain: quiet time and total time (stream_json_host.rs:480-490). */
export const RESIDENT_DRAIN_QUIET_MS=300;
export const RESIDENT_DRAIN_MAX_MS=2000;
export const RESIDENT_STDERR_TAIL_BYTES=64*1024;
export const RESIDENT_DEFAULT_IDLE_MS=600_000;
export const RESIDENT_MIN_IDLE_MS=60_000;
/** After the process exits, wait this long for the last output of the pipes. */
const PIPE_GRACE_MS=250;

export type ResidentEndReason='result'|'stalled'|'ended'|'timeout'|'cancelled';
export type ResidentTurnEvent=
  |{type:'line';value:unknown}
  |{type:'end';reason:ResidentEndReason;stalledMs?:number;/** Only for 'ended': the last stderr text of the process. */stderrTail?:string};
export type ResidentCloseReason='idle'|'ended'|'cancelled'|'reset'|'replaced'|'stale'|'closed';

export interface ResidentInfo {
  key:string;argsHash:string;cwd:string|undefined;spawnedAt:number;lastActivity:number;
  turnsCompleted:number;capturedSessionId:string|undefined;turnLocked:boolean;stale:boolean;
  toolCallsInFlight:number;currentJobId:string|undefined;
}
export interface ResidentReaped {key:string;turnsCompleted:number;capturedSessionId:string|undefined;cwd:string|undefined;/** CLAUDE_CONFIG_DIR of the resident, when it had one. */claudeConfigDir?:string}
export interface ResidentTimers {
  setTimeout(callback:()=>void,ms:number):unknown;
  clearTimeout(handle:unknown):void;
  setInterval(callback:()=>void,ms:number):unknown;
  clearInterval(handle:unknown):void;
}
export interface ResidentLineSignal {
  key:string;value:unknown;
  /** True while a turn holds the turn lock (CliTalkAgent sync_active). A later relay will use this. */
  syncActive:boolean;
}
export interface ResidentHostOptions {
  idleMs?:number;
  now?:()=>number;
  timers?:ResidentTimers;
  /** Sink hook. It sees every stdout line, also a line between turns. Relay (T20) will use it. A throw is ignored. */
  onLine?:(signal:ResidentLineSignal)=>void;
  /** Most live entries. A new spawn at this limit reaps the idle entry with the oldest lastActivity. Default: no limit. */
  maxResidents?:number;
}
/** Event of a spawn that could not make room: each live entry is busy. The spawn still happens. */
export interface ResidentCapacityExceeded {key:string;live:number;max:number}
/** Texts of autonomous results for one key. The texts are stripped and ready to deliver. */
export interface ResidentAutonomousReply {key:string;texts:string[]}
export interface ResidentTurnRequest {
  key:string;jobId:string;message:string;timeoutMs:number;
  /** 0 = stall check off. */
  stallMs:number;
  cancelled:()=>boolean;
}

interface Box {value:unknown}
interface TurnQueue {boxes:Box[];wake:(()=>void)|null}
interface Entry {
  key:string;argsHash:string;cwd:string|undefined;claudeConfigDir?:string;child:RunningProcess;
  spawnedAt:number;lastActivity:number;lastTurnEvent:number;
  toolCallsInFlight:number;turnLocked:boolean;syncActive:boolean;currentJobId:string|undefined;
  turnsCompleted:number;capturedSessionId:string|undefined;stale:boolean;
  stderrTail:Buffer;needsDrain:boolean;
  turn:TurnQueue|null;lock:Promise<void>;pending:number;
  closed:boolean;exited:boolean;
  /** Relay signals (CliTalkAgent sink): see stream_json_host.rs StreamEntry. */
  sawActivitySinceResult:boolean;originTaskNotification:boolean;resultSeq:number;
  relayQueue:RelayItem[];relayHighWater:number;
}

const defaultTimers:ResidentTimers={
  setTimeout:(callback,ms)=>setTimeout(callback,ms),
  clearTimeout:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval:(callback,ms)=>{const handle=setInterval(callback,ms);handle.unref?.();return handle;},
  clearInterval:handle=>clearInterval(handle as ReturnType<typeof setInterval>),
};

export class ResidentHost {
  private readonly entries=new Map<string,Entry>();
  private readonly closedListeners=new Set<(event:{key:string;reason:ResidentCloseReason})=>void>();
  private readonly reapedListeners=new Set<(event:ResidentReaped)=>void>();
  private idleMs:number;
  private readonly maxResidents:number;
  private readonly capacityListeners=new Set<(event:ResidentCapacityExceeded)=>void>();
  private readonly now:()=>number;
  private readonly timers:ResidentTimers;
  private readonly sink:((signal:ResidentLineSignal)=>void)|undefined;
  private reaperHandle:unknown;
  private relayHandle:unknown;
  private relayTarget:((key:string)=>boolean)|undefined;
  private readonly autonomousListeners=new Set<(event:ResidentAutonomousReply)=>void>();
  /** Key-level lock: the tail of the waiter chain, and the number of holders and waiters of each key. */
  private readonly keyTails=new Map<string,Promise<void>>();
  private readonly keyHolders=new Map<string,number>();
  constructor(options:ResidentHostOptions={}) {
    this.idleMs=Math.max(RESIDENT_MIN_IDLE_MS,options.idleMs??RESIDENT_DEFAULT_IDLE_MS);
    this.now=options.now??(()=>Date.now());
    this.timers=options.timers??defaultTimers;
    this.sink=options.onLine;
    this.maxResidents=options.maxResidents!==undefined&&options.maxResidents>=1?Math.floor(options.maxResidents):Number.POSITIVE_INFINITY;
  }

  /** Scan interval: idle / 4, from 30 s to 300 s (stream_json_host.rs:1322-1329). */
  get reapIntervalMs():number {return Math.min(300_000,Math.max(30_000,Math.floor(this.idleMs/4)));}

  /** Change the idle time (at least 60 s). A running reaper timer restarts with the new scan interval. */
  setIdleMs(idleMs:number):void {
    this.idleMs=Math.max(RESIDENT_MIN_IDLE_MS,idleMs);
    if(this.reaperHandle!==undefined) {this.stopReaper();this.startReaper();}
  }

  has(key:string):boolean {return this.entries.has(key);}
  info(key:string):ResidentInfo|undefined {
    const entry=this.entries.get(key);
    return entry?this.snapshot(entry):undefined;
  }
  /** The process of a live entry. */
  child(key:string):RunningProcess|undefined {return this.entries.get(key)?.child;}
  /**
   * Wait for the key-level lock and return its release function. The caller holds the lock from before ensure() until the turn ends,
   * so a second job on the same key cannot replace the process while the first turn runs. The reaper skips a key with a holder or a waiter.
   * The release function is safe to call more than once.
   */
  async lockKey(key:string):Promise<()=>void> {
    const previous=this.keyTails.get(key)??Promise.resolve();
    let open!:()=>void;
    const mine=new Promise<void>(resolve=>{open=resolve;});
    const tail=previous.then(()=>mine);
    this.keyTails.set(key,tail);
    this.keyHolders.set(key,(this.keyHolders.get(key)??0)+1);
    await previous;
    let released=false;
    return ()=>{
      if(released) return;
      released=true;
      const count=(this.keyHolders.get(key)??1)-1;
      if(count<=0) {this.keyHolders.delete(key);if(this.keyTails.get(key)===tail) this.keyTails.delete(key);}
      else this.keyHolders.set(key,count);
      open();
    };
  }
  /** True while a job holds the key lock or waits for it. */
  isKeyLocked(key:string):boolean {return (this.keyHolders.get(key)??0)>0;}
  /** The stderr text of a live entry (last 64 KB). */
  stderrTail(key:string):string {return this.entries.get(key)?.stderrTail.toString('utf8')??'';}

  onClosed(listener:(event:{key:string;reason:ResidentCloseReason})=>void):()=>void {
    this.closedListeners.add(listener);
    return ()=>{this.closedListeners.delete(listener);};
  }
  /** Listener for autonomous replies (a result that no LINEJS turn started). */
  onAutonomous(listener:(event:ResidentAutonomousReply)=>void):()=>void {
    this.autonomousListeners.add(listener);
    return ()=>{this.autonomousListeners.delete(listener);};
  }
  /** Set the target check. The relay timer runs only while a target check is set. Without a target for a key, only the high-water mark moves. */
  setRelayTarget(hasTarget:((key:string)=>boolean)|undefined):void {
    this.relayTarget=hasTarget;
    if(hasTarget) this.startRelay();
    else this.stopRelay();
  }
  /** Listener for a spawn at the capacity limit when no entry can be reaped. */
  onCapacityExceeded(listener:(event:ResidentCapacityExceeded)=>void):()=>void {
    this.capacityListeners.add(listener);
    return ()=>{this.capacityListeners.delete(listener);};
  }
  onReaped(listener:(event:ResidentReaped)=>void):()=>void {
    this.reapedListeners.add(listener);
    return ()=>{this.reapedListeners.delete(listener);};
  }

  /**
   * Get the entry for a key, or start it. One entry for each key.
   * An entry with another argsHash, or a stale entry, is killed and removed first.
   * Returns fresh=true when this call started a new process.
   */
  ensure(key:string,argsHash:string,spawn:()=>RunningProcess,options:{cwd?:string;claudeConfigDir?:string}={}):{fresh:boolean} {
    const existing=this.entries.get(key);
    if(existing) {
      if(existing.argsHash===argsHash&&!existing.stale) return {fresh:false};
      this.close(existing,existing.stale?'stale':'replaced');
    }
    this.makeRoom(key);
    const child=spawn();
    const time=this.now();
    const entry:Entry={
      key,argsHash,cwd:options.cwd,...(options.claudeConfigDir===undefined?{}:{claudeConfigDir:options.claudeConfigDir}),child,spawnedAt:time,lastActivity:time,lastTurnEvent:time,
      toolCallsInFlight:0,turnLocked:false,syncActive:false,currentJobId:undefined,
      turnsCompleted:0,capturedSessionId:undefined,stale:false,
      stderrTail:Buffer.alloc(0),needsDrain:true,turn:null,lock:Promise.resolve(),pending:0,
      closed:false,exited:false,
      sawActivitySinceResult:false,originTaskNotification:false,resultSeq:0,relayQueue:[],relayHighWater:0,
    };
    this.entries.set(key,entry);
    this.watch(entry);
    this.startReaper();
    this.startRelay();
    return {fresh:true};
  }

  /**
   * Keep the live entries below the limit before a spawn. Reap the entry with the oldest lastActivity that is not busy
   * (same rule as reapIdle: skip a turn-locked entry, an entry with pending turns, and a key that is locked or waited for).
   * The close reason is 'idle' and the reaped listeners run, so Auto-Slim and the MCP release still run.
   * If no entry can be reaped, the spawn still happens and the capacity listeners run.
   */
  private makeRoom(spawnKey:string):void {
    while(this.entries.size>=this.maxResidents) {
      let victim:Entry|undefined;
      for(const entry of this.entries.values()) {
        if(entry.key===spawnKey) continue;
        if(entry.turnLocked||entry.pending>0||this.isKeyLocked(entry.key)) continue;
        if(victim===undefined||entry.lastActivity<victim.lastActivity) victim=entry;
      }
      if(victim===undefined) {
        const event:ResidentCapacityExceeded={key:spawnKey,live:this.entries.size,max:this.maxResidents};
        for(const listener of [...this.capacityListeners]) {try {listener(event);} catch {/* Ignore. */}}
        return;
      }
      this.close(victim,'idle',true);
    }
  }

  /** Change the tool call counter of the entry that runs this job. A counter above 0 keeps the turn alive. */
  noteToolActivity(jobId:string,delta:1|-1):void {
    for(const entry of this.entries.values()) {
      if(entry.currentJobId===jobId) {
        entry.toolCallsInFlight=Math.max(0,entry.toolCallsInFlight+delta);
        return;
      }
    }
  }
  /** Kill and remove one entry. */
  reset(key:string):void {
    const entry=this.entries.get(key);
    if(entry) this.close(entry,'reset');
  }
  /** Kill and remove each entry that the predicate accepts. Returns the number of entries. */
  resetWhere(predicate:(key:string,info:ResidentInfo)=>boolean):number {
    let count=0;
    for(const entry of [...this.entries.values()]) {
      if(predicate(entry.key,this.snapshot(entry))) {this.close(entry,'reset');count++;}
    }
    return count;
  }
  /** For each entry that the predicate accepts: mark it stale when a turn or a key lock is active, else remove it now. Returns the number of entries. */
  markStaleWhere(predicate:(key:string,info:ResidentInfo)=>boolean):number {
    let count=0;
    for(const entry of [...this.entries.values()]) {
      if(!predicate(entry.key,this.snapshot(entry))) continue;
      count++;
      if(entry.turnLocked||entry.pending>0||this.isKeyLocked(entry.key)) entry.stale=true;
      else this.close(entry,'stale');
    }
    return count;
  }
  /** Stop the reaper timer. Kill and remove all entries. */
  closeAll():void {
    this.stopReaper();
    this.stopRelay();
    for(const entry of [...this.entries.values()]) this.close(entry,'closed');
  }

  /**
   * Run one turn. Yields each stdout line of this turn, then exactly one `end` event.
   * 'result': an accepted result line (yielded before the end). 'stalled' and 'timeout': the turn ends and the
   * process stays, the same as CliTalkAgent run_turn (stream_json_host.rs:537-556); the caller resets the entry.
   * 'ended': the process ended, or the entry was closed. 'cancelled': cancelled() was true; the process is killed.
   */
  async *runTurn(request:ResidentTurnRequest):AsyncGenerator<ResidentTurnEvent,void,undefined> {
    const entry=this.entries.get(request.key);
    if(!entry||entry.closed) {yield {type:'end',reason:'ended'};return;}
    entry.pending++;
    const previous=entry.lock;
    let release!:()=>void;
    entry.lock=new Promise<void>(resolve=>{release=resolve;});
    await previous;
    entry.pending--;
    try {
      if(entry.closed) {yield {type:'end',reason:'ended',stderrTail:this.tail(entry)};return;}
      entry.turnLocked=true;
      entry.syncActive=true;
      entry.currentJobId=request.jobId;
      entry.toolCallsInFlight=0;
      entry.lastActivity=this.now();
      const queue:TurnQueue={boxes:[],wake:null};
      entry.turn=queue;
      if(entry.needsDrain) {
        entry.needsDrain=false;
        const early=await this.drain(entry,queue,request);
        if(early) {yield early;return;}
      }
      queue.boxes.length=0;
      try {
        if(!entry.child.write) throw new Error('Process stdin is not available');
        entry.child.write(claudeUserTurnLine(request.message));
      } catch {
        // CliTalkAgent returns the write error. Here the entry is removed, because a process with a closed stdin cannot serve a turn.
        this.close(entry,'ended');
        yield {type:'end',reason:'ended',stderrTail:this.tail(entry)};
        return;
      }
      entry.lastTurnEvent=this.now();
      const deadline=this.now()+request.timeoutMs;
      const poll=request.stallMs>0&&request.stallMs<RESIDENT_POLL_MS?Math.max(1,request.stallMs):RESIDENT_POLL_MS;
      let sawActivity=false;
      for(;;) {
        if(request.cancelled()) {
          this.close(entry,'cancelled');
          yield {type:'end',reason:'cancelled'};
          return;
        }
        const time=this.now();
        if(entry.toolCallsInFlight>0) entry.lastTurnEvent=time;
        if(request.stallMs>0&&time-entry.lastTurnEvent>=request.stallMs) {
          yield {type:'end',reason:'stalled',stalledMs:time-entry.lastTurnEvent};
          return;
        }
        const remaining=deadline-time;
        if(remaining<=0) {yield {type:'end',reason:'timeout'};return;}
        const box=queue.boxes.shift();
        if(box) {
          entry.lastTurnEvent=this.now();
          if(claudeIsTurnActivity(box.value)) sawActivity=true;
          const result=claudeResultOf(box.value);
          if(result&&!sawActivity&&!result.isError) continue; // A result before any turn activity is an old result (stream_json_host.rs:622-626).
          yield {type:'line',value:box.value};
          if(result) {
            if(!result.isError) entry.turnsCompleted++;
            yield {type:'end',reason:'result'};
            return;
          }
          continue;
        }
        if(entry.closed) {yield {type:'end',reason:'ended',stderrTail:this.tail(entry)};return;}
        await this.waitSignal(queue,Math.min(remaining,poll));
      }
    } finally {
      entry.turn=null;
      entry.turnLocked=false;
      entry.syncActive=false;
      entry.currentJobId=undefined;
      entry.toolCallsInFlight=0;
      release();
    }
  }

  private tail(entry:Entry):string {return entry.stderrTail.toString('utf8');}
  private snapshot(entry:Entry):ResidentInfo {
    return {
      key:entry.key,argsHash:entry.argsHash,cwd:entry.cwd,spawnedAt:entry.spawnedAt,lastActivity:entry.lastActivity,
      turnsCompleted:entry.turnsCompleted,capturedSessionId:entry.capturedSessionId,turnLocked:entry.turnLocked,
      stale:entry.stale,toolCallsInFlight:entry.toolCallsInFlight,currentJobId:entry.currentJobId,
    };
  }

  /** Wait until a line arrives, the entry closes, or ms pass. The caller checks the queue again. */
  private waitSignal(queue:TurnQueue,ms:number):Promise<void> {
    return new Promise<void>(resolve=>{
      let handle:unknown;
      const done=()=>{this.timers.clearTimeout(handle);queue.wake=null;resolve();};
      handle=this.timers.setTimeout(done,ms);
      queue.wake=done;
    });
  }

  /** Fresh drain: wait for 300 ms with no line, 2 s at most. The lines are dropped. Returns an end event if the turn must end. */
  private async drain(entry:Entry,queue:TurnQueue,request:ResidentTurnRequest):Promise<ResidentTurnEvent|undefined> {
    const cap=this.now()+RESIDENT_DRAIN_MAX_MS;
    while(this.now()<cap) {
      if(request.cancelled()) {this.close(entry,'cancelled');return {type:'end',reason:'cancelled'};}
      if(entry.closed) return {type:'end',reason:'ended',stderrTail:this.tail(entry)};
      if(queue.boxes.length>0) {queue.boxes.length=0;continue;}
      await this.waitSignal(queue,Math.max(1,Math.min(RESIDENT_DRAIN_QUIET_MS,cap-this.now())));
      if(queue.boxes.length===0&&!entry.closed) break; // 300 ms with no line
    }
    queue.boxes.length=0;
    return undefined;
  }

  private onLine(entry:Entry,value:unknown):void {
    entry.lastActivity=this.now();
    const data=asObject(value);
    const sessionId=asIdentifier(data?.session_id)??asIdentifier(data?.sessionId);
    if(sessionId) entry.capturedSessionId=sessionId;
    if(this.sink) {
      try {this.sink({key:entry.key,value,syncActive:entry.syncActive});} catch {/* A sink error never stops the reader. */}
    }
    this.noteRelaySignals(entry,value);
    const turn=entry.turn;
    if(turn) {
      turn.boxes.push({value});
      turn.wake?.();
    }
  }

  /** CliTalkAgent sink: collect the relay signals of each line. It runs for every line, also between turns. */
  private noteRelaySignals(entry:Entry,value:unknown):void {
    if(claudeIsTurnActivity(value)) entry.sawActivitySinceResult=true;
    if(claudeIsTaskNotification(value)) entry.originTaskNotification=true;
    if(!claudeResultOf(value)) return;
    entry.resultSeq++;
    const raw=asObject(value)?.result;
    const item:RelayItem={
      seq:entry.resultSeq,text:typeof raw==='string'?raw:'',
      syncActiveAtEmit:entry.syncActive,sawActivity:entry.sawActivitySinceResult,
      withinGrace:this.now()-entry.spawnedAt<RELAY_SPAWN_GRACE_MS,originTaskNotification:entry.originTaskNotification,
    };
    entry.sawActivitySinceResult=false;
    entry.originTaskNotification=false;
    entry.relayQueue.push(item);
    if(entry.relayQueue.length>MAX_RELAY_QUEUE) entry.relayQueue.splice(0,entry.relayQueue.length-MAX_RELAY_QUEUE);
  }

  private startRelay():void {
    if(this.relayHandle!==undefined||!this.relayTarget) return;
    this.relayHandle=this.timers.setInterval(()=>this.relayScan(),RELAY_POLL_MS);
  }
  private stopRelay():void {
    if(this.relayHandle===undefined) return;
    this.timers.clearInterval(this.relayHandle);
    this.relayHandle=undefined;
  }
  /** One relay scan (public for tests). CliTalkAgent relay_autonomous_replies and take_relay_texts. */
  relayScan():void {
    const hasTargetOf=this.relayTarget;
    if(!hasTargetOf) return;
    for(const entry of [...this.entries.values()]) {
      if(entry.relayQueue.length===0) continue;
      let hasTarget=false;
      try {hasTarget=hasTargetOf(entry.key);} catch {/* A target check error means no target. */}
      const items=entry.relayQueue;
      entry.relayQueue=[];
      const plan=planRelay(items,hasTarget,entry.relayHighWater,entry.syncActive);
      entry.relayHighWater=plan.highWater;
      // Deferred items go back to the front of the queue. A line that came in later has a larger seq.
      if(plan.deferred.length>0) entry.relayQueue=[...plan.deferred,...entry.relayQueue];
      if(plan.deliver.length===0) continue;
      for(const listener of [...this.autonomousListeners]) {try {listener({key:entry.key,texts:plan.deliver});} catch {/* Ignore. */}}
    }
  }

  /** One stdout reader and one stderr reader for the whole life of the process. */
  private watch(entry:Entry):void {
    const reader=(async()=>{
      try {for await(const value of parseJsonl(entry.child.stdout)) this.onLine(entry,value);} catch {/* A broken pipe is the end of the process. */}
    })();
    const errorReader=(async()=>{
      try {
        for await(const chunk of entry.child.stderr) {
          const joined=Buffer.concat([entry.stderrTail,Buffer.from(chunk)]);
          entry.stderrTail=joined.length>RESIDENT_STDERR_TAIL_BYTES?joined.subarray(joined.length-RESIDENT_STDERR_TAIL_BYTES):joined;
        }
      } catch {/* Ignore. */}
    })();
    const exited=entry.child.exited.then(()=>{entry.exited=true;},()=>{entry.exited=true;});
    void Promise.race([exited,reader]).then(async()=>{
      // Give the pipes a short time to deliver the last output.
      await new Promise<void>(resolve=>{
        const handle=this.timers.setTimeout(resolve,PIPE_GRACE_MS);
        void Promise.all([reader,errorReader,exited]).then(()=>{this.timers.clearTimeout(handle);resolve();});
      });
      // A process that ended while no turn runs is removed too. CliTalkAgent keeps a dead entry (known defect).
      this.close(entry,'ended');
    });
  }

  /** Remove the entry, kill the process, wake the turn, call the listeners. */
  private close(entry:Entry,reason:ResidentCloseReason,reaped=false):void {
    if(entry.closed) return;
    entry.closed=true;
    if(this.entries.get(entry.key)===entry) this.entries.delete(entry.key);
    if(!entry.exited) {
      entry.exited=true;
      void entry.child.cancel().catch(()=>{});
    }
    entry.turn?.wake?.();
    if(reaped) {
      const event:ResidentReaped={key:entry.key,turnsCompleted:entry.turnsCompleted,capturedSessionId:entry.capturedSessionId,cwd:entry.cwd,...(entry.claudeConfigDir===undefined?{}:{claudeConfigDir:entry.claudeConfigDir})};
      for(const listener of [...this.reapedListeners]) {try {listener(event);} catch {/* Ignore. */}}
    }
    for(const listener of [...this.closedListeners]) {try {listener({key:entry.key,reason});} catch {/* Ignore. */}}
  }

  private startReaper():void {
    if(this.reaperHandle!==undefined) return;
    // The first scan comes after one interval (stream_json_host.rs:1322-1329).
    this.reaperHandle=this.timers.setInterval(()=>this.reapIdle(),this.reapIntervalMs);
  }
  private stopReaper():void {
    if(this.reaperHandle===undefined) return;
    this.timers.clearInterval(this.reaperHandle);
    this.reaperHandle=undefined;
  }
  /** One scan (public for tests). try_reap_if_idle (stream_json_host.rs:794-820): skip a locked entry, check again, then remove. */
  reapIdle():void {
    for(const entry of [...this.entries.values()]) {
      if(this.now()-entry.lastActivity<this.idleMs) continue;
      if(entry.turnLocked||entry.pending>0||this.isKeyLocked(entry.key)) continue;
      if(this.now()-entry.lastActivity<this.idleMs) continue;
      this.close(entry,'idle',true);
    }
  }
}
