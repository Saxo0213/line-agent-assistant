import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createTestDatabase } from './test-database.js';
import { RoomActivationRepository } from './room-activation-repository.js';

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const digestKey = randomBytes(32);
const token = `RA-${randomBytes(32).toString('base64url')}`;

database('durable room activation authorization state machine', () => {
  let pool: Awaited<ReturnType<typeof createTestDatabase>>['pool'];
  let close: () => Promise<void>;
  let repository: RoomActivationRepository;
  const suffix = randomUUID();
  beforeAll(async () => {
    ({ pool, close } = await createTestDatabase());
    repository = new RoomActivationRepository(pool);
  });

  afterAll(async () => close?.());

  async function fixture() {
    const id = randomUUID();
    const scope = { accountId: `activation-${id}`, chatType: 'group' as const, chatId: `room-${id}` };
    const adminUserId = `admin-user-${id}`;
    await pool.query('INSERT INTO line_accounts(account_id) VALUES ($1)', [scope.accountId]);
    await pool.query("INSERT INTO conversations(account_id, chat_type, chat_id) VALUES ($1, 'group', $2)", [scope.accountId, scope.chatId]);
    await repository.setPrimaryAdministrator(scope.accountId, `admin-${id}`, adminUserId, null);
    return { scope, adminUserId };
  }

  async function request(scope: { accountId: string; chatType: 'group'; chatId: string }, message = randomUUID()) {
    return repository.requestActivation({ ...scope, sourceMessageId: message, requesterId: `member-${suffix}` });
  }

  async function issue(requestId: string, challengeToken = token) {
    const claim = await repository.claimWaitingToSend(requestId, `owner-${randomUUID()}`, 30_000);
    if (!claim) throw new Error('waiting request was not claimable');
    const accepted = await repository.prepareChallengeSend({
      requestId, leaseToken: claim.leaseToken, token: challengeToken, digestKey, digestKeyVersion: 1,
    });
    if (!accepted) throw new Error('challenge send permit was not created');
    return claim;
  }

  it('coalesces requests without extending the database deadline', async () => {
    const f = await fixture();
    const [first, duplicate] = await Promise.all([request(f.scope), request(f.scope, randomUUID())]);
    expect([first.disposition, duplicate.disposition].sort()).toEqual(['coalesced', 'created']);
    expect(duplicate).toMatchObject({ disposition: 'coalesced', requestId: first.requestId, waitExpiresAt: first.waitExpiresAt });
    expect(first.waitExpiresAt).toBeInstanceOf(Date);
  });

  it('starts every room without an authorization policy and keeps the audit append-only', async () => {
    const f = await fixture();
    expect((await repository.getPolicy(f.scope)).state).toBe('DISABLED');
    const created = await request(f.scope);
    await expect(pool.query('UPDATE room_activation_audit SET actor_id = $2 WHERE request_id = $1', [created.requestId, 'tampered']))
      .rejects.toThrow('room_activation_audit is append-only');
  });

  it('keeps administrator version maintenance compatible with account deletion and preserves audit history', async () => {
    const f = await fixture();
    const created = await request(f.scope);
    await pool.query('DELETE FROM line_accounts WHERE account_id = $1', [f.scope.accountId]);
    expect((await pool.query('SELECT count(*) FROM account_administrator_versions WHERE account_id = $1', [f.scope.accountId])).rows[0].count).toBe('0');
    expect((await pool.query('SELECT count(*) FROM room_activation_audit WHERE request_id = $1', [created.requestId])).rows[0].count).toBe('1');
  });

  it('stores only a keyed digest and consumes once in the exact account and room scope', async () => {
    const f = await fixture();
    const created = await request(f.scope);
    await issue(created.requestId);
    const stored = await pool.query<{ token_digest: Buffer; consumed_at: Date | null }>(
      'SELECT token_digest, consumed_at FROM room_activation_challenges WHERE request_id = $1', [created.requestId],
    );
    expect(stored.rows[0]?.token_digest).toEqual(createHmac('sha256', digestKey).update(token).digest());
    expect(stored.rows[0]?.token_digest.toString()).not.toContain(token);

    const wrongScope = await repository.confirmActivation({
      ...f.scope, chatId: `${f.scope.chatId}-other`, sourceMessageId: randomUUID(), senderUserId: f.adminUserId,
      token, digestKey, digestKeyVersion: 1,
    });
    expect(wrongScope.disposition).toBe('out_of_scope');
    expect((await pool.query('SELECT attempts FROM room_activation_challenges WHERE request_id = $1', [created.requestId])).rows[0].attempts).toBe(0);
    const wrongSender = await repository.confirmActivation({
      ...f.scope, sourceMessageId: randomUUID(), senderUserId: `other-user-${suffix}`, token, digestKey, digestKeyVersion: 1,
    });
    expect(wrongSender.disposition).toBe('out_of_scope');
    expect((await pool.query('SELECT attempts FROM room_activation_challenges WHERE request_id = $1', [created.requestId])).rows[0].attempts).toBe(0);

    const confirmation = { ...f.scope, sourceMessageId: randomUUID(), senderUserId: f.adminUserId, token, digestKey, digestKeyVersion: 1 };
    const results = await Promise.all([
      repository.confirmActivation(confirmation),
      repository.confirmActivation({ ...confirmation, sourceMessageId: randomUUID() }),
    ]);
    expect(results.filter((result) => result.disposition === 'enabled')).toHaveLength(1);
    expect(results.some((result) => result.disposition === 'already_consumed')).toBe(true);
    expect((await pool.query('SELECT consumed_at FROM room_activation_challenges WHERE request_id = $1', [created.requestId])).rows[0].consumed_at).toBeInstanceOf(Date);
  });

  it('admits room Agent requests only while the enabled policy has an active room grant', async () => {
    const f = await fixture();
    expect(await repository.hasActiveRoomGrant(f.scope)).toBe(false);
    const created = await request(f.scope);
    await issue(created.requestId);
    await repository.confirmActivation({ ...f.scope, sourceMessageId: randomUUID(), senderUserId: f.adminUserId,
      token, digestKey, digestKeyVersion: 1 });
    expect(await repository.hasActiveRoomGrant(f.scope)).toBe(true);
    expect(await repository.hasActiveRoomGrant({ ...f.scope, chatId: `${f.scope.chatId}-other` })).toBe(false);
    await repository.revokeRoom(f.scope, 'operator-revoke');
    expect(await repository.hasActiveRoomGrant(f.scope)).toBe(false);
  });

  it('deduplicates wrong attempts and exhausts after five valid-scope failures', async () => {
    const f = await fixture();
    const created = await request(f.scope);
    await issue(created.requestId);
    const duplicateMessage = randomUUID();
    const wrong = { ...f.scope, senderUserId: f.adminUserId, token: `RA-${randomBytes(32).toString('base64url')}`, digestKey, digestKeyVersion: 1 };
    expect((await repository.confirmActivation({ ...wrong, sourceMessageId: duplicateMessage })).disposition).toBe('wrong_token');
    expect((await repository.confirmActivation({ ...wrong, sourceMessageId: duplicateMessage })).disposition).toBe('duplicate_attempt');
    for (let attempt = 1; attempt < 4; attempt += 1) {
      expect((await repository.confirmActivation({ ...wrong, sourceMessageId: randomUUID() })).disposition).toBe('wrong_token');
    }
    expect((await repository.confirmActivation({ ...wrong, sourceMessageId: randomUUID() })).disposition).toBe('exhausted');
    expect((await pool.query('SELECT attempts FROM room_activation_challenges WHERE request_id = $1', [created.requestId])).rows[0].attempts).toBe(5);
  });

  it('allows in-scope confirmation after the token delivery outcome becomes unknown', async () => {
    const f = await fixture();
    const created = await request(f.scope);
    await issue(created.requestId);
    expect(await repository.markChallengeDeliveryUnknown(created.requestId)).toBe(true);
    expect((await pool.query('SELECT state FROM room_activation_requests WHERE request_id = $1', [created.requestId])).rows[0].state).toBe('DELIVERY_UNKNOWN');
    expect((await repository.confirmActivation({
      ...f.scope, sourceMessageId: randomUUID(), senderUserId: f.adminUserId, token, digestKey, digestKeyVersion: 1,
    })).disposition).toBe('enabled');
  });

  it('rejects a noncanonical challenge token before persisting a digest', async () => {
    const f = await fixture();
    const created = await request(f.scope);
    const claim = await repository.claimWaitingToSend(created.requestId, 'malformed-token-owner', 30_000);
    expect(claim).not.toBeNull();
    expect(await repository.prepareChallengeSend({
      requestId: created.requestId, leaseToken: claim!.leaseToken, token: `RA-${'A'.repeat(42)}B`, digestKey, digestKeyVersion: 1,
    })).toBe(false);
    expect((await pool.query('SELECT count(*) FROM room_activation_challenges WHERE request_id = $1', [created.requestId])).rows[0].count).toBe('0');
  });

  it('rejects an expired confirmation at the database clock boundary', async () => {
    const f = await fixture();
    const created = await request(f.scope);
    await issue(created.requestId);
    await pool.query("UPDATE room_activation_challenges SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE request_id = $1", [created.requestId]);
    expect((await repository.confirmActivation({
      ...f.scope, sourceMessageId: randomUUID(), senderUserId: f.adminUserId, token, digestKey, digestKeyVersion: 1,
    })).disposition).toBe('expired');
    expect((await repository.getPolicy(f.scope)).state).toBe('DISABLED');
  });

  it('serializes revoke against confirmation and never leaves a revoked grant active', async () => {
    const f = await fixture();
    const created = await request(f.scope);
    await issue(created.requestId);
    const outcomes = await Promise.all([
      repository.confirmActivation({ ...f.scope, sourceMessageId: randomUUID(), senderUserId: f.adminUserId, token, digestKey, digestKeyVersion: 1 }),
      repository.revokeRoom(f.scope, 'operator-revoke'),
    ]);
    expect(outcomes[0]?.disposition === 'enabled' || outcomes[0]?.disposition === 'cancelled').toBe(true);
    expect((await repository.getPolicy(f.scope)).state).toBe('DISABLED');
    expect((await pool.query("SELECT count(*) FROM room_agent_grants WHERE account_id = $1 AND chat_id = $2 AND state = 'ACTIVE'", [f.scope.accountId, f.scope.chatId])).rows[0].count).toBe('0');
  });

  it('serializes expiry against confirmation using database time', async () => {
    const f = await fixture();
    const created = await request(f.scope);
    await issue(created.requestId);
    await pool.query("UPDATE room_activation_challenges SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE request_id = $1", [created.requestId]);
    const results = await Promise.all([
      repository.confirmActivation({ ...f.scope, sourceMessageId: randomUUID(), senderUserId: f.adminUserId, token, digestKey, digestKeyVersion: 1 }),
      repository.expireRequest(created.requestId),
    ]);
    expect(results.some((result) => result === true || (typeof result === 'object' && result.disposition === 'expired'))).toBe(true);
    expect((await repository.getPolicy(f.scope)).state).toBe('DISABLED');
  });

  it('cancels a pending challenge after a PRIMARY_ADMIN binding version change', async () => {
    const f = await fixture();
    const created = await request(f.scope);
    await issue(created.requestId);
    const results = await Promise.all([
      repository.confirmActivation({ ...f.scope, sourceMessageId: randomUUID(), senderUserId: f.adminUserId, token, digestKey, digestKeyVersion: 1 }),
      repository.setPrimaryAdministrator(f.scope.accountId, `new-admin-${suffix}`, `new-user-${suffix}`, 1),
    ]);
    expect(results.some((result) => typeof result === 'object' && result.disposition === 'enabled'
      || typeof result === 'object' && result.disposition === 'cancelled')).toBe(true);
    expect((await repository.getPolicy(f.scope)).state).toBe('DISABLED');
    expect((await pool.query("SELECT count(*) FROM room_agent_grants WHERE account_id = $1 AND state = 'ACTIVE'", [f.scope.accountId])).rows[0].count).toBe('0');
  });

  it('applies the account-admin request rate limit', async () => {
    const f = await fixture();
    const rooms = Array.from({ length: 4 }, (_, index) => ({ ...f.scope, chatId: `${f.scope.chatId}-${index}` }));
    for (const room of rooms) {
      await pool.query("INSERT INTO conversations(account_id, chat_type, chat_id) VALUES ($1, 'group', $2)", [room.accountId, room.chatId]);
    }
    const results = await Promise.all(rooms.map((room) => request(room)));
    expect(results.filter((result) => result.disposition === 'created')).toHaveLength(3);
    expect(results.filter((result) => result.disposition === 'rate_limited')).toHaveLength(1);
  });

  it('enforces the eight-per-account and sixty-four-global pending limits', async () => {
    const f = await fixture();
    const targetRoom = `${f.scope.chatId}-target`;
    const pendingRooms = Array.from({ length: 8 }, (_, index) => `${f.scope.chatId}-pending-${index}`);
    for (const chatId of [...pendingRooms, targetRoom]) {
      await pool.query("INSERT INTO conversations(account_id, chat_type, chat_id) VALUES ($1, 'group', $2)", [f.scope.accountId, chatId]);
    }
    for (const chatId of pendingRooms) {
      await pool.query(
        `INSERT INTO room_activation_requests(request_id, account_id, chat_type, chat_id, source_message_id, requester_id,
          admin_chat_id, admin_user_id, admin_version, room_authority_version, state, wait_expires_at)
         VALUES ($1,$2,'group',$3,$4,'member','admin','unrelated-admin',1,1,'WAITING_TO_SEND',clock_timestamp() + interval '60 seconds')`,
        [randomUUID(), f.scope.accountId, chatId, randomUUID()],
      );
    }
    expect((await request({ ...f.scope, chatId: targetRoom })).disposition).toBe('capacity_reached');

    const global = await fixture();
    for (let index = 0; index < 64; index += 1) {
      const id = randomUUID();
      const account = `pending-${id}`;
      const chatId = `room-${id}`;
      await pool.query('INSERT INTO line_accounts(account_id) VALUES ($1)', [account]);
      await pool.query("INSERT INTO conversations(account_id, chat_type, chat_id) VALUES ($1, 'group', $2)", [account, chatId]);
      await pool.query(
        `INSERT INTO room_activation_requests(request_id, account_id, chat_type, chat_id, source_message_id, requester_id,
          admin_chat_id, admin_user_id, admin_version, room_authority_version, state, wait_expires_at)
         VALUES ($1,$2,'group',$3,$4,'member','admin','unrelated-admin',1,1,'WAITING_TO_SEND',clock_timestamp() + interval '60 seconds')`,
        [randomUUID(), account, chatId, randomUUID()],
      );
    }
    const globalTarget = `${global.scope.chatId}-target`;
    await pool.query("INSERT INTO conversations(account_id, chat_type, chat_id) VALUES ($1, 'group', $2)", [global.scope.accountId, globalTarget]);
    expect((await request({ ...global.scope, chatId: globalTarget })).disposition).toBe('capacity_reached');
    await pool.query("UPDATE room_activation_requests SET state = 'EXPIRED' WHERE admin_user_id = 'unrelated-admin'");
  });

  it('recovers only expired waiting leases after restart and never reissues a started token', async () => {
    const f = await fixture();
    const created = await request(f.scope);
    const lease = await repository.claimWaitingToSend(created.requestId, 'worker-before-restart', 30_000);
    expect(lease).not.toBeNull();
    await pool.query("UPDATE room_activation_requests SET lease_expires_at = clock_timestamp() - interval '1 millisecond' WHERE request_id = $1", [created.requestId]);
    expect(await repository.recoverExpiredLeases()).toBe(1);
    const recovered = await repository.claimWaitingToSend(created.requestId, 'worker-after-restart', 30_000);
    expect(recovered).not.toBeNull();
    await repository.prepareChallengeSend({ requestId: created.requestId, leaseToken: recovered!.leaseToken, token, digestKey, digestKeyVersion: 1 });
    expect(await repository.recoverExpiredLeases()).toBe(0);
    expect(await repository.claimWaitingToSend(created.requestId, 'worker-third', 30_000)).toBeNull();
  });

  describe('enableByPrimaryAdmin', () => {
    it('enables the room with an ACTIVE grant that every reader sees, and audits it', async () => {
      const f = await fixture();
      const message = randomUUID();
      expect(await repository.enableByPrimaryAdmin(f.scope, { sourceMessageId: message, adminUserId: f.adminUserId }))
        .toEqual({ disposition: 'enabled' });
      expect(await repository.hasActiveRoomGrant(f.scope)).toBe(true);
      const policy = await repository.getPolicy(f.scope);
      expect(policy).toMatchObject({ state: 'ENABLED', authorityVersion: 2 });
      expect(await repository.getActiveRoomAuthorization(f.scope)).toMatchObject({ version: 2 });
      const stored = await pool.query(
        'SELECT authorizing_admin_user_id, authorizing_admin_version, confirmed_request_id FROM room_agent_policies WHERE account_id = $1 AND chat_id = $2',
        [f.scope.accountId, f.scope.chatId]);
      expect(stored.rows[0]).toMatchObject({ authorizing_admin_user_id: f.adminUserId, authorizing_admin_version: '1' });
      expect(stored.rows[0].confirmed_request_id).toEqual(expect.any(String));
      const audit = await pool.query('SELECT event, actor_id, authority_version FROM room_activation_audit WHERE account_id = $1', [f.scope.accountId]);
      expect(audit.rows).toEqual([{ event: 'ADMIN_DIRECT_ENABLED', actor_id: f.adminUserId, authority_version: '2' }]);
    });

    it('rejects a sender who is not the Primary Admin without changing anything', async () => {
      const f = await fixture();
      expect(await repository.enableByPrimaryAdmin(f.scope, { sourceMessageId: randomUUID(), adminUserId: `member-${suffix}` }))
        .toEqual({ disposition: 'not_primary_admin' });
      expect(await repository.hasActiveRoomGrant(f.scope)).toBe(false);
      expect((await pool.query('SELECT count(*) FROM room_agent_policies WHERE account_id = $1', [f.scope.accountId])).rows[0].count).toBe('0');
      expect((await pool.query('SELECT count(*) FROM room_activation_requests WHERE account_id = $1', [f.scope.accountId])).rows[0].count).toBe('0');
    });

    it('reports a missing room', async () => {
      const f = await fixture();
      expect(await repository.enableByPrimaryAdmin({ ...f.scope, chatId: 'no-such-room' }, { sourceMessageId: randomUUID(), adminUserId: f.adminUserId }))
        .toEqual({ disposition: 'room_missing' });
    });

    it('is a no-op for an already enabled room', async () => {
      const f = await fixture();
      await repository.enableByPrimaryAdmin(f.scope, { sourceMessageId: randomUUID(), adminUserId: f.adminUserId });
      expect(await repository.enableByPrimaryAdmin(f.scope, { sourceMessageId: randomUUID(), adminUserId: f.adminUserId }))
        .toEqual({ disposition: 'already_enabled' });
      expect(await repository.getPolicy(f.scope)).toMatchObject({ authorityVersion: 2 });
      expect((await pool.query("SELECT count(*) FROM room_agent_grants WHERE account_id = $1 AND state = 'ACTIVE'", [f.scope.accountId])).rows[0].count).toBe('1');
    });

    it('cancels a pending token request and invalidates its challenge', async () => {
      const f = await fixture();
      const created = await request(f.scope);
      await issue(created.requestId!);
      expect(await repository.enableByPrimaryAdmin(f.scope, { sourceMessageId: randomUUID(), adminUserId: f.adminUserId }))
        .toEqual({ disposition: 'enabled' });
      expect((await pool.query('SELECT state FROM room_activation_requests WHERE request_id = $1', [created.requestId])).rows[0].state).toBe('CANCELLED');
      expect((await pool.query('SELECT invalidated_at FROM room_activation_challenges WHERE request_id = $1', [created.requestId])).rows[0].invalidated_at).not.toBeNull();
      expect(await repository.hasActiveRoomGrant(f.scope)).toBe(true);
      const events = await pool.query('SELECT event FROM room_activation_audit WHERE account_id = $1 ORDER BY audit_id', [f.scope.accountId]);
      expect(events.rows.map((row) => row.event)).toEqual(['REQUESTED', 'CHALLENGE_MAY_HAVE_STARTED', 'CANCELLED', 'ADMIN_DIRECT_ENABLED']);
      const confirm = await repository.confirmActivation({ ...f.scope, sourceMessageId: randomUUID(), senderUserId: f.adminUserId,
        token, digestKey, digestKeyVersion: 1 });
      expect(confirm.disposition).not.toBe('enabled');
    });

    it('replays the same source message without anything new', async () => {
      const f = await fixture();
      const message = randomUUID();
      await repository.enableByPrimaryAdmin(f.scope, { sourceMessageId: message, adminUserId: f.adminUserId });
      expect(await repository.enableByPrimaryAdmin(f.scope, { sourceMessageId: message, adminUserId: f.adminUserId }))
        .toEqual({ disposition: 'duplicate' });
      expect(await repository.getPolicy(f.scope)).toMatchObject({ authorityVersion: 2 });
      expect((await pool.query('SELECT count(*) FROM room_activation_audit WHERE account_id = $1', [f.scope.accountId])).rows[0].count).toBe('1');
    });

    it('enables again after a revoke with a fresh grant version', async () => {
      const f = await fixture();
      await repository.enableByPrimaryAdmin(f.scope, { sourceMessageId: randomUUID(), adminUserId: f.adminUserId });
      await repository.revokeRoom(f.scope, f.adminUserId);
      expect(await repository.hasActiveRoomGrant(f.scope)).toBe(false);
      expect(await repository.enableByPrimaryAdmin(f.scope, { sourceMessageId: randomUUID(), adminUserId: f.adminUserId }))
        .toEqual({ disposition: 'enabled' });
      expect(await repository.getActiveRoomAuthorization(f.scope)).toMatchObject({ version: 4 });
    });
  });
});
