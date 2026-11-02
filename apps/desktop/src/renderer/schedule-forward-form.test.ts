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
});
