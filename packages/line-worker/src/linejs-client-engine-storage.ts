import { MemoryStorage } from '@evex/linejs/storage';
import type { JsonValue } from '@line-agent/contracts';

type StorageValue = Parameters<MemoryStorage['set']>[1];
export type StorageChange = Readonly<{ key: string | null }>;

/**
 * The linejs MemoryStorage plus one observer. It only reports a change after linejs wrote it.
 * It never changes a value, and it never reads LINE.
 */
export class ObservedMemoryStorage extends MemoryStorage {
  #listener?: (change: StorageChange) => void;
  #loading = false;
  setListener(listener: (change: StorageChange) => void): void { this.#listener = listener; }
  /** Replace the content with a saved snapshot. This reports no change. */
  async load(snapshot: JsonValue | null, qrCert: string | null): Promise<void> {
    this.#loading = true;
    try {
      await super.clear();
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        for (const [key, value] of Object.entries(snapshot)) await super.set(key, value as StorageValue);
      }
      if (qrCert !== null) await super.set('qrCert', qrCert);
    } finally { this.#loading = false; }
  }
  override async set(key: string, value: StorageValue): Promise<void> {
    await super.set(key, value);
    if (!this.#loading) this.#listener?.({ key });
  }
  override async delete(key: string): Promise<void> {
    await super.delete(key);
    if (!this.#loading) this.#listener?.({ key });
  }
  override async clear(): Promise<void> {
    await super.clear();
    if (!this.#loading) this.#listener?.({ key: null });
  }
}
