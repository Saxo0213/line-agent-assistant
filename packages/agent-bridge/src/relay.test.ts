import {describe,expect,it} from 'vitest';
import {classifyAutonomous,planRelay,shouldRelay,type RelayItem} from './relay.js';

const item=(seq:number,text:string,overrides:Partial<RelayItem>={}):RelayItem=>({
  seq,text,syncActiveAtEmit:false,sawActivity:true,withinGrace:false,originTaskNotification:false,...overrides,
});

describe('classifyAutonomous',()=>{
  it('follows the truth table',()=>{
    expect(classifyAutonomous(true,true,false,false)).toBe(false);
    expect(classifyAutonomous(true,false,false,true)).toBe(false);
    expect(classifyAutonomous(true,true,true,true)).toBe(false);
    expect(classifyAutonomous(false,true,true,false)).toBe(false);
    expect(classifyAutonomous(false,true,true,true)).toBe(false);
    expect(classifyAutonomous(false,false,false,true)).toBe(true);
    expect(classifyAutonomous(false,true,false,false)).toBe(true);
    expect(classifyAutonomous(false,false,false,false)).toBe(false);
  });
});

describe('shouldRelay',()=>{
  it('needs all conditions',()=>{
    const auto={seq:5,autonomous:true,textNonEmpty:true};
    expect(shouldRelay(auto,true,4,false)).toBe(true);
    expect(shouldRelay(auto,false,4,false)).toBe(false);
    expect(shouldRelay(auto,true,5,false)).toBe(false);
    expect(shouldRelay(auto,true,6,false)).toBe(false);
    expect(shouldRelay(auto,true,4,true)).toBe(false);
    expect(shouldRelay({...auto,autonomous:false},true,4,false)).toBe(false);
    expect(shouldRelay({...auto,textNonEmpty:false},true,4,false)).toBe(false);
  });
});

describe('planRelay',()=>{
  it('delivers an autonomous result once, trimmed',()=>{
    const plan=planRelay([item(1,'  done: 42  ')],true,0,false);
    expect(plan).toEqual({deliver:['done: 42'],highWater:1,deferred:[]});
  });
  it('strips a leading timestamp',()=>{
    expect(planRelay([item(1,'[12:30] done')],true,0,false).deliver).toEqual(['done']);
  });
  it('skips a synchronous result and moves the mark',()=>{
    const plan=planRelay([item(1,'normal',{syncActiveAtEmit:true})],true,0,false);
    expect(plan.deliver).toEqual([]);
    expect(plan.highWater).toBe(1);
  });
  it('never relays a synchronous result that has a task-notification origin',()=>{
    const plan=planRelay([item(1,'explain <task-notification>',{syncActiveAtEmit:true,originTaskNotification:true})],true,0,false);
    expect(plan.deliver).toEqual([]);
  });
  it('without a target delivers nothing and moves the mark',()=>{
    const plan=planRelay([item(1,'auto')],false,0,false);
    expect(plan.deliver).toEqual([]);
    expect(plan.highWater).toBe(1);
  });
  it('delivers two results in order and never again',()=>{
    const batch=[item(1,'first'),item(2,'second')];
    const plan=planRelay(batch,true,0,false);
    expect(plan.deliver).toEqual(['first','second']);
    expect(plan.highWater).toBe(2);
    const again=planRelay(batch,true,plan.highWater,false);
    expect(again.deliver).toEqual([]);
    expect(again.highWater).toBe(2);
  });
  it('defers while a synchronous turn runs, keeps order, keeps the mark',()=>{
    const plan=planRelay([item(1,'A'),item(2,'B')],true,0,true);
    expect(plan.deliver).toEqual([]);
    expect(plan.highWater).toBe(0);
    expect(plan.deferred.map(entry=>entry.seq)).toEqual([1,2]);
    const next=planRelay(plan.deferred,true,plan.highWater,false);
    expect(next.deliver).toEqual(['A','B']);
    expect(next.highWater).toBe(2);
  });
  it('settles an item before a deferred item and defers the rest',()=>{
    const plan=planRelay([item(1,'old',{sawActivity:false}),item(2,'A'),item(3,'B')],true,0,true);
    expect(plan.highWater).toBe(1);
    expect(plan.deferred.map(entry=>entry.seq)).toEqual([2,3]);
  });
  it('does not deliver an empty text',()=>{
    expect(planRelay([item(1,'   ')],true,0,false).deliver).toEqual([]);
  });
});
