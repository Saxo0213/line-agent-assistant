import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { createLinejsProviderClient, createRestrictedProviderFetch, parseNativeCandidateFrame,
  runBoundedNativeAuthProbe, runNativeCandidateHelper, runProviderValidation } from './native-auth-readonly.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const expectedMid = `u${'a'.repeat(32)}`;
const candidate = (token: string, application = 'DESKTOPWIN\t26.4.2.3957\tWINDOWS\t10.0.0-NT-x64') => ({ token, application });

describe('native auth read-only provider proof', () => {
  it('checks profile identity before requesting feature-2 OBS authorization and reports no credential bytes', async () => {
    const calls: string[] = [];
    const result = await runProviderValidation({
      candidates: [candidate('fixture-token-one')], expectedMid, deadlineUnixMs: Date.now() + 10_000,
      createClient: async () => ({
        authToken: undefined as string | undefined,
        request: { systemType: '' },
        talk: {
          async getProfile() { calls.push('getProfile'); return { mid: expectedMid }; },
          async acquireEncryptedAccessToken(args: { featureType: number }) { calls.push(`obs:${args.featureType}`); return '3600\u001efixture-obs-secret'; },
        },
        async close() { calls.push('close'); },
      }),
    });
    expect(calls).toEqual(['getProfile', 'obs:2', 'close']);
    expect(result).toEqual({ status: 'success', candidatesTried: 1, matchedAccount: true,
      obsAuthorizationReceived: true, requestsAttempted: 0, maxConcurrentRequests: 0 });
    expect(JSON.stringify(result)).not.toContain('fixture-token-one');
    expect(JSON.stringify(result)).not.toContain('fixture-obs-secret');
  });

  it('never requests OBS authorization for the wrong profile and continues to the next candidate', async () => {
    const calls: string[] = [];
    const result = await runProviderValidation({
      candidates: [candidate('wrong-candidate'), candidate('right-candidate')], expectedMid, deadlineUnixMs: Date.now() + 10_000,
      createClient: async () => {
        const number = calls.filter((call) => call === 'construct').length + 1;
        calls.push('construct');
        return { authToken: undefined as string | undefined, request: { systemType: '' }, talk: {
          async getProfile() { calls.push('profile'); return { mid: number === 1 ? `u${'b'.repeat(32)}` : expectedMid }; },
          async acquireEncryptedAccessToken() { calls.push('obs'); return '1\u001eobs-fixture'; },
        }, async close() { calls.push('close'); } };
      },
    });
    expect(calls).toEqual(['construct', 'profile', 'close', 'construct', 'profile', 'obs', 'close']);
    expect(result).toMatchObject({ status: 'success', candidatesTried: 2, matchedAccount: true,
      obsAuthorizationReceived: true });
  });

  it('keeps matchedAccount false when every candidate belongs to a different account', async () => {
    const calls: string[] = [];
    const result = await runProviderValidation({ candidates: [candidate('wrong-1'), candidate('wrong-2')], expectedMid,
      deadlineUnixMs: Date.now() + 10_000, createClient: async () => ({ request: { systemType: '' }, talk: {
        async getProfile() { calls.push('profile'); return { mid: `u${'b'.repeat(32)}` }; },
        async acquireEncryptedAccessToken() { calls.push('obs'); return '1\u001eobs-fixture'; },
      } }) });
    expect(result.matchedAccount).toBe(false);
    expect(calls).toEqual(['profile', 'profile']);
  });

  it('applies one 90-second entry deadline across account lookup, acquisition, and provider validation', async () => {
    const phases: string[] = [];
    const started = Date.now();
    let sharedDeadline = 0;
    const result = await runBoundedNativeAuthProbe({ deadlineUnixMs: started + 60,
      readExpectedMid: async (_signal, deadline) => {
        phases.push('account'); sharedDeadline = deadline;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        return expectedMid;
      },
      acquireCandidates: async (signal, deadline, onDuration) => {
        phases.push('acquire');
        expect(deadline).toBe(sharedDeadline);
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => { onDuration(17); resolve(); }, { once: true }));
        return [];
      },
      validate: async () => { phases.push('validate'); throw new Error('must_not_validate_after_deadline'); },
    });
    expect(phases).toEqual(['account', 'acquire']);
    expect(result).toMatchObject({ status: 'failed', failure: 'timeout', candidatesTried: 0, obsAuthorizationReceived: false });
    expect(result.nativeAcquisitionDurationMs).toBe(17);
    expect(Date.now() - started).toBeLessThan(120);
  });

  it('rejects malformed candidate headers without exposing token or raw provider errors', async () => {
    const result = await runProviderValidation({
      candidates: [candidate('sentinel-malformed', 'CHROMEOS\t3.7.2\tChrome_OS')], expectedMid,
      deadlineUnixMs: Date.now() + 10_000, createClient: async () => { throw new Error('must not construct'); },
    });
    expect(result).toEqual({ status: 'failed', candidatesTried: 0, matchedAccount: false,
      obsAuthorizationReceived: false, failure: 'no_usable_candidate', requestsAttempted: 0, maxConcurrentRequests: 0 });
    expect(JSON.stringify(result)).not.toContain('sentinel-malformed');
  });

  it('parses and deduplicates only bounded native candidate frames', () => {
    const valid = candidate('sentinel-frame-token');
    expect(parseNativeCandidateFrame(JSON.stringify({ status: 'ok', candidates: [valid, valid] }))).toEqual([valid]);
    expect(() => parseNativeCandidateFrame(JSON.stringify({ status: 'ok', candidates: [candidate('x', 'DESKTOPWIN\nInjected: yes')] })))
      .toThrow('native_candidate_frame_invalid');
    expect(() => parseNativeCandidateFrame('x'.repeat(33 * 1024))).toThrow('native_candidate_frame_too_large');
  });

  it('owns one helper with no credential arguments or inherited secrets and accepts only captured bounded stdio', async () => {
    const token = 'sentinel-child-token';
    const frame = JSON.stringify({ status: 'ok', candidates: [candidate(token)] });
    const controller = new AbortController();
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(() => { setTimeout(() => child.emit('close', 0, null), 0); return true; }) });
    const spawnImpl = vi.fn((_path: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(args).toEqual([]);
      expect(options.env).not.toHaveProperty('SECRET_TOKEN');
      setTimeout(() => { child.stdout.write(frame); child.stdout.end(); child.stderr.end(); child.emit('close', 0, null); }, 15);
      return child;
    });
    let duration = -1;
    const result = await runNativeCandidateHelper({ executablePath: 'C:\\probe.exe', signal: controller.signal,
      spawnImpl: spawnImpl as never, environment: { LOCALAPPDATA: 'C:\\Users\\fixture', SECRET_TOKEN: token },
      onDuration: (elapsed) => { duration = elapsed; } });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(result).toEqual([candidate(token)]);
    expect(duration).toBeGreaterThanOrEqual(10);
  });

  it('terminates only its owned helper on caller cancellation', async () => {
    const controller = new AbortController();
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const kill = vi.fn(() => { setTimeout(() => child.emit('close', null, 'SIGTERM'), 0); return true; });
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill });
    const pending = runNativeCandidateHelper({ executablePath: 'C:\\probe.exe', signal: controller.signal,
      spawnImpl: (() => child) as never });
    controller.abort();
    await expect(pending).rejects.toThrow('native_candidate_cancelled');
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('reports bounded failure when its helper does not exit after graceful and forced termination', async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const kill = vi.fn(() => true);
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill });
    const started = Date.now();
    await expect(runNativeCandidateHelper({ executablePath: 'C:\\probe.exe', signal: new AbortController().signal,
      spawnImpl: (() => child) as never, timeoutMs: 10, stopGraceMs: 20 })).rejects.toThrow('native_candidate_shutdown_failed');
    expect(kill).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('aborts the owned helper when its acquisition timeout expires', async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const kill = vi.fn(() => { setTimeout(() => child.emit('close', null, 'SIGTERM'), 0); return true; });
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill });
    await expect(runNativeCandidateHelper({ executablePath: 'C:\\probe.exe', signal: new AbortController().signal,
      spawnImpl: (() => child) as never, timeoutMs: 10, stopGraceMs: 30 })).rejects.toThrow('native_candidate_timeout');
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('turns helper stderr/process errors into a bounded error without echoing its bytes', async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(() => true) });
    const pending = runNativeCandidateHelper({ executablePath: 'C:\\probe.exe', signal: new AbortController().signal,
      spawnImpl: (() => {
        setTimeout(() => { child.stderr.write('sentinel-raw-helper-error'); child.stderr.end(); child.emit('close', 1, null); }, 0);
        return child;
      }) as never });
    await expect(pending).rejects.toThrow('native_candidate_unavailable');
    expect(await pending.catch((error: Error) => error.message)).not.toContain('sentinel-raw-helper-error');
  });

  it('admits only bounded fixed LINE RPC routes, aborts the underlying request and caps response bodies', async () => {
    const budget = { requestsAttempted: 0, activeRequests: 0, maxConcurrentRequests: 0 };
    const controller = new AbortController();
    const gatedFetch = createRestrictedProviderFetch({ budget, signal: controller.signal,
      fetchImpl: async (request) => {
        expect(request.redirect).toBe('manual');
        expect(request.signal.aborted).toBe(false);
        return new Response(new Uint8Array(8));
      }, maxResponseBytes: 4 });
    await expect(gatedFetch(new Request('https://example.com/anything', { method: 'POST' }))).rejects.toThrow('provider_route_denied');
    await expect(gatedFetch(new Request('https://gf.line.naver.jp/enc', { method: 'POST' }))).rejects.toThrow('provider_response_too_large');
    expect(budget).toMatchObject({ requestsAttempted: 1, activeRequests: 0, maxConcurrentRequests: 1 });
    const redirect = createRestrictedProviderFetch({ budget: { requestsAttempted: 0, activeRequests: 0, maxConcurrentRequests: 0 },
      signal: controller.signal, fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://example.com' } }) });
    await expect(redirect(new Request('https://gf.line.naver.jp/enc', { method: 'POST' }))).rejects.toThrow('provider_redirect_denied');
  });

  it('honors caller cancellation at the underlying fetch signal', async () => {
    const controller = new AbortController();
    let observedAbort = false;
    const gatedFetch = createRestrictedProviderFetch({
      budget: { requestsAttempted: 0, activeRequests: 0, maxConcurrentRequests: 0 }, signal: controller.signal,
      fetchImpl: async (request) => await new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => { observedAbort = true; reject(new Error('aborted')); }, { once: true });
      }),
    });
    const pending = gatedFetch(new Request('https://gf.line.naver.jp/enc', { method: 'POST' }));
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(observedAbort).toBe(true);
  });

  it('aborts the provider fetch when its per-request timeout expires', async () => {
    let observedAbort = false;
    const gatedFetch = createRestrictedProviderFetch({
      budget: { requestsAttempted: 0, activeRequests: 0, maxConcurrentRequests: 0 },
      signal: new AbortController().signal, requestTimeoutMs: 10,
      fetchImpl: async (request) => await new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => { observedAbort = true; reject(new Error('aborted')); }, { once: true });
      }),
    });
    await expect(gatedFetch(new Request('https://gf.line.naver.jp/enc', { method: 'POST' }))).rejects.toThrow();
    expect(observedAbort).toBe(true);
  });

  it('rejects a second simultaneous provider request before it reaches fetch', async () => {
    const budget = { requestsAttempted: 0, activeRequests: 0, maxConcurrentRequests: 0 };
    const releases: Array<(response: Response) => void> = [];
    const gatedFetch = createRestrictedProviderFetch({ budget, signal: new AbortController().signal,
      fetchImpl: async () => await new Promise<Response>((resolve) => { releases.push(resolve); }) });
    const first = gatedFetch(new Request('https://gf.line.naver.jp/enc', { method: 'POST' }));
    const second = gatedFetch(new Request('https://gf.line.naver.jp/enc', { method: 'POST' }));
    const secondResult = expect(second).rejects.toThrow('provider_concurrency_limit');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (const release of releases) release(new Response(null));
    await Promise.allSettled([first, second]);
    await secondResult;
    expect(budget.maxConcurrentRequests).toBe(1);
  });

  it('uses the existing BaseClient request path without invoking login and installs only the candidate header in memory', async () => {
    const requests: Request[] = [];
    const fixtureJwt = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"exp":1}').toString('base64url')}.fixture-signature`;
    const application = candidate('').application;
    const client = createLinejsProviderClient({ application, budget: { requestsAttempted: 0, activeRequests: 0, maxConcurrentRequests: 0 },
      signal: new AbortController().signal, fetchImpl: async (request) => {
        requests.push(request);
        throw new Error('fixture_stop_before_network');
      } });
    const login = vi.spyOn(client.loginProcess, 'login');
    client.authToken = fixtureJwt;
    client.request.systemType = application;
    await expect(client.talk.getProfile()).rejects.toThrow('fixture_stop_before_network');
    expect(login).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://gf.line.naver.jp/enc');
    expect(client.deviceDetails.appVersion).toBe('26.4.2.3957');
    expect(client.request.systemType).toBe(application);
    expect(requests[0]?.headers.get('x-line-application')).toBe(application);
    expect(requests[0]?.headers.get('user-agent')).toBe('Line/26.4.2.3957');
    expect(JSON.stringify(requests.map((request) => Object.fromEntries(request.headers.entries()))))
      .not.toContain(fixtureJwt);
  });
});
