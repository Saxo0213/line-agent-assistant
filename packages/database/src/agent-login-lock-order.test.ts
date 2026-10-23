import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from './test-database.js';
import { AccountRepository } from './account-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const ADMIN_MID = `u${'a'.repeat(32)}`;
const AGENT_MID = `u${'b'.repeat(32)}`;
const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const BINDING = { accountId: 'agent-x', workerInstanceId: 'agent-w', controlEpoch: 0 } as never;

// The exact authority statement every external-monitor writer takes first (a -> s -> agent -> admin -> av).
const WRITER_AUTHORITY = `SELECT a.own_mid FROM line_accounts a JOIN line_account_sources s
  ON s.account_id=a.account_id AND s.source_id=a.selected_source_id AND s.generation=a.selected_source_generation
  JOIN line_accounts agent ON agent.account_id=s.admin_binding_account_id
  JOIN account_administrators admin ON admin.account_id=agent.account_id AND admin.role='PRIMARY_ADMIN'
  JOIN account_administrator_versions av ON av.account_id=agent.account_id
  WHERE a.account_id=$1 AND s.source_id=$2 AND s.generation=$3 FOR UPDATE OF a,s,agent,admin,av`;

database('Agent login lock order against external-monitor writers', () => {
  let pool: Awaited<ReturnType<typeof createTestDatabase>>['pool'];
  let close: () => Promise<void>;

  beforeAll(async () => { ({ pool, close } = await createTestDatabase()); });
  afterAll(async () => close?.());
  beforeEach(async () => {
    await pool.query('TRUNCATE line_accounts CASCADE');
    await pool.query(`INSERT INTO line_accounts(account_id,display_name,product_role,own_mid,worker_instance_id,worker_binding_epoch)
      VALUES ('agent-x','Agent','AGENT',$1,'agent-w',0)`, [AGENT_MID]);
    await pool.query(`INSERT INTO line_accounts(account_id,display_name,product_role,own_mid,connection_mode,status)
      VALUES ('admin-x','Admin','PRIMARY_ADMIN',$1,'EXTERNAL_MONITOR','disconnected')`, [ADMIN_MID]);
    await pool.query(`INSERT INTO account_administrators(account_id,chat_type,chat_id,user_id,role)
      VALUES ('agent-x','direct',$1,$1,'PRIMARY_ADMIN')`, [ADMIN_MID]);
    const version = await pool.query("SELECT version FROM account_administrator_versions WHERE account_id='agent-x'");
    await pool.query(`INSERT INTO line_account_sources(source_id,account_id,source_type,generation,identity_digest,verified_account_mid,
      state,read_capability,write_capability,admin_binding_account_id,admin_binding_mid,admin_binding_version)
      VALUES ($1,'admin-x','EXTERNAL_MONITOR',1,$2,$3,'ACTIVE',true,false,'agent-x',$3,$4)`,
    [SOURCE_ID, 'a'.repeat(64), ADMIN_MID, version.rows[0].version]);
    await pool.query("UPDATE line_accounts SET selected_source_id=$1, selected_source_generation=1 WHERE account_id='admin-x'", [SOURCE_ID]);
  });

  function loginPausedBefore(fragment: string) {
    let reached!: () => void; let resume!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const released = new Promise<void>((resolve) => { resume = resolve; });
    const wrapped = { connect: async () => {
      const client = await pool.connect();
      return { query: async (sql: string, values?: unknown[]) => {
        if (sql.includes(fragment)) { reached(); await released; }
        const result = await client.query(sql, values);
        if (sql === 'BEGIN') await client.query("SET LOCAL statement_timeout='6000ms'");
        return result;
      }, release: () => client.release() };
    } } as unknown as typeof pool;
    return { repository: new AccountRepository(wrapped), waiting, resume };
  }

  async function writer() {
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='6000ms'");
    return client;
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('(a) a writer holding a, s, agent, admin and av while an already-bound Agent logs in: both complete', async () => {
    const write = await writer();
    await write.query(WRITER_AUTHORITY, ['admin-x', SOURCE_ID, 1]);
    const login = new AccountRepository(pool).applyWorkerLogin(BINDING, AGENT_MID, 'Agent');
    await sleep(300);
    await write.query('COMMIT');
    write.release();
    await expect(login).resolves.toBe(true);
  });

  it('(b) a login paused after its first locks while a writer starts: both complete, no 40P01', async () => {
    const gate = loginPausedBefore('UPDATE line_accounts SET own_mid=$3');
    const login = gate.repository.applyWorkerLogin(BINDING, AGENT_MID, 'Agent');
    await gate.waiting; // the login already holds account_control, the PRIMARY_ADMIN row and the AGENT row
    const write = await writer();
    const authority = write.query(WRITER_AUTHORITY, ['admin-x', SOURCE_ID, 1]);
    await sleep(300);
    gate.resume();
    await expect(login).resolves.toBe(true);
    await expect(authority).resolves.toMatchObject({ rowCount: 1 });
    await write.query('COMMIT');
    write.release();
  });

  it('(d) completeJob\'s authority statement (control then agent row) against a login holding only account_control', async () => {
    // The login is gated before it locks the PRIMARY_ADMIN row, so it holds only account_control. completeJob's statement
    // must take account_control first (`FOR SHARE OF c, a`): under the old `OF a, c` order it would lock the Agent row,
    // wait for account_control, while the resumed login waits for that Agent row -> 40P01.
    const gate = loginPausedBefore("SELECT account_id,own_mid FROM line_accounts WHERE product_role='PRIMARY_ADMIN' FOR UPDATE");
    const login = gate.repository.applyWorkerLogin(BINDING, AGENT_MID, 'Agent');
    await gate.waiting;
    const job = await pool.connect();
    await job.query('BEGIN');
    await job.query("SET LOCAL statement_timeout='6000ms'");
    const authority = job.query(
      `SELECT a.mode, c.control_epoch FROM line_accounts a CROSS JOIN account_control c
       WHERE a.account_id = $1 AND c.singleton = true FOR SHARE OF c, a`, ['agent-x']);
    await sleep(300);
    gate.resume();
    await expect(login).resolves.toBe(true);
    await expect(authority).resolves.toMatchObject({ rowCount: 1 });
    await job.query('COMMIT');
    job.release();
  });

  it('(d2) the production completeJob statement keeps the control-first order', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./agent-repository.ts', import.meta.url), 'utf8');
    expect(source).toContain('WHERE a.account_id = $1 AND c.singleton = true FOR SHARE OF c, a');
    expect(source).not.toMatch(/FOR SHARE OF a, c/);
  });

  it('(c) a first-time Agent login that adopts the slot source does not cross a writer', async () => {
    await pool.query("DELETE FROM account_administrators WHERE account_id='agent-x'");
    await pool.query("UPDATE line_account_sources SET admin_binding_account_id=NULL, admin_binding_mid=NULL, admin_binding_version=NULL");
    await pool.query("UPDATE line_accounts SET own_mid=NULL WHERE account_id='agent-x'");
    const gate = loginPausedBefore('UPDATE line_accounts SET own_mid=$3');
    const login = gate.repository.applyWorkerLogin(BINDING, AGENT_MID, 'Agent');
    await gate.waiting;
    const write = await writer();
    // A binding-less source: the writer takes the admin row and its source (a -> s), the order the login already respects.
    const authority = write.query(`SELECT a.own_mid FROM line_accounts a JOIN line_account_sources s
      ON s.account_id=a.account_id AND s.source_id=a.selected_source_id WHERE a.account_id='admin-x' FOR UPDATE OF a,s`);
    await sleep(300);
    gate.resume();
    await expect(login).resolves.toBe(true);
    await authority;
    await write.query('COMMIT');
    write.release();
    const source = await pool.query('SELECT admin_binding_account_id FROM line_account_sources');
    expect(source.rows).toEqual([{ admin_binding_account_id: 'agent-x' }]);
  });
});
