import { describe, expect, it, vi } from 'vitest';
import { createOfficialLineSessionGuard, isOfficialLineImagePath, parseLineProcessListing, type OfficialSourceVerification } from './official-line-session-guard.js';

const LOCAL = String.raw`C:\Users\u\AppData\Local`;
const OFFICIAL = String.raw`C:\Users\u\AppData\Local\LINE\bin\LINE.exe`;

function setup(input: {
  images?: readonly string[] | Error; verify?: OfficialSourceVerification | Error | 'hang'; noVerifier?: boolean; processCount?: number; deadlineMs?: number;
}) {
  const list = vi.fn(async (_signal: AbortSignal) => {
    if (input.images instanceof Error) throw input.images;
    const paths = input.images ?? [OFFICIAL];
    return { processCount: input.processCount ?? paths.length, paths };
  });
  const verify = vi.fn((request: { expectedMid: string; signal: AbortSignal }) => {
    if (input.verify === 'hang') return new Promise<OfficialSourceVerification>(() => undefined);
    if (input.verify instanceof Error) return Promise.reject(input.verify);
    return Promise.resolve(input.verify ?? { status: 'supported' as const });
  });
  const guard = createOfficialLineSessionGuard({ listLineProcessImagePaths: list, localAppData: LOCAL,
    ...(input.noVerifier ? {} : { verifyOfficialSource: verify }), ...(input.deadlineMs ? { deadlineMs: input.deadlineMs } : {}) });
  return { guard, list, verify };
}

describe('official LINE session guard', () => {
  it('only treats LINE.exe under LOCALAPPDATA LINE bin as the official app', () => {
    expect(isOfficialLineImagePath(OFFICIAL, LOCAL)).toBe(true);
    expect(isOfficialLineImagePath(String.raw`c:\users\u\appdata\local\line\bin\8.0\line.exe`, LOCAL)).toBe(true);
    expect(isOfficialLineImagePath(String.raw`C:\Tools\LINE\bin\LINE.exe`, LOCAL)).toBe(false);
    expect(isOfficialLineImagePath(String.raw`C:\Users\u\AppData\Local\LINE\binx\LINE.exe`, LOCAL)).toBe(false);
    expect(isOfficialLineImagePath(String.raw`C:\Users\u\AppData\Local\LINE\bin\other.exe`, LOCAL)).toBe(false);
  });

  it('returns not_running without a handshake when no official process exists', async () => {
    const { guard, verify } = setup({ images: [String.raw`C:\Other\LINE.exe`] });
    expect(await guard.check({ accountId: 'a', ownMid: 'u1' })).toBe('not_running');
    expect(verify).not.toHaveBeenCalled();
  });

  it('maps handshake verdicts', async () => {
    expect(await setup({ verify: { status: 'supported' } }).guard.check({ accountId: 'a', ownMid: 'u1' })).toBe('same_account');
    expect(await setup({ verify: { status: 'unsupported', errorCode: 'mid_or_schema_mismatch' } }).guard.check({ accountId: 'a', ownMid: 'u1' })).toBe('other_account');
    expect(await setup({ verify: { status: 'unsupported', errorCode: 'process_missing' } }).guard.check({ accountId: 'a', ownMid: 'u1' })).toBe('not_running');
    for (const errorCode of ['unsupported_build', 'build_rotation', 'process_ambiguous', 'source_io_error']) {
      expect(await setup({ verify: { status: 'unsupported', errorCode } }).guard.check({ accountId: 'a', ownMid: 'u1' })).toBe('unknown');
    }
    expect(await setup({ verify: new Error('reader_failed') }).guard.check({ accountId: 'a', ownMid: 'u1' })).toBe('unknown');
  });

  it('resolves same_account and other_account well before the deadline', async () => {
    for (const [verify, expected] of [[{ status: 'supported' }, 'same_account'],
      [{ status: 'unsupported', errorCode: 'mid_or_schema_mismatch' }, 'other_account']] as const) {
      const { guard } = setup({ verify, deadlineMs: 5_000 });
      const started = Date.now();
      expect(await guard.check({ accountId: 'a', ownMid: 'u1' })).toBe(expected);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  });

  it('is unknown for an unknown account or missing reader while official LINE runs', async () => {
    const unknownAccount = setup({});
    expect(await unknownAccount.guard.check({ accountId: 'new', ownMid: null })).toBe('unknown');
    expect(unknownAccount.verify).not.toHaveBeenCalled();
    expect(await setup({ noVerifier: true }).guard.check({ accountId: 'a', ownMid: 'u1' })).toBe('unknown');
  });

  it('is unknown when a LINE.exe has an unreadable path and none is confirmed official', async () => {
    expect(await setup({ images: [], processCount: 1 }).guard.check({ accountId: 'a', ownMid: 'u1' })).toBe('unknown');
    expect(await setup({ images: [String.raw`C:\Other\LINE.exe`], processCount: 2 }).guard.check({ accountId: 'a', ownMid: 'u1' })).toBe('unknown');
    expect(await setup({ images: [], processCount: 0 }).guard.check({ accountId: 'a', ownMid: 'u1' })).toBe('not_running');
  });

  it('decodes base64 UTF-8 listings so non-ASCII paths survive', () => {
    const chinese = String.raw`C:\Users\測試\AppData\Local\LINE\bin\LINE.exe`;
    const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
    const listing = parseLineProcessListing(`P:${b64(chinese)}\r\nnoise\r\nP:\r\n`);
    expect(listing).toEqual({ processCount: 2, paths: [chinese] });
    expect(isOfficialLineImagePath(listing.paths[0]!, String.raw`C:\Users\測試\AppData\Local`)).toBe(true);
  });

  it('treats invalid base64 and over-cap listings as unreadable so the guard fails safe', async () => {
    const b64 = Buffer.from(OFFICIAL, 'utf8').toString('base64');
    expect(parseLineProcessListing(['P:!!not-base64!!', 'P:' + b64].join('\n'))).toEqual({ processCount: 2, paths: [OFFICIAL] });
    const other = Buffer.from('C:\\Other\\LINE.exe', 'utf8').toString('base64');
    const over = parseLineProcessListing(Array.from({ length: 300 }, () => 'P:' + other).join('\n'));
    expect(over.processCount).toBe(300);
    expect(over.paths.length).toBe(256);
    expect(await setup({ images: over.paths, processCount: over.processCount }).guard.check({ accountId: 'a', ownMid: 'u1' })).toBe('unknown');
  });

  it('is unknown when the process listing fails', async () => {
    expect(await setup({ images: new Error('powershell failed') }).guard.check({ accountId: 'a', ownMid: 'u1' })).toBe('unknown');
  });

  it('times out to unknown and aborts the handshake', async () => {
    const { guard, verify } = setup({ verify: 'hang', deadlineMs: 20 });
    expect(await guard.check({ accountId: 'a', ownMid: 'u1' })).toBe('unknown');
    expect(verify.mock.calls[0]![0].signal.aborted).toBe(true);
  });

  it('coalesces concurrent checks and keeps no cache afterwards', async () => {
    const { guard, list } = setup({ images: [] });
    const [first, second] = await Promise.all([guard.check({ accountId: 'a', ownMid: 'u1' }), guard.check({ accountId: 'a', ownMid: 'u1' })]);
    expect([first, second]).toEqual(['not_running', 'not_running']);
    expect(list).toHaveBeenCalledTimes(1);
    await guard.check({ accountId: 'a', ownMid: 'u1' });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('cancels in-flight work on shutdown and answers unknown afterwards', async () => {
    const { guard, verify } = setup({ verify: 'hang' });
    const pending = guard.check({ accountId: 'a', ownMid: 'u1' });
    await vi.waitFor(() => expect(verify).toHaveBeenCalled());
    guard.shutdown();
    expect(verify.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(await guard.check({ accountId: 'b', ownMid: 'u2' })).toBe('unknown');
    pending.catch(() => undefined);
  });
});
