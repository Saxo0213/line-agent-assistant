import {describe,expect,it} from 'vitest';
import {buildScheduleInput,defaultFormState,formStateFromSchedule,formUsesLlm,taskChangePatch} from './scheduleForm.js';
import {AgentScheduleCreateInputSchema,type AgentSchedule} from '@line-agent/contracts';
describe('message forwarding form',()=>{
  it('round trips original exact text and sender without time/provider AI controls',()=>{
    const form={...defaultFormState('claude'),...taskChangePatch(defaultFormState('claude'),'message_forward'),title:'Forward',
      targets:[{accountId:'admin',chatType:'group' as const,chatId:'source',title:'Source'}],
      deliveryTarget:{accountId:'agent',chatType:'group' as const,chatId:'dest',title:'Destination'},
      forwardMode:'exact' as const,forwardText:' Original text ',senderAccount:'admin',senderMid:'u1',senderLabel:'Alice'};
    const result=buildScheduleInput(form);
    expect(result.input).toBeDefined();
    const input=AgentScheduleCreateInputSchema.parse(result.input);
    expect(input).toMatchObject({recurrence:{kind:'message'},task:{type:'message_forward',match:{mode:'exact',text:' Original text '},sender:{accountId:'admin',mid:'u1'}},jitterMinutes:0,prompt:''});
    expect(formUsesLlm(form)).toBe(false);
    const saved={...input,scheduleId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',execution:'program',mayUseLlm:false,nextFireAt:null,lastFireAt:null,lastOutcome:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()} as AgentSchedule;
    expect(buildScheduleInput(formStateFromSchedule(saved)).input).toEqual(input);
  });
  const admin={accountId:'agent',chatType:'direct' as const,chatId:'admin',title:'管理員'};
  const forwardForm=(patch:Partial<ReturnType<typeof defaultFormState>>={})=>({...defaultFormState('claude'),...taskChangePatch(defaultFormState('claude'),'message_forward'),title:'Mention',
    deliveryTarget:{accountId:'agent',chatType:'group' as const,chatId:'dest',title:'Destination'},...patch});
  const saved=(input:unknown)=>({...AgentScheduleCreateInputSchema.parse(input),scheduleId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',execution:'program',mayUseLlm:false,nextFireAt:null,lastFireAt:null,lastOutcome:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()} as AgentSchedule);
  it('maps a mention rule with all three actions to the task and back',()=>{
    const form=forwardForm({forwardMode:'mention',mentionAdmin:true,mentionAll:true,mentionMembers:[{accountId:'admin',mid:'u1',label:'小明'}],
      actForward:true,actNotify:true,actAgent:true,agentPrompt:' 請整理 ',agentTarget:{...admin,role:'primary_admin'} as never,provider:'codex'});
    const result=buildScheduleInput(form);
    expect(result.errors).toBeUndefined();
    const input=AgentScheduleCreateInputSchema.parse(result.input);
    expect(input).toMatchObject({provider:'codex',targets:[],prompt:'',delivery:{mode:'line_target',target:{chatId:'dest'}},
      task:{type:'message_forward',match:{mode:'mention',admin:true,all:true,members:[{accountId:'admin',mid:'u1',label:'小明'}]},
        actions:{forward:true,notify:true,agent:{prompt:'請整理',target:admin}}}});
    expect(buildScheduleInput(formStateFromSchedule(saved(input))).input).toEqual(input);
  });
  it('sends record_only delivery when forwarding is off',()=>{
    const form=forwardForm({forwardMode:'mention',mentionAll:true,actForward:false,actNotify:true,deliveryTarget:null});
    const input=AgentScheduleCreateInputSchema.parse(buildScheduleInput(form).input);
    expect(input.delivery).toEqual({mode:'record_only'});
    expect(input.task).toMatchObject({actions:{forward:false,notify:true,agent:null}});
    const back=formStateFromSchedule(saved(input));
    expect(back).toMatchObject({actForward:false,actNotify:true,actAgent:false,deliveryMode:'record_only'});
    expect(buildScheduleInput(back).input).toEqual(input);
  });
  it('accepts no source chats and saves no actions for an old forward-only rule',()=>{
    const form=forwardForm({forwardMode:'contains',forwardText:'urgent',targets:[]});
    const input=AgentScheduleCreateInputSchema.parse(buildScheduleInput(form).input);
    expect(input.targets).toEqual([]);
    expect((input.task as {actions?:unknown}).actions).toBeUndefined();
    const old=formStateFromSchedule(saved(input));
    expect(old).toMatchObject({actForward:true,actNotify:false,actAgent:false,agentTarget:null,agentPrompt:''});
  });
  it('stores actions of a non-mention rule only when they differ from forward-only',()=>{
    const input=AgentScheduleCreateInputSchema.parse(buildScheduleInput(forwardForm({forwardMode:'contains',forwardText:'x',actNotify:true})).input);
    expect(input.task).toMatchObject({actions:{forward:true,notify:true,agent:null}});
  });
  it('reports a missing mention target, a missing action and a missing Agent output chat',()=>{
    expect(buildScheduleInput(forwardForm({forwardMode:'mention'})).errors?.mention).toEqual({key:'mentionNone'});
    expect(buildScheduleInput(forwardForm({forwardMode:'contains',forwardText:'x',actForward:false})).errors?.actions).toEqual({key:'errActionNone'});
    expect(buildScheduleInput(forwardForm({forwardMode:'contains',forwardText:'x',actAgent:true})).errors?.agentTarget).toEqual({key:'errDeliveryTarget'});
    expect(buildScheduleInput(forwardForm({forwardMode:'contains',forwardText:'x',actAgent:true,agentTarget:admin,agentPrompt:'x'.repeat(4001)})).errors?.agentPrompt).toEqual({key:'errPromptTooLong'});
    expect(buildScheduleInput(forwardForm({forwardMode:'contains',forwardText:'x',deliveryTarget:null})).errors?.delivery).toBeDefined();
  });
});
