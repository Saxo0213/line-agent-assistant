import { randomInt, timingSafeEqual } from 'node:crypto';
import type { InboundEnvelope } from '@line-agent/contracts';

interface AdminStore {
  hasPrimary(accountId: string): Promise<boolean>;
  bindPrimary(accountId: string, chatId: string, userId: string): Promise<boolean>;
}

export class AdminPairingService {
  private readonly challenges = new Map<string, { token: string; expiresAt: number }>();
  constructor(private readonly admins: AdminStore, private readonly now = () => Date.now(),
    private readonly makeToken = () => randomInt(100000, 1000000).toString()) {}

  async begin(accountId: string): Promise<{ token: string; expiresAt: string }> {
    if (await this.admins.hasPrimary(accountId)) throw new Error('此帳號已設定主要管理者。');
    const token = this.makeToken();
    if (!/^\d{6}$/.test(token)) throw new Error('Invalid administrator pairing token');
    const expiresAt = this.now() + 180_000;
    this.challenges.set(accountId, { token, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  async consume(envelope: InboundEnvelope): Promise<boolean> {
    if (envelope.ingestion.source !== 'live' || envelope.chatType !== 'direct' || envelope.kind !== 'text' || !envelope.text) return false;
    const challenge = this.challenges.get(envelope.accountId);
    if (!challenge) return false;
    if (this.now() >= challenge.expiresAt) { this.challenges.delete(envelope.accountId); return false; }
    const supplied = Buffer.from(envelope.text, 'utf8'); const expected = Buffer.from(challenge.token, 'utf8');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    const bound = await this.admins.bindPrimary(envelope.accountId, envelope.chatId, envelope.senderId);
    if (bound || await this.admins.hasPrimary(envelope.accountId)) this.challenges.delete(envelope.accountId);
    return bound;
  }

  classify(envelope: InboundEnvelope): boolean {
    if (envelope.ingestion.source !== 'live' || envelope.chatType !== 'direct' || envelope.kind !== 'text' || !envelope.text) return false;
    const challenge = this.challenges.get(envelope.accountId);
    if (!challenge || this.now() >= challenge.expiresAt) return false;
    const supplied = Buffer.from(envelope.text, 'utf8');
    const expected = Buffer.from(challenge.token, 'utf8');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
}
