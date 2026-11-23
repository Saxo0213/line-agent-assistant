import {stripLeadingTimestamp} from './claude.js';

/**
 * Relay of autonomous Claude results. Port of CliTalkAgent stream_json_host.rs
 * (classify_autonomous, should_relay, plan_relay). Pure functions.
 */

/** CliTalkAgent MAX_RELAY_QUEUE. */
export const MAX_RELAY_QUEUE=128;
/** CliTalkAgent RELAY_SPAWN_GRACE (ms). */
export const RELAY_SPAWN_GRACE_MS=4000;
/** CliTalkAgent RELAY_POLL (ms). */
export const RELAY_POLL_MS=1000;

/** One result line and the signals that classify it. */
export interface RelayItem {
  seq:number;
  /** Result text. Not stripped yet. */
  text:string;
  syncActiveAtEmit:boolean;
  sawActivity:boolean;
  withinGrace:boolean;
  originTaskNotification:boolean;
}
export interface RelayMeta {seq:number;autonomous:boolean;textNonEmpty:boolean}
export interface RelayPlan {deliver:string[];highWater:number;deferred:RelayItem[]}

/**
 * True when the result is not the product of a synchronous turn.
 * Two hard vetoes come first, in this order: a synchronous result, then a result inside the spawn grace.
 */
export function classifyAutonomous(syncActiveAtEmit:boolean,sawActivity:boolean,withinGrace:boolean,originTaskNotification:boolean):boolean {
  if(syncActiveAtEmit) return false;
  if(withinGrace) return false;
  return originTaskNotification||sawActivity;
}

/** True when all conditions hold: target, autonomous, text, seq above the high-water mark, no synchronous turn now. */
export function shouldRelay(meta:RelayMeta,hasTarget:boolean,highWater:number,syncActiveNow:boolean):boolean {
  return hasTarget&&meta.autonomous&&meta.textNonEmpty&&meta.seq>highWater&&!syncActiveNow;
}

/**
 * Plan the relay of a batch (seq in ascending order).
 * An autonomous item with a target while a synchronous turn runs is deferred with all items after it.
 * The high-water mark never passes a deferred item.
 */
export function planRelay(items:readonly RelayItem[],hasTarget:boolean,highWater:number,syncActiveNow:boolean):RelayPlan {
  const deliver:string[]=[];
  let deferred:RelayItem[]=[];
  for(let index=0;index<items.length;index++) {
    const item=items[index]!;
    if(item.seq<=highWater) continue;
    const autonomous=classifyAutonomous(item.syncActiveAtEmit,item.sawActivity,item.withinGrace,item.originTaskNotification);
    if(autonomous&&hasTarget&&syncActiveNow) {
      deferred=items.slice(index);
      break;
    }
    const stripped=stripLeadingTimestamp(item.text.trim());
    const meta:RelayMeta={seq:item.seq,autonomous,textNonEmpty:stripped.trim()!==''};
    if(shouldRelay(meta,hasTarget,highWater,syncActiveNow)) deliver.push(stripped);
    highWater=item.seq;
  }
  return {deliver,highWater,deferred};
}
