import { LOCAL_AGENT_ROOM_CHAT_ID, LOCAL_AGENT_ROOM_TITLE, TalkCursorV1Schema, type AccountMode, type WorkerBinding } from '@line-agent/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { normalizeNativePicturePath } from '@line-agent/contracts';
import { transitionAgentJobStatus, type AgentJobStatusProjection } from './agent-repository.js';
import { appendAgentLineage, retireAgentLineage } from './agent-lineage.js';
import { withBoundedTransaction } from './bounded-transaction.js';
import { normalizeManagedMcpScopes } from './managed-mcp-scopes.js';

export interface AccountState {
  accountId: string;
  mode: AccountMode;
  ownMid: string | null;
  productRole: 'AGENT' | 'PRIMARY_ADMIN' | null;
  autoLoginOnStartup?: boolean;
}

export interface ReservedAccountState extends AccountState {
  productRole: 'AGENT' | 'PRIMARY_ADMIN';
}

export interface AccountCapabilities {
  accountId: string;
  productRole: 'AGENT' | 'PRIMARY_ADMIN' | null;
  connectionMode: 'SYSTEM_LOGIN' | 'EXTERNAL_MONITOR' | 'OFFLINE';
  roleRevision: number;
  modeRevision: number;
  selectedSourceId: string | null;
  selectedSourceGeneration: number | null;
  selectedSourceType: 'SYSTEM_LOGIN' | 'EXTERNAL_MONITOR' | null;
  sourceState: 'ACTIVE' | 'FENCED' | 'RETIRED' | null;
  canWriteLine: boolean;
}

export function resolveAccountCapabilities(state: Omit<AccountCapabilities, 'canWriteLine'>): AccountCapabilities {
  const selectedSourceAllowsWrite = state.selectedSourceId === null
    || (state.selectedSourceType === 'SYSTEM_LOGIN' && state.sourceState === 'ACTIVE');
  return { ...state, canWriteLine: state.connectionMode === 'SYSTEM_LOGIN' && selectedSourceAllowsWrite };
}

export interface ControlState {
  controlEpoch: number;
  activeAccountId: string | null;
}

export interface ActivateResult extends ControlState {
  activated: boolean;
}

export interface RevokeResult extends ControlState {
  revoked: boolean;
  revokedAccountId: string | null;
  inFlightJobIds: string[];
  inFlightDeliveryIds: string[];
  cancelledJobs: AgentJobStatusProjection[];
}

async function readControl(client: PoolClient): Promise<ControlState> {
  const state = await client.query<{ control_epoch: string }>('SELECT control_epoch FROM account_control WHERE singleton = true FOR UPDATE');
  const active = await client.query<{ account_id: string }>("SELECT account_id FROM line_accounts WHERE mode = 'ACTIVE_CONTROL' FOR UPDATE");
  return { controlEpoch: Number(state.rows[0]?.control_epoch ?? 0), activeAccountId: active.rows[0]?.account_id ?? null };
}

export class AccountRepository {
  constructor(private readonly pool: Pool) {}

  /** A pairing proof establishes the same role holder used by login and External Monitor. */
  async bindPrimaryAdministrator(accountId: string, chatId: string, userId: string): Promise<boolean> {
    if (chatId !== userId || !/^u[0-9a-f]{32}$/.test(userId)) return false;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT singleton FROM account_control WHERE singleton=true FOR UPDATE');
      await client.query("SELECT account_id FROM line_accounts WHERE product_role='PRIMARY_ADMIN' FOR UPDATE");
      const agent = (await client.query<{ own_mid: string | null }>(
        "SELECT own_mid FROM line_accounts WHERE account_id=$1 AND product_role='AGENT' FOR UPDATE", [accountId])).rows[0];
      if (!agent?.own_mid || agent.own_mid === userId) { await client.query('ROLLBACK'); return false; }
      const existing = (await client.query<{ chat_id: string; user_id: string }>(
        "SELECT chat_id,user_id FROM account_administrators WHERE account_id=$1 AND role='PRIMARY_ADMIN' FOR UPDATE", [accountId])).rows[0];
      if (existing && (existing.chat_id !== chatId || existing.user_id !== userId)) {
        await client.query('ROLLBACK'); return false;
      }
      await this.ensurePrimaryAdminHolder(client, userId);
      if (!existing) await client.query(
        `INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
         VALUES($1,'direct',$2,$3,'PRIMARY_ADMIN')`, [accountId, chatId, userId]);
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  /** Caller holds account_control and the existing Primary Admin row before the Agent row. */
  private async ensurePrimaryAdminHolder(client: PoolClient, mid: string): Promise<void> {
    if (!/^u[0-9a-f]{32}$/.test(mid)) throw new Error('PRIMARY_ADMIN_IDENTITY_INVALID');
    const holder = (await client.query<{ account_id: string; own_mid: string | null }>(
      "SELECT account_id,own_mid FROM line_accounts WHERE product_role='PRIMARY_ADMIN' FOR UPDATE")).rows[0];
    if (holder?.own_mid && holder.own_mid !== mid) throw new Error('PRIMARY_ADMIN_IDENTITY_CONFLICT');
    if (holder) {
      if (!holder.own_mid) await client.query('UPDATE line_accounts SET own_mid=$2,updated_at=now() WHERE account_id=$1', [holder.account_id, mid]);
      return;
    }
    const accountId = `account-${randomUUID()}`;
    await client.query(
      `INSERT INTO line_accounts(account_id,display_name,product_role,own_mid,connection_mode)
       VALUES($1,'Primary Admin','PRIMARY_ADMIN',$2,'OFFLINE')`, [accountId, mid]);
    await client.query(
      `INSERT INTO conversations(account_id,chat_type,chat_id,title,agent_enabled)
       VALUES($1,'direct',$2,$3,true)`, [accountId, LOCAL_AGENT_ROOM_CHAT_ID, LOCAL_AGENT_ROOM_TITLE]);
  }

  async replaceAgentAccount(accountId: string, expectedControlEpoch: number): Promise<
    { ok: true; account: ReservedAccountState; controlEpoch: number } |
    { ok: false; code: 'AGENT_REPLACEMENT_STALE' | 'AGENT_WORKER_ACTIVE' | 'AGENT_CONTROL_ACTIVE' }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Preserve managed role selection before retiring the old holder or moving its administrator binding.
      await normalizeManagedMcpScopes(client);
      const state = await readControl(client);
      if (state.controlEpoch !== expectedControlEpoch || state.activeAccountId !== null) {
        await client.query('ROLLBACK');
        return { ok: false, code: state.activeAccountId ? 'AGENT_CONTROL_ACTIVE' : 'AGENT_REPLACEMENT_STALE' };
      }
      await client.query("SELECT account_id FROM line_accounts WHERE product_role='PRIMARY_ADMIN' FOR UPDATE");
      await client.query(`SELECT source_id FROM line_account_sources
        WHERE source_type='EXTERNAL_MONITOR' AND state='ACTIVE' AND admin_binding_account_id=$1 FOR UPDATE`, [accountId]);
      const verifiedAdmin = await client.query<{ chat_type: 'direct'; chat_id: string; user_id: string }>(
        `SELECT admin_auth.chat_type,admin_auth.chat_id,admin_auth.user_id
         FROM account_administrators admin_auth
         WHERE admin_auth.account_id=$1 AND admin_auth.role='PRIMARY_ADMIN'
           AND admin_auth.chat_type='direct' AND admin_auth.chat_id=admin_auth.user_id
         FOR UPDATE OF admin_auth`, [accountId]);
      const agent = await client.query<{ account_id: string; mode: AccountMode; own_mid: string | null; status: string;
        worker_instance_id: string | null; worker_binding_epoch: string | null }>(
        `SELECT account_id,mode,own_mid,status,worker_instance_id,worker_binding_epoch FROM line_accounts
         WHERE product_role='AGENT' FOR UPDATE`);
      const old = agent.rows[0];
      if (!old || old.account_id !== accountId || !old.own_mid) {
        await client.query('ROLLBACK');
        return { ok: false, code: 'AGENT_REPLACEMENT_STALE' };
      }
      if (old.worker_instance_id !== null || old.worker_binding_epoch !== null || old.status !== 'disconnected') {
        await client.query('ROLLBACK');
        return { ok: false, code: 'AGENT_WORKER_ACTIVE' };
      }
      const adminBinding = verifiedAdmin.rows[0];
      if (adminBinding) {
        if (adminBinding.user_id === old.own_mid) throw new Error('PRIMARY_ADMIN_IDENTITY_CONFLICT');
        // Pairing-only installations predating the unified role holder are repaired in this transaction.
        await this.ensurePrimaryAdminHolder(client, adminBinding.user_id);
      }
      await client.query<{ job_id: string }>(
        `SELECT job_id FROM agent_jobs WHERE account_id=$1 AND source_type='line' AND creation_epoch=$2
         AND status IN ('queued','running') FOR UPDATE`, [accountId, expectedControlEpoch]);
      await client.query<{ delivery_id: string }>(
        `SELECT d.delivery_id FROM agent_deliveries d JOIN agent_jobs j USING(job_id)
         WHERE j.account_id=$1 AND j.source_type='line' AND j.creation_epoch=$2 AND d.status='sending' FOR UPDATE`,
        [accountId, expectedControlEpoch]);
      await transitionAgentJobStatus(client, 'cancelled',
        "account_id=$1 AND source_type='line' AND creation_epoch=$2 AND status IN ('queued','running')",
        [accountId, expectedControlEpoch]);
      await client.query(
        `UPDATE agent_deliveries d SET status=CASE WHEN d.status='sending' THEN 'unknown' ELSE 'cancelled' END,updated_at=now()
         FROM agent_jobs j WHERE j.job_id=d.job_id AND j.account_id=$1 AND j.source_type='line' AND j.creation_epoch=$2
           AND d.status IN ('pending','sending')`, [accountId, expectedControlEpoch]);
      await client.query(
        `UPDATE line_accounts SET product_role=NULL,mode='MONITOR_ONLY',role_revision=role_revision+1,status='disconnected',
           worker_instance_id=NULL,worker_binding_epoch=NULL,auto_login_on_startup=false,connection_mode='OFFLINE',
           selected_source_id=NULL,selected_source_generation=NULL,updated_at=now() WHERE account_id=$1`, [accountId]);
      await retireAgentLineage(client, accountId);
      await client.query(
        `UPDATE line_account_sources SET state='RETIRED',retired_at=now()
         WHERE account_id=$1 AND state<>'RETIRED'`, [accountId]);
      const epoch = await client.query<{ control_epoch: string }>(
        'UPDATE account_control SET control_epoch=control_epoch+1,updated_at=now() WHERE singleton=true RETURNING control_epoch');
      const nextId = `account-${randomUUID()}`;
      const inserted = await client.query<{ account_id: string; mode: AccountMode; own_mid: string | null }>(
        `INSERT INTO line_accounts(account_id,display_name,product_role) VALUES($1,'LINE Agent','AGENT')
         RETURNING account_id,mode,own_mid`, [nextId]);
      await appendAgentLineage(client, nextId);
      // The Agent role, and every schedule scope that authorized its former holder, move together atomically.
      await client.query(`UPDATE agent_schedules SET external_account_scope = ARRAY(
          SELECT DISTINCT scoped_id FROM unnest(array_replace(external_account_scope, $1::text, $2::text)) AS scoped_id ORDER BY scoped_id)
        WHERE external_account_scope @> ARRAY[$1::text]`, [accountId, nextId]);
      await client.query(`UPDATE agent_jobs SET mcp_account_scope = ARRAY(
          SELECT DISTINCT scoped_id FROM unnest(array_replace(mcp_account_scope, $1::text, $2::text)) AS scoped_id ORDER BY scoped_id)
        WHERE mcp_account_scope @> ARRAY[$1::text]`, [accountId, nextId]);
      await client.query(
        `INSERT INTO conversations(account_id,chat_type,chat_id,title,agent_enabled)
         VALUES($1,'direct',$2,$3,true) ON CONFLICT(account_id,chat_type,chat_id) DO NOTHING`,
        [nextId, LOCAL_AGENT_ROOM_CHAT_ID, LOCAL_AGENT_ROOM_TITLE]);
      if (adminBinding) {
        await client.query(`DELETE FROM account_administrators WHERE account_id=$1 AND role='PRIMARY_ADMIN'
          AND chat_type=$2 AND chat_id=$3 AND user_id=$4`,
        [accountId, adminBinding.chat_type, adminBinding.chat_id, adminBinding.user_id]);
        await client.query(`INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
          VALUES($1,$2,$3,$4,'PRIMARY_ADMIN')`, [nextId, adminBinding.chat_type, adminBinding.chat_id, adminBinding.user_id]);
        const version = await client.query<{ version: string }>(
          'SELECT version FROM account_administrator_versions WHERE account_id=$1', [nextId]);
        await client.query(`UPDATE line_account_sources SET admin_binding_account_id=$1,admin_binding_version=$2
          WHERE source_type='EXTERNAL_MONITOR' AND state='ACTIVE' AND admin_binding_account_id=$3
            AND admin_binding_mid=$4 AND verified_account_mid=$4`,
        [nextId, version.rows[0]!.version, accountId, adminBinding.user_id]);
      }
      await client.query('COMMIT');
      const row = inserted.rows[0]!;
      return { ok: true, controlEpoch: Number(epoch.rows[0]!.control_epoch),
        account: { accountId: row.account_id, mode: row.mode, ownMid: row.own_mid, productRole: 'AGENT' } };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async reserveAccountSlot(): Promise<ReservedAccountState> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT singleton FROM account_control WHERE singleton = true FOR UPDATE');
      const slots = await client.query<{ account_id: string; mode: AccountMode; own_mid: string | null; product_role: ReservedAccountState['productRole'] }>(
        `SELECT account_id,mode,own_mid,product_role FROM line_accounts
         WHERE product_role IS NOT NULL ORDER BY CASE product_role WHEN 'PRIMARY_ADMIN' THEN 0 ELSE 1 END FOR UPDATE`);
      const agent = slots.rows.find((row) => row.product_role === 'AGENT');
      const admin = slots.rows.find((row) => row.product_role === 'PRIMARY_ADMIN');
      const pending = !agent?.own_mid ? agent : !admin ? undefined : !admin.own_mid ? admin : undefined;
      if (pending) {
        await client.query('COMMIT');
        return { accountId: pending.account_id, mode: pending.mode, ownMid: pending.own_mid, productRole: pending.product_role };
      }
      let role: ReservedAccountState['productRole'];
      if (!agent) {
        // Also reached when only the Primary Admin slot exists (admin set from External Monitor before any Agent).
        if (slots.rowCount === 0) {
          const existing = await client.query('SELECT 1 FROM line_accounts LIMIT 1');
          if (existing.rowCount) throw new Error('Unclassified LINE accounts prevent role slot reservation');
        }
        role = 'AGENT';
      } else if (agent?.own_mid && !admin) {
        const binding = await client.query(
          `SELECT 1 FROM account_administrators WHERE account_id=$1 AND role='PRIMARY_ADMIN'`, [agent.account_id]);
        if (!binding.rowCount) throw new Error('A verified primary admin binding is required before reserving the Admin slot');
        role = 'PRIMARY_ADMIN';
      }
      else throw new Error('Both fixed LINE account slots are occupied');
      const accountId = `account-${randomUUID()}`;
      const inserted = await client.query<{ account_id: string; mode: AccountMode; own_mid: string | null }>(
        `INSERT INTO line_accounts (account_id,display_name,product_role)
         VALUES ($1,$2,$3) RETURNING account_id,mode,own_mid`,
        [accountId, role === 'AGENT' ? 'LINE Agent' : 'Primary Admin', role]);
      if (role === 'AGENT') await appendAgentLineage(client, accountId);
      await client.query(
        `INSERT INTO conversations (account_id,chat_type,chat_id,title,agent_enabled)
         VALUES ($1,'direct',$2,$3,true) ON CONFLICT (account_id,chat_type,chat_id) DO NOTHING`,
        [accountId, LOCAL_AGENT_ROOM_CHAT_ID, LOCAL_AGENT_ROOM_TITLE]);
      await client.query('COMMIT');
      const row = inserted.rows[0]!;
      return { accountId: row.account_id, mode: row.mode, ownMid: row.own_mid, productRole: role };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  /**
   * Binds the Primary Admin from the official LINE identity seen by External Monitor, in one transaction:
   * lock the Agent row, re-check that no PRIMARY_ADMIN exists, bind (chat_id = user_id = mid, as the pairing flow
   * stores a direct chat), create or reuse the single PRIMARY_ADMIN slot (own_mid = mid, EXTERNAL_MONITOR,
   * disconnected) and append an audit row with a masked MID. Same slot invariants as reserveAccountSlot /
   * applyWorkerLogin: one slot, never a different own_mid, never the Agent's own MID.
   */
  async bindPrimaryAdminFromExternalMonitor(input: { mid: string; correlationId: string; displayName?: string | null; picturePath?: string | null }): Promise<
    { ok: true; accountId: string; created: boolean; bindingWritten: boolean } |
    { ok: false; code: 'AGENT_ACCOUNT_REQUIRED' | 'PRIMARY_ADMIN_ALREADY_BOUND' | 'ADMIN_SLOT_CONFLICT' }> {
    if (!/^u[0-9a-f]{32}$/.test(input.mid)) throw new Error('Invalid official LINE account identity');
    const suppliedName = input.displayName?.trim() ?? '';
    const displayName = suppliedName.length > 0 && suppliedName.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(suppliedName)
      ? suppliedName : null;
    const picturePath = normalizeNativePicturePath(input.picturePath);
    const masked = `${input.mid.slice(0, 5)}…${input.mid.slice(-4)}`;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT singleton FROM account_control WHERE singleton = true FOR UPDATE');
      const slots = await client.query<{ account_id: string; own_mid: string | null; product_role: 'AGENT' | 'PRIMARY_ADMIN';
        connection_mode: string; selected_source_id: string | null }>(
        `SELECT account_id,own_mid,product_role,connection_mode,selected_source_id FROM line_accounts
         WHERE product_role IS NOT NULL ORDER BY CASE product_role WHEN 'PRIMARY_ADMIN' THEN 0 ELSE 1 END FOR UPDATE`);
      const agent = slots.rows.find((row) => row.product_role === 'AGENT');
      const admin = slots.rows.find((row) => row.product_role === 'PRIMARY_ADMIN');
      // With a logged-in Agent the admin is bound on it (chat_id = user_id = MID). Without one, only the Primary Admin
      // slot records the official identity; the Agent login binds it later (bindPendingSlotAdmin).
      let bindingWritten = false;
      if (agent?.own_mid) {
        const existing = await client.query(
          `SELECT 1 FROM account_administrators WHERE account_id=$1 AND role='PRIMARY_ADMIN' FOR UPDATE`, [agent.account_id]);
        if (existing.rowCount) { await client.query('ROLLBACK'); return { ok: false, code: 'PRIMARY_ADMIN_ALREADY_BOUND' }; }
        if (agent.own_mid === input.mid || (admin?.own_mid && admin.own_mid !== input.mid)) {
          await client.query('ROLLBACK'); return { ok: false, code: 'ADMIN_SLOT_CONFLICT' };
        }
        const bound = await client.query(
          `INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
           VALUES($1,'direct',$2,$2,'PRIMARY_ADMIN') ON CONFLICT (account_id,role) DO NOTHING RETURNING account_id`,
          [agent.account_id, input.mid]);
        if (bound.rowCount !== 1) { await client.query('ROLLBACK'); return { ok: false, code: 'PRIMARY_ADMIN_ALREADY_BOUND' }; }
        bindingWritten = true;
      } else if (admin?.own_mid) {
        // A slot with an official identity already exists: the admin is set.
        await client.query('ROLLBACK'); return { ok: false, code: 'PRIMARY_ADMIN_ALREADY_BOUND' };
      }
      let accountId: string;
      let created = false;
      if (admin) {
        accountId = admin.account_id;
        await client.query(
          `UPDATE line_accounts SET own_mid=$2, display_name=COALESCE($3,display_name), picture_path=COALESCE($4,picture_path),
             connection_mode=CASE WHEN selected_source_id IS NULL AND connection_mode<>'EXTERNAL_MONITOR' THEN 'EXTERNAL_MONITOR' ELSE connection_mode END,
             mode_revision=mode_revision+CASE WHEN selected_source_id IS NULL AND connection_mode<>'EXTERNAL_MONITOR' THEN 1 ELSE 0 END,
             updated_at=now()
           WHERE account_id=$1`, [accountId, input.mid, displayName, picturePath]);
      } else {
        accountId = `account-${randomUUID()}`;
        created = true;
        await client.query(
          `INSERT INTO line_accounts (account_id,display_name,product_role,own_mid,connection_mode,status,picture_path)
           VALUES ($1,COALESCE($2,'Primary Admin'),'PRIMARY_ADMIN',$3,'EXTERNAL_MONITOR','disconnected',$4)`, [accountId, displayName, input.mid, picturePath]);
        await client.query(
          `INSERT INTO conversations (account_id,chat_type,chat_id,title,agent_enabled)
           VALUES ($1,'direct',$2,$3,true) ON CONFLICT (account_id,chat_type,chat_id) DO NOTHING`,
          [accountId, LOCAL_AGENT_ROOM_CHAT_ID, LOCAL_AGENT_ROOM_TITLE]);
      }
      await client.query(
        `INSERT INTO audit_logs(action, actor, details, created_at) VALUES ('primary_admin_bound_external_monitor','user',$1::jsonb,now())`,
        [JSON.stringify({ correlation_id: input.correlationId, phase: 'succeeded', account_id: accountId,
          reason_code: 'operator_action', masked_mid: masked })]);
      await client.query('COMMIT');
      return { ok: true, accountId, created, bindingWritten };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  /**
   * Agent login completed: if a Primary Admin slot already holds the official identity (set while no Agent existed)
   * and the Agent has no admin binding, bind it now and adopt the slot's active external source, so the binding is the
   * single authority again. Runs inside the Agent login transaction. Returns false when the Agent's own MID equals the
   * slot's MID (the Agent cannot be its own admin); the caller then rolls the login back.
   */
  private async bindPendingSlotAdmin(client: PoolClient, agentAccountId: string, agentMid: string,
      slot: { account_id: string; own_mid: string | null } | undefined): Promise<boolean> {
    // `slot` was locked by the caller (account_control -> admin row -> Agent row); never lock it again here.
    const slotMid = slot?.own_mid;
    if (!slotMid) return true;
    if (slotMid === agentMid) return false;
    const existing = await client.query(
      `SELECT 1 FROM account_administrators WHERE account_id=$1 AND role='PRIMARY_ADMIN' FOR UPDATE`, [agentAccountId]);
    if (existing.rowCount) return true;
    await client.query(
      `INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
       VALUES($1,'direct',$2,$2,'PRIMARY_ADMIN') ON CONFLICT (account_id,role) DO NOTHING`, [agentAccountId, slotMid]);
    await client.query(
      `UPDATE line_account_sources SET admin_binding_account_id=$1, admin_binding_mid=$2,
         admin_binding_version=(SELECT version FROM account_administrator_versions WHERE account_id=$1)
       WHERE account_id=$3 AND source_type='EXTERNAL_MONITOR' AND state='ACTIVE' AND admin_binding_account_id IS NULL
         AND verified_account_mid=$2`, [agentAccountId, slotMid, slot!.account_id]);
    await client.query(
      `INSERT INTO audit_logs(action, actor, details, created_at) VALUES ('primary_admin_bound_external_monitor','system',$1::jsonb,now())`,
      [JSON.stringify({ correlation_id: `agent-login-${randomUUID()}`, phase: 'succeeded', account_id: slot!.account_id,
        reason_code: 'operator_action', masked_mid: `${slotMid.slice(0, 5)}…${slotMid.slice(-4)}` })]);
    return true;
  }

  async resolveCapabilities(accountId: string): Promise<AccountCapabilities | null> {
    // Bounded end to end (acquisition, BEGIN, read, COMMIT/ROLLBACK); a timeout rejects, which callers treat as not writable.
    const row = await withBoundedTransaction(this.pool, async (client) => (await client.query<{ product_role: 'AGENT' | 'PRIMARY_ADMIN' | null;
      connection_mode: AccountCapabilities['connectionMode']; role_revision: string; mode_revision: string; selected_source_id: string | null;
      selected_source_generation: string | null; source_type: AccountCapabilities['selectedSourceType']; source_state: AccountCapabilities['sourceState'] }>(
      `SELECT a.product_role,a.connection_mode,a.role_revision,a.mode_revision,a.selected_source_id,a.selected_source_generation,
        s.source_type,s.state AS source_state FROM line_accounts a LEFT JOIN line_account_sources s
          ON s.account_id=a.account_id AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
       WHERE a.account_id=$1`, [accountId])).rows[0]);
    return row ? resolveAccountCapabilities({ accountId, productRole: row.product_role, connectionMode: row.connection_mode,
      roleRevision: Number(row.role_revision), modeRevision: Number(row.mode_revision), selectedSourceId: row.selected_source_id,
      selectedSourceGeneration: row.selected_source_generation === null ? null : Number(row.selected_source_generation),
      selectedSourceType: row.source_type, sourceState: row.source_state }) : null;
  }

  async applyWorkerLogin(binding: WorkerBinding, ownMid: string, displayName: string | null, picturePath?: string | null,
    commitCredentials?: () => Promise<void | boolean>, allowOfflineSystemLogin = false): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Global rule: account_control is always locked before any line_accounts row (agent-repository and message-repository
      // statements take `OF c, a`). Roles never change, so an Agent login can take account_control first and serialize with
      // an admin bind started from External Monitor.
      const preRole = await client.query<{ product_role: string | null }>(
        'SELECT product_role FROM line_accounts WHERE account_id=$1', [binding.accountId]);
      // Lock order for an Agent login: account_control -> PRIMARY_ADMIN row -> AGENT row. External-monitor writers lock the
      // admin row before the Agent row (a -> s -> agent), so the login must never take them the other way round.
      let slot: { account_id: string; own_mid: string | null } | undefined;
      if (preRole.rows[0]?.product_role === 'AGENT') {
        await client.query('SELECT singleton FROM account_control WHERE singleton = true FOR UPDATE');
        slot = (await client.query<{ account_id: string; own_mid: string | null }>(
          "SELECT account_id,own_mid FROM line_accounts WHERE product_role='PRIMARY_ADMIN' FOR UPDATE")).rows[0];
        // Writers lock the admin row, then its source, then the Agent row; adopting the source later needs it before the Agent row.
        if (slot?.own_mid) await client.query(
          `SELECT 1 FROM line_account_sources WHERE account_id=$1 AND source_type='EXTERNAL_MONITOR' AND state='ACTIVE' FOR UPDATE`, [slot.account_id]);
      }
      const role = await client.query<{ product_role: AccountState['productRole'] }>(
        'SELECT product_role FROM line_accounts WHERE account_id=$1 FOR UPDATE', [binding.accountId]);
      if (!role.rowCount || !role.rows[0]!.product_role) { await client.query('ROLLBACK'); return false; }
      if (role.rows[0]!.product_role === 'PRIMARY_ADMIN') {
        const primaryAgent = await client.query<{ account_id: string }>("SELECT account_id FROM line_accounts WHERE product_role='AGENT'");
        if (primaryAgent.rowCount !== 1) { await client.query('ROLLBACK'); return false; }
        await client.query('SELECT version FROM account_administrator_versions WHERE account_id=$1 FOR SHARE', [primaryAgent.rows[0]!.account_id]);
        const linked = await client.query(
          `SELECT 1 FROM account_administrators WHERE account_id=$1 AND role='PRIMARY_ADMIN' AND user_id=$2`,
          [primaryAgent.rows[0]!.account_id, ownMid]);
        if (!linked.rowCount) { await client.query('ROLLBACK'); return false; }
      }
      const result = await client.query(
      `UPDATE line_accounts SET own_mid=$3, status='connected', display_name=COALESCE($4,display_name),
       picture_path=CASE WHEN $6::boolean THEN $7 ELSE picture_path END,
       last_synced_at=now(), updated_at=now()
       WHERE account_id=$1 AND worker_instance_id=$2 AND worker_binding_epoch=$5 AND mode <> 'PAUSED'
         AND (own_mid IS NULL OR own_mid=$3)`,
        [binding.accountId, binding.workerInstanceId, ownMid, displayName, binding.controlEpoch,
        picturePath !== undefined, picturePath ?? null],
      );
      if (result.rowCount !== 1) { await client.query('ROLLBACK'); return false; }
      if (role.rows[0]!.product_role === 'AGENT' && !await this.bindPendingSlotAdmin(client, binding.accountId, ownMid, slot)) {
        await client.query('ROLLBACK'); return false;
      }
      const sourceMode = await client.query<{ connection_mode: string; source_id: string | null;
        generation: string | null; source_type: string | null; source_state: string | null }>(
        `SELECT a.connection_mode,a.selected_source_id AS source_id,a.selected_source_generation AS generation,
          s.source_type,s.state AS source_state FROM line_accounts a LEFT JOIN line_account_sources s
            ON s.account_id=a.account_id AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
         WHERE a.account_id=$1 FOR UPDATE OF a`, [binding.accountId]);
      const selected = sourceMode.rows[0];
      // Only an explicit QR login may activate a pairing-created offline holder; an existing source is never replaced.
      if (allowOfflineSystemLogin && selected?.connection_mode === 'OFFLINE'
        && selected.source_id === null && selected.generation === null) {
        await client.query(`UPDATE line_accounts SET connection_mode='SYSTEM_LOGIN',mode_revision=mode_revision+1
          WHERE account_id=$1 AND connection_mode='OFFLINE' AND selected_source_id IS NULL AND selected_source_generation IS NULL`, [binding.accountId]);
        selected.connection_mode = 'SYSTEM_LOGIN';
      }
      if (!selected || selected.connection_mode !== 'SYSTEM_LOGIN'
        || (selected.source_id !== null && (selected.source_type !== 'SYSTEM_LOGIN' || selected.source_state !== 'ACTIVE'))) {
        await client.query('ROLLBACK'); return false;
      }
      if (selected.source_id === null) {
        const generation = await client.query<{ generation: string }>(
          `SELECT COALESCE(max(generation),0)+1 AS generation FROM line_account_sources
           WHERE account_id=$1 AND source_type='SYSTEM_LOGIN'`, [binding.accountId]);
        const sourceId = randomUUID();
        const identityDigest = createHash('sha256').update(`${binding.accountId}\0${ownMid}`, 'utf8').digest('hex');
        await client.query(`INSERT INTO line_account_sources(source_id,account_id,source_type,generation,identity_digest,
            verified_account_mid,state,read_capability,write_capability)
          VALUES ($1,$2,'SYSTEM_LOGIN',$3,$4,$5,'ACTIVE',true,true)`,
        [sourceId, binding.accountId, generation.rows[0]!.generation, identityDigest, ownMid]);
        const checkpoint = await client.query<{ cursor: unknown }>(
          "SELECT cursor FROM sync_cursors WHERE account_id=$1 AND source='live'", [binding.accountId]);
        const previousCursor = checkpoint.rows[0]?.cursor;
        let cursor = { version: 1 as const, revision: '0', globalRev: '0', individualRev: '0' };
        if (previousCursor) {
          try {
            const parsed = TalkCursorV1Schema.safeParse(typeof previousCursor === 'string' ? JSON.parse(previousCursor) : previousCursor);
            if (parsed.success) cursor = parsed.data;
          } catch { /* legacy per-message cursors are opaque and start a fresh source checkpoint */ }
        }
        await client.query(`INSERT INTO external_source_checkpoints(source_id,account_id,generation,cursor)
          VALUES ($1,$2,$3,$4::jsonb)`, [sourceId, binding.accountId, generation.rows[0]!.generation, JSON.stringify(cursor)]);
        await client.query(`UPDATE line_accounts SET selected_source_id=$2,selected_source_generation=$3
          WHERE account_id=$1 AND connection_mode='SYSTEM_LOGIN' AND selected_source_id IS NULL`,
        [binding.accountId, sourceId, generation.rows[0]!.generation]);
      }
      if (await commitCredentials?.() === false) { await client.query('ROLLBACK'); return false; }
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async applyWorkerConnectionStatus(binding: WorkerBinding, status: 'connected' | 'disconnected' | 'degraded' | 'reauth_required'): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE line_accounts SET status=$3,
       last_synced_at=CASE WHEN $3='connected' THEN now() ELSE last_synced_at END, updated_at=now()
       WHERE account_id=$1 AND worker_instance_id=$2 AND worker_binding_epoch=$4 AND mode <> 'PAUSED'`,
      [binding.accountId, binding.workerInstanceId, status, binding.controlEpoch],
    );
    return result.rowCount === 1;
  }

  async applyWorkerSyncConfirmed(binding: WorkerBinding): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE line_accounts SET last_synced_at=now(), updated_at=now()
       WHERE account_id=$1 AND worker_instance_id=$2 AND worker_binding_epoch=$3 AND mode <> 'PAUSED'`,
      [binding.accountId, binding.workerInstanceId, binding.controlEpoch],
    );
    return result.rowCount === 1;
  }

  async refreshWorkerAvatar(binding: WorkerBinding, ownMid: string, displayName: string | null, picturePath?: string | null): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE line_accounts a SET display_name=COALESCE($4,a.display_name),
         picture_path=CASE WHEN $5::boolean THEN $6 ELSE a.picture_path END, updated_at=now()
       WHERE a.account_id=$1 AND a.worker_instance_id=$2 AND a.worker_binding_epoch=$3
         AND a.own_mid=$7 AND a.status='connected' AND a.mode <> 'PAUSED'
         AND (a.selected_source_id IS NULL OR EXISTS (
           SELECT 1 FROM line_account_sources s WHERE s.account_id=a.account_id
             AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
             AND s.source_type='SYSTEM_LOGIN' AND s.state='ACTIVE'))`,
      [binding.accountId, binding.workerInstanceId, binding.controlEpoch, displayName,
        picturePath !== undefined, picturePath ?? null, ownMid],
    );
    return result.rowCount === 1;
  }

  async canRefreshWorkerAvatar(binding: WorkerBinding, ownMid: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM line_accounts a WHERE a.account_id=$1 AND a.worker_instance_id=$2 AND a.worker_binding_epoch=$3
         AND a.own_mid=$4 AND a.status='connected' AND a.mode <> 'PAUSED'
         AND (a.selected_source_id IS NULL OR EXISTS (
           SELECT 1 FROM line_account_sources s WHERE s.account_id=a.account_id
             AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
             AND s.source_type='SYSTEM_LOGIN' AND s.state='ACTIVE'))`,
      [binding.accountId, binding.workerInstanceId, binding.controlEpoch, ownMid],
    );
    return result.rowCount === 1;
  }

  async invalidateWorkerBinding(binding: WorkerBinding): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE line_accounts SET status='reauth_required', worker_instance_id=NULL, worker_binding_epoch=NULL, updated_at=now()
       WHERE account_id=$1 AND worker_instance_id=$2 AND worker_binding_epoch=$3`,
      [binding.accountId, binding.workerInstanceId, binding.controlEpoch],
    );
    return result.rowCount === 1;
  }

  async getWorkerBinding(accountId: string): Promise<WorkerBinding | null> {
    const result = await this.pool.query<{ worker_instance_id: string | null; worker_binding_epoch: string | null }>(
      'SELECT worker_instance_id,worker_binding_epoch FROM line_accounts WHERE account_id=$1', [accountId]);
    const row = result.rows[0];
    if (!row?.worker_instance_id || row.worker_binding_epoch === null) return null;
    return { accountId, workerInstanceId: row.worker_instance_id, controlEpoch: Number(row.worker_binding_epoch) };
  }

  async clearStoppedWorkerBinding(binding: WorkerBinding): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE line_accounts SET worker_instance_id=NULL,worker_binding_epoch=NULL,updated_at=now()
       WHERE account_id=$1 AND worker_instance_id=$2 AND worker_binding_epoch=$3`,
      [binding.accountId, binding.workerInstanceId, binding.controlEpoch]);
    return result.rowCount === 1;
  }

  async bindWorker(binding: WorkerBinding, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Worker binding cancelled');
    const client = await this.pool.connect();
    try {
      if (signal?.aborted) throw new Error('Worker binding cancelled');
      await client.query('BEGIN');
      const control = await client.query<{ control_epoch: string }>('SELECT control_epoch FROM account_control WHERE singleton = true FOR SHARE');
      if (signal?.aborted) throw new Error('Worker binding cancelled');
      const epoch = Number(control.rows[0]?.control_epoch);
      if (binding.controlEpoch > epoch) throw new Error('Stale worker binding epoch');
      const result = await client.query(
        `UPDATE line_accounts SET worker_instance_id = $2, worker_binding_epoch = $3, updated_at = now()
         WHERE account_id = $1 AND (worker_binding_epoch IS NULL OR worker_binding_epoch <= $3)
           AND (mode <> 'ACTIVE_CONTROL' OR $3 = $4) RETURNING account_id`,
        [binding.accountId, binding.workerInstanceId, binding.controlEpoch, epoch],
      );
      if (signal?.aborted) throw new Error('Worker binding cancelled');
      if (result.rowCount !== 1) throw new Error('Stale worker binding epoch');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async isCurrentActiveWorkerBinding(binding: WorkerBinding): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM line_accounts
       WHERE account_id=$1 AND worker_instance_id=$2 AND worker_binding_epoch=$3 AND mode='ACTIVE_CONTROL'`,
      [binding.accountId, binding.workerInstanceId, binding.controlEpoch],
    );
    return result.rowCount === 1;
  }

  async ensureAccount(accountId: string, displayName: string | null = null): Promise<AccountState> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ account_id: string; mode: AccountMode; own_mid: string | null; product_role: AccountState['productRole'] }>(
        `INSERT INTO line_accounts (account_id, display_name) VALUES ($1, $2)
         ON CONFLICT (account_id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, line_accounts.display_name)
         RETURNING account_id, mode, own_mid, product_role`,
        [accountId, displayName],
      );
      await client.query(
        `INSERT INTO conversations (account_id, chat_type, chat_id, title, agent_enabled)
         VALUES ($1, 'direct', $2, $3, true)
         ON CONFLICT (account_id, chat_type, chat_id) DO UPDATE
         SET title=EXCLUDED.title, agent_enabled=true, updated_at=now()`,
        [accountId, LOCAL_AGENT_ROOM_CHAT_ID, LOCAL_AGENT_ROOM_TITLE],
      );
      await client.query('COMMIT');
      return { accountId: result.rows[0]!.account_id, mode: result.rows[0]!.mode, ownMid: result.rows[0]!.own_mid, productRole: result.rows[0]!.product_role };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async getAccount(accountId: string): Promise<AccountState | null> {
    const result = await this.pool.query<{ account_id: string; mode: AccountMode; own_mid: string | null; product_role: AccountState['productRole'] }>('SELECT account_id, mode, own_mid, product_role FROM line_accounts WHERE account_id = $1', [accountId]);
    const row = result.rows[0];
    return row ? { accountId: row.account_id, mode: row.mode, ownMid: row.own_mid, productRole: row.product_role } : null;
  }

  async listAuthenticatedAccounts(): Promise<AccountState[]> {
    const result = await this.pool.query<{ account_id: string; mode: AccountMode; own_mid: string; product_role: AccountState['productRole']; auto_login_on_startup: boolean }>(
      "SELECT account_id, mode, own_mid, product_role, auto_login_on_startup FROM line_accounts WHERE own_mid IS NOT NULL AND product_role IS NOT NULL AND mode <> 'PAUSED' ORDER BY CASE product_role WHEN 'AGENT' THEN 0 ELSE 1 END,created_at",
    );
    return result.rows.map((row) => ({ accountId: row.account_id, mode: row.mode, ownMid: row.own_mid, productRole: row.product_role,
      autoLoginOnStartup: row.auto_login_on_startup }));
  }

  async setAutoLoginOnStartup(accountId: string, enabled: boolean): Promise<void> {
    const result = await this.pool.query(
      'UPDATE line_accounts SET auto_login_on_startup=$2, updated_at=now() WHERE account_id=$1', [accountId, enabled]);
    if (result.rowCount !== 1) throw new Error('Unknown LINE account');
  }

  async setOwnMid(accountId: string, ownMid: string): Promise<void> {
    const result = await this.pool.query(
      'UPDATE line_accounts SET own_mid = $2, updated_at = now() WHERE account_id = $1', [accountId, ownMid],
    );
    if (result.rowCount !== 1) throw new Error('Unknown LINE account');
  }

  async setConnectionStatus(accountId: string, status: 'connected' | 'disconnected' | 'degraded' | 'reauth_required', displayName?: string | null): Promise<void> {
    const result = await this.pool.query(
      `UPDATE line_accounts SET status=$2, display_name=COALESCE($3,display_name),
       last_synced_at=CASE WHEN $2='connected' THEN now() ELSE last_synced_at END, updated_at=now() WHERE account_id=$1`,
      [accountId, status, displayName ?? null],
    );
    if (result.rowCount !== 1) throw new Error('Unknown LINE account');
  }

  async getControlState(): Promise<ControlState> {
    const result = await this.pool.query<{ control_epoch: string; active_account_id: string | null }>(
      `SELECT c.control_epoch, a.account_id AS active_account_id
       FROM account_control c LEFT JOIN line_accounts a ON a.mode = 'ACTIVE_CONTROL'
       WHERE c.singleton = true`,
    );
    return { controlEpoch: Number(result.rows[0]?.control_epoch ?? 0), activeAccountId: result.rows[0]?.active_account_id ?? null };
  }

  async activateControl(accountId: string, expectedEpoch: number): Promise<ActivateResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const state = await readControl(client);
      if (state.controlEpoch !== expectedEpoch || state.activeAccountId !== null) {
        await client.query('COMMIT');
        return { ...state, activated: false };
      }
      const activated = await client.query(
        `UPDATE line_accounts SET mode = 'ACTIVE_CONTROL', updated_at = now()
       WHERE account_id = $1 AND product_role='AGENT' AND mode <> 'PAUSED' RETURNING account_id`,
        [accountId],
      );
      await client.query('COMMIT');
      return { controlEpoch: state.controlEpoch, activeAccountId: activated.rowCount === 1 ? accountId : null, activated: activated.rowCount === 1 };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeControl(expectedEpoch: number): Promise<RevokeResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const state = await readControl(client);
      if (state.controlEpoch !== expectedEpoch) {
        await client.query('COMMIT');
        return { ...state, revoked: false, revokedAccountId: null, inFlightJobIds: [], inFlightDeliveryIds: [], cancelledJobs: [] };
      }
      const revokedAccountId = state.activeAccountId;
      const inFlightJobs = revokedAccountId === null ? { rows: [] as Array<{ job_id: string; status: AgentJobStatusProjection['status'] }> } : await client.query<{ job_id: string; status: AgentJobStatusProjection['status'] }>(
        `SELECT job_id, status FROM agent_jobs WHERE account_id = $1 AND source_type = 'line'
         AND creation_epoch = $2 AND status IN ('queued', 'running') FOR UPDATE`,
        [revokedAccountId, expectedEpoch],
      );
      const inFlightDeliveries = revokedAccountId === null ? { rows: [] as Array<{ delivery_id: string }> } : await client.query<{ delivery_id: string }>(
        `SELECT d.delivery_id FROM agent_deliveries d JOIN agent_jobs j USING (job_id)
         WHERE j.account_id = $1 AND j.source_type = 'line' AND j.creation_epoch = $2 AND d.status = 'sending' FOR UPDATE`,
        [revokedAccountId, expectedEpoch],
      );
      let cancelledJobs: AgentJobStatusProjection[] = [];
      if (revokedAccountId !== null) {
        await client.query("UPDATE line_accounts SET mode = 'MONITOR_ONLY', updated_at = now() WHERE account_id = $1 AND mode = 'ACTIVE_CONTROL'", [revokedAccountId]);
        cancelledJobs = await transitionAgentJobStatus(client, 'cancelled',
          "account_id = $1 AND source_type = 'line' AND creation_epoch = $2 AND status IN ('queued', 'running')",
          [revokedAccountId, expectedEpoch]);
        await client.query(
          `UPDATE agent_deliveries d SET status = CASE WHEN d.status = 'sending' THEN 'unknown' ELSE 'cancelled' END, updated_at = now()
           FROM agent_jobs j WHERE j.job_id = d.job_id AND j.account_id = $1 AND j.source_type = 'line'
             AND j.creation_epoch = $2 AND d.status IN ('pending', 'sending')`,
          [revokedAccountId, expectedEpoch],
        );
      }
      const next = await client.query<{ control_epoch: string }>(
        'UPDATE account_control SET control_epoch = control_epoch + 1, updated_at = now() WHERE singleton = true RETURNING control_epoch',
      );
      await client.query('COMMIT');
      return {
        revoked: true,
        revokedAccountId,
        controlEpoch: Number(next.rows[0]!.control_epoch),
        activeAccountId: null,
        inFlightJobIds: inFlightJobs.rows.filter((row) => row.status === 'running').map((row) => row.job_id),
        inFlightDeliveryIds: inFlightDeliveries.rows.map((row) => row.delivery_id),
        cancelledJobs,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
