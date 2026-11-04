import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { SENDER_NAME_SQL, PEER_CONTACT_JOIN, SENDER_CONTACT_JOIN } from './name-resolution.js';
import { matchesScheduleForward, redactSensitiveString, type AgentScheduleForwardTask, type AgentScheduleSendTarget } from '@line-agent/contracts';

type Queryable = Pick<PoolClient, 'query'>;
export interface ForwardSource { accountId: string; chatType: string; chatId: string; messageId: string; attachmentOrder?:readonly string[] }
export interface ForwardPart extends ForwardSource {
  workId: string; runId: string; partIndex: number; kind: 'text' | 'image' | 'file' | 'unsupported'; text: string | null;
  attachmentId: string | null; filename: string | null; state: string; target: AgentScheduleSendTarget;
}

/** Snapshot only authority, never credentials or native message payloads. */
async function authority(client: Queryable, accountId: string): Promise<Record<string, unknown> | null> {
  const result = await client.query<{ snapshot: Record<string, unknown> }>(`SELECT jsonb_build_object(
    'account',a.account_id,'role',a.product_role,'modeRevision',a.mode_revision,'ownMid',a.own_mid,
    'source',s.source_id,'generation',s.generation,'binding',s.admin_binding_mid,'bindingVersion',s.admin_binding_version,
    'control',ctl.control_epoch,'admin',admin.user_id,'adminVersion',av.version) snapshot
    FROM line_accounts a JOIN line_account_sources s ON s.account_id=a.account_id AND s.source_id=a.selected_source_id
      AND s.generation=a.selected_source_generation JOIN account_control ctl ON ctl.singleton=true
    LEFT JOIN line_accounts agent ON agent.product_role='AGENT'
    LEFT JOIN account_administrators admin ON admin.account_id=agent.account_id AND admin.role='PRIMARY_ADMIN'
    LEFT JOIN account_administrator_versions av ON av.account_id=agent.account_id
    WHERE a.account_id=$1 AND a.mode<>'PAUSED' AND a.product_role IN ('AGENT','PRIMARY_ADMIN')
      AND a.source_transition_state='STABLE' AND s.state='ACTIVE' AND a.own_mid=s.verified_account_mid
      AND (a.connection_mode='SYSTEM_LOGIN' OR (a.connection_mode='EXTERNAL_MONITOR' AND s.read_capability
        AND s.admin_binding_mid=admin.user_id AND s.admin_binding_version::bigint=av.version
        AND a.own_mid=s.admin_binding_mid))`, [accountId]);
  return result.rows[0]?.snapshot ?? null;
}

/** Single-line, at most 100 UTF-16 units without splitting a surrogate pair, redacted. */
function cleanSenderName(value:string|null|undefined):string {
  let name=(value??'').replace(/[\r\n\t]+/g,' ').trim();
  if(name.length>100) name=name.slice(0,/[\uD800-\uDBFF]/.test(name[99]!)?99:100);
  return redactSensitiveString(name).trim();
}
/** Chat-view name on the source account, else the rule label, else the sender id. */
function forwardSenderName(resolved:string|null,label:string|undefined,senderId:string):string {
  return [resolved,label,senderId].map(cleanSenderName).find((name)=>name.length>0) ?? '';
}

/** Called only inside a fresh, authorized ingress transaction after original attachment projection. */
export async function captureScheduleForward(client: Queryable, source: ForwardSource, originalText?:string|null): Promise<number> {
  if(!(await client.query("SELECT 1 FROM agent_schedules WHERE enabled AND task->>'type'='message_forward' LIMIT 1")).rowCount) return 0;
  const message = (await client.query<{ text: string; sender: string; own_mid: string; agent_mid: string;
    kind: string; occurred_at: Date; title: string; name: string | null }>(`SELECT COALESCE(m.text_content,'') text,m.sender_id sender,
      la.own_mid,(SELECT own_mid FROM line_accounts WHERE product_role='AGENT') agent_mid,m.kind,m.occurred_at,
      COALESCE(c.title,'') title,${SENDER_NAME_SQL} name FROM messages m
      JOIN line_accounts la ON la.account_id=m.account_id JOIN conversations c ON c.account_id=m.account_id AND c.chat_type=m.chat_type AND c.chat_id=m.chat_id
      LEFT JOIN conversation_members cm ON cm.account_id=m.account_id AND cm.chat_type=m.chat_type AND cm.chat_id=m.chat_id AND cm.member_id=m.sender_id
      ${SENDER_CONTACT_JOIN}
      ${PEER_CONTACT_JOIN}
      WHERE m.account_id=$1 AND m.chat_type=$2 AND m.chat_id=$3 AND m.message_id=$4
        AND COALESCE(m.content->>'type','')<>'unsent' AND NOT(m.raw ? 'sourceDeleted')`,
  [source.accountId,source.chatType,source.chatId,source.messageId])).rows[0];
  if (!message || !message.sender || message.sender===message.agent_mid) return 0;
  if(originalText!==undefined) message.text=originalText??'';
  const snapshot = await authority(client,source.accountId);
  if (!snapshot) return 0;
  const logicalChat = source.chatType==='direct' ? [message.own_mid,source.chatId].sort().join(':') : `${source.chatType}:${source.chatId}`;
  const logicalMessage = JSON.stringify([logicalChat,source.messageId]);
  const candidates=[{accountId:source.accountId,chatType:source.chatType,chatId:source.chatId}];
  const agent=(await client.query<{account_id:string}>("SELECT account_id FROM line_accounts WHERE product_role='AGENT' AND mode<>'PAUSED'")).rows[0];
  if(agent && agent.account_id!==source.accountId) {
    const direct=source.chatType==='direct' && source.chatId===message.agent_mid;
    const group=['group','room'].includes(source.chatType) && (await client.query(`SELECT 1 FROM conversation_members
      WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND member_id=$4`,[agent.account_id,source.chatType,source.chatId,message.agent_mid])).rowCount===1;
    if(direct || group) candidates.push({accountId:agent.account_id,chatType:source.chatType,chatId:direct?message.own_mid:source.chatId});
  }
  const rules = await client.query<{ schedule_id: string; rule_revision: string; targets:Array<{accountId:string;chatType:string;chatId:string;title?:string}>; task: AgentScheduleForwardTask; delivery: { target: AgentScheduleSendTarget } }>(
    `SELECT schedule_id,rule_revision,targets,task,delivery FROM agent_schedules WHERE enabled AND task->>'type'='message_forward'
      AND receipt_baseline_at<=$1 ORDER BY schedule_id LIMIT 50 FOR UPDATE`, [message.occurred_at]);
  let captured=0;
  for (const rule of rules.rows) {
    const selected=rule.targets.find((target)=>candidates.some((candidate)=>candidate.accountId===target.accountId && candidate.chatType===target.chatType && candidate.chatId===target.chatId)
      && (target.accountId!==source.accountId || message.sender!==message.own_mid)
      && matchesScheduleForward(rule.task,{accountId:target.accountId,senderId:message.sender,text:message.text}));
    if(!selected) continue;
    const target=rule.delivery.target;
    if (target.chatType===source.chatType && ((source.chatType!=='direct' && target.chatId===source.chatId) || (source.chatType==='direct'
      && [message.own_mid,source.chatId].includes(message.agent_mid) && [message.own_mid,source.chatId].includes(target.chatId)))) continue;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,72))',[`${rule.schedule_id}:${logicalMessage}`]);
    if ((await client.query('SELECT 1 FROM agent_schedule_forward_work WHERE schedule_id=$1 AND revision=$2 AND logical_message=$3',
      [rule.schedule_id,rule.rule_revision,logicalMessage])).rowCount) continue;
    const senderName=forwardSenderName(message.name,rule.task.sender?.label,message.sender);
    const runId=randomUUID(), workId=randomUUID();
    await client.query(`INSERT INTO agent_schedule_runs(run_id,schedule_id,scheduled_for,outcome) VALUES($1,$2,clock_timestamp(),'submitting')`,[runId,rule.schedule_id]);
    await client.query(`INSERT INTO agent_schedule_forward_work(work_id,schedule_id,revision,logical_message,account_id,chat_type,chat_id,message_id,sender_id,sender_name,source_title,authority,run_id,selected_source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb)`,
    [workId,rule.schedule_id,rule.rule_revision,logicalMessage,source.accountId,source.chatType,source.chatId,source.messageId,message.sender,senderName,redactSensitiveString(selected.title||message.title),JSON.stringify(snapshot),runId,
      JSON.stringify({...selected,ownMid:selected.accountId===source.accountId?message.own_mid:message.agent_mid})]);
    const attachments=await client.query<{ attachment_id:string;kind:string;name:string|null }>(`SELECT attachment_id,kind,name FROM attachments
      WHERE account_id=$1 AND chat_type=$2 AND chat_id=$3 AND message_id=$4 ORDER BY array_position($5::text[],external_attachment_id),created_at,attachment_id LIMIT 20`,[source.accountId,source.chatType,source.chatId,source.messageId,source.attachmentOrder??[]]);
    // The sender name leads the first text part; a text-less media message gets a name-only part before its attachments.
    const forwardText=message.text.length>0 ? `${senderName}: ${message.text}` : attachments.rowCount ? `${senderName}:` : '';
    let index=0;
    // One persisted part is one physical text send; concatenating these chunks preserves every original code unit.
    for (let start=0;start<forwardText.length;) {
      let end=Math.min(start+4900,forwardText.length);
      if(end<forwardText.length && /[\uD800-\uDBFF]/.test(forwardText[end-1]!)) end--;
      await client.query(`INSERT INTO agent_schedule_forward_parts(work_id,part_index,kind,text,state) VALUES($1,$2,'text',$3,'pending')`,[workId,index++,forwardText.slice(start,end)]);
      start=end;
      if(index>=80) break;
    }
    for(const attachment of attachments.rows) await client.query(`INSERT INTO agent_schedule_forward_parts(work_id,part_index,kind,attachment_id,filename,state)
      VALUES($1,$2,$3,$4,$5,'waiting')`,[workId,index++,attachment.kind==='image'?'image':'file',attachment.attachment_id,attachment.name]);
    if(index===0 || (!attachments.rowCount && message.kind!=='text')) await client.query(`INSERT INTO agent_schedule_forward_parts(work_id,part_index,kind,state,error_code)
      VALUES($1,$2,'unsupported','failed','unsupported_content')`,[workId,index++]);
    await client.query(`UPDATE agent_schedules SET last_fire_at=(SELECT scheduled_for FROM agent_schedule_runs WHERE run_id=$2),last_outcome='submitting' WHERE schedule_id=$1`,[rule.schedule_id,runId]);
    captured++;
  }
  return captured;
}

export class ScheduleForwardRepository {
  constructor(private readonly pool:Pool) {}
  async recover():Promise<void> {
    await this.pool.query(`UPDATE agent_schedule_forward_parts SET state='unknown',error_code='send_unknown' WHERE state='sending'`);
    await this.settle();
  }
  async pending():Promise<ForwardPart[]> {
    const result=await this.pool.query(`SELECT w.work_id AS "workId",w.run_id AS "runId",w.account_id AS "accountId",w.chat_type AS "chatType",
      w.chat_id AS "chatId",w.message_id AS "messageId",p.part_index AS "partIndex",p.kind,p.text,p.attachment_id AS "attachmentId",
      p.filename,p.state,s.delivery->'target' AS target FROM agent_schedule_forward_work w
      JOIN agent_schedules s USING(schedule_id) JOIN agent_schedule_forward_parts p USING(work_id)
      WHERE p.state IN ('pending','waiting') AND (p.kind='text' OR NOT EXISTS(SELECT 1 FROM attachments a WHERE a.attachment_id=p.attachment_id AND a.status NOT IN ('ready','failed','expired','unavailable'))) AND NOT EXISTS(SELECT 1 FROM agent_schedule_forward_parts prior
        WHERE prior.work_id=p.work_id AND prior.part_index<p.part_index AND prior.state<>'sent')
      ORDER BY w.created_at,p.part_index LIMIT 32`);
    return result.rows as ForwardPart[];
  }
  async valid(part:ForwardPart):Promise<boolean> {
    const current=await authority(this.pool,part.accountId);
    if(!current) return false;
    return (await this.pool.query(`SELECT 1 FROM agent_schedule_forward_work w JOIN agent_schedules s USING(schedule_id)
      JOIN messages m ON m.account_id=w.account_id AND m.chat_type=w.chat_type AND m.chat_id=w.chat_id AND m.message_id=w.message_id
      WHERE w.work_id=$1 AND s.enabled AND s.rule_revision=w.revision AND w.authority=$2::jsonb
        AND EXISTS(SELECT 1 FROM line_accounts selected WHERE selected.account_id=w.selected_source->>'accountId'
          AND selected.mode<>'PAUSED' AND selected.product_role IN ('AGENT','PRIMARY_ADMIN') AND selected.own_mid=w.selected_source->>'ownMid'
          AND (selected.account_id=w.account_id OR (selected.product_role='AGENT' AND (
            (w.chat_type='direct' AND w.chat_id=selected.own_mid AND w.selected_source->>'chatId'=w.authority->>'ownMid')
            OR (w.chat_type IN ('group','room') AND EXISTS(SELECT 1 FROM conversation_members cm WHERE cm.account_id=selected.account_id
              AND cm.chat_type=w.chat_type AND cm.chat_id=w.chat_id AND cm.member_id=selected.own_mid))))))
        AND s.task->>'type'='message_forward' AND NOT(m.raw ? 'sourceDeleted') AND COALESCE(m.content->>'type','')<>'unsent'
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.targets) t LEFT JOIN line_accounts a ON a.account_id=t->>'accountId'
          WHERE a.account_id IS NULL OR a.mode='PAUSED' OR a.product_role NOT IN ('AGENT','PRIMARY_ADMIN'))
        AND (s.external_account_scope IS NULL OR NOT EXISTS(SELECT 1 FROM unnest(s.external_account_scope) scope
          LEFT JOIN line_accounts a ON a.account_id=scope WHERE a.account_id IS NULL OR a.mode='PAUSED' OR a.product_role NOT IN ('AGENT','PRIMARY_ADMIN')))`,
    [part.workId,JSON.stringify(current)])).rowCount===1;
  }
  async mark(part:ForwardPart,state:string,errorCode:string|null=null,completingSend=false):Promise<boolean> {
    return (await this.pool.query(`UPDATE agent_schedule_forward_parts SET state=$3,error_code=$4 WHERE work_id=$1 AND part_index=$2
      AND (($5 AND state='sending') OR (NOT $5 AND state IN ('pending','waiting')))`,[part.workId,part.partIndex,state,errorCode,completingSend])).rowCount===1;
  }
  async settle():Promise<void> {
    await this.pool.query(`UPDATE agent_schedule_forward_parts p SET state='cancelled',error_code='forwarding_cancelled'
      FROM agent_schedule_forward_work w JOIN agent_schedules s USING(schedule_id) WHERE p.work_id=w.work_id
      AND p.state IN ('pending','waiting') AND (NOT s.enabled OR s.rule_revision<>w.revision OR EXISTS(
        SELECT 1 FROM agent_schedule_forward_parts x WHERE x.work_id=w.work_id AND x.state IN ('failed','unknown','cancelled')))`);
    await this.pool.query(`UPDATE agent_schedule_runs r SET outcome=CASE
      WHEN EXISTS(SELECT 1 FROM agent_schedule_forward_parts p WHERE p.work_id=w.work_id AND p.state='unknown') THEN 'send_unknown'
      WHEN EXISTS(SELECT 1 FROM agent_schedule_forward_parts p WHERE p.work_id=w.work_id AND p.state IN ('failed','cancelled')) THEN 'send_failed'
      ELSE 'sent' END FROM agent_schedule_forward_work w WHERE r.run_id=w.run_id AND r.outcome='submitting'
      AND NOT EXISTS(SELECT 1 FROM agent_schedule_forward_parts p WHERE p.work_id=w.work_id AND p.state IN ('pending','waiting','sending'))`);
    await this.pool.query(`UPDATE agent_schedules s SET last_outcome=r.outcome FROM agent_schedule_runs r
      WHERE r.schedule_id=s.schedule_id AND r.scheduled_for=s.last_fire_at AND s.task->>'type'='message_forward'`);
  }
}
