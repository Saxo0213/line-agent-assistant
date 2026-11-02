// @vitest-environment jsdom
import React from 'react';
import {act,fireEvent,render,screen,waitFor,cleanup} from '@testing-library/react';
import {afterEach,describe,expect,it} from 'vitest';
import type {DesktopApi} from '../../preload/api.js';
import {ScheduleForwardSender,type ForwardSenderOption} from './ScheduleForwardSender.js';
import {buildScheduleInput,defaultFormState,taskChangePatch} from '../scheduleForm.js';
import {scheduleTextFor} from '../../desktop-schedule-copy.js';
afterEach(cleanup);
describe('friendly forwarding sender selection',()=>{
  it('retains a configured infrequent sender by name and MID while loading and absent from the recent page',async()=>{
    const source={accountId:'admin-internal-id',chatType:'group' as const,chatId:'g1',title:'Project team'};
    let resolvePage!:(page:{messages:unknown[]})=>void;
    const api={listMessages:()=>new Promise((resolve)=>{resolvePage=resolve;})} as unknown as DesktopApi;
    const identity=JSON.stringify(['admin-internal-id','u-infrequent']);
    let selected:ForwardSenderOption|null=null;
    render(<ScheduleForwardSender api={api} targets={[source]} accountId="admin-internal-id" mid="u-infrequent" savedLabel="Infrequent Alice"
      onSelect={(sender)=>{selected=sender;}} text={(key)=>scheduleTextFor('en',key)}/>);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(identity);
    expect(screen.getByRole('option',{name:'Infrequent Alice · Project team'})).toBeDefined();
    await act(async()=>resolvePage({messages:[]}));
    await waitFor(()=>expect(screen.getByText(/Choose source chats first/)).toBeDefined());
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe(identity);
    fireEvent.change(screen.getByRole('combobox'),{target:{value:identity}});
    expect(selected).toMatchObject({accountId:'admin-internal-id',mid:'u-infrequent',label:'Infrequent Alice'});
  });
  it('selects a named observed sender and saves stable source account plus MID',async()=>{
    const source={accountId:'admin-internal-id',chatType:'group' as const,chatId:'g1',title:'Project team'};
    const api={async listMessages(){return {messages:[{direction:'inbound',senderId:'u-alice',senderName:'Alice'},{direction:'outbound',senderId:'u-self',senderName:'Me'}]};}} as unknown as DesktopApi;
    let selected:ForwardSenderOption|null=null;
    render(<ScheduleForwardSender api={api} targets={[source]} accountId="" mid="" onSelect={(sender)=>{selected=sender;}} text={(key)=>scheduleTextFor('en',key)}/>);
    await waitFor(()=>expect(screen.getByRole('option',{name:'Alice · Project team'})).toBeDefined());
    fireEvent.change(screen.getByRole('combobox'),{target:{value:JSON.stringify(['admin-internal-id','u-alice'])}});
    expect(selected).toMatchObject({accountId:'admin-internal-id',mid:'u-alice',label:'Alice'});
    const chosen=selected as unknown as ForwardSenderOption;
    const base=defaultFormState('claude');
    const result=buildScheduleInput({...base,...taskChangePatch(base,'message_forward'),title:'Alice attachments',targets:[source],
      deliveryTarget:{accountId:'agent',chatType:'group',chatId:'dest',title:'Destination'},forwardMode:'sender',senderAccount:chosen.accountId,senderMid:chosen.mid,senderLabel:chosen.label});
    expect(result.input?.task).toEqual({type:'message_forward',match:{mode:'sender'},sender:{accountId:'admin-internal-id',mid:'u-alice',label:'Alice'}});
  });
});
