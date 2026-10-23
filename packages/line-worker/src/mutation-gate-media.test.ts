import { describe, expect, it, vi } from 'vitest';
import { createMutationGate, type ControlLease } from './mutation-gate.js';

const LEASE: ControlLease = Object.freeze({ accountId: 'u-agent', workerInstanceId: 'worker-1', controlEpoch: 7 });
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const OID = 'OID1234567890abcdef';

function setup(valid = () => true) {
  const transport = vi.fn(async (_request: Request) => ({ status: 200 }));
  const gate = createMutationGate<unknown, unknown, { status: number }>({
    accountId: 'u-agent', workerInstanceId: 'worker-1', validateControlLease: valid,
    requestClient: { invoke: async () => { throw new Error('unused'); } }, physicalTransport: transport,
  });
  return { gate, transport };
}
const post = (path: string, init: RequestInit = {}, host = 'obs.line-apps.com') =>
  new Request(`https://${host}${path}`, { method: 'POST', body: new Uint8Array([1]), redirect: 'error', ...init });
const reqPath = (ns: 'emi' | 'emf' = 'emi') => `/r/talk/${ns}/reqid-${UUID}`;
const previewPath = `/r/talk/emi/${OID}__ud-preview`;

describe('media upload scope', () => {
  it('passes an image upload and its preview inside a scope', async () => {
    const { gate, transport } = setup();
    const scope = gate.openMediaUploadScope(LEASE, 'image');
    await gate.runMediaUpload(scope, post(reqPath()));
    await gate.runMediaUpload(scope, post(previewPath));
    expect(transport).toHaveBeenCalledTimes(2);
    scope.close();
  });

  it('passes a single file upload and denies a preview for files', async () => {
    const { gate, transport } = setup();
    const scope = gate.openMediaUploadScope(LEASE, 'file');
    await gate.runMediaUpload(scope, post(reqPath('emf')));
    await expect(gate.runMediaUpload(scope, post(previewPath))).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('denies every upload outside or after a scope', async () => {
    const { gate, transport } = setup();
    const scope = gate.openMediaUploadScope(LEASE, 'image');
    scope.close();
    await expect(gate.runMediaUpload(scope, post(reqPath()))).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
    const forged = Object.freeze({ kind: 'image' as const, lease: LEASE, close: () => undefined });
    await expect(gate.runMediaUpload(forged, post(reqPath()))).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ['a GET', () => post(reqPath(), { method: 'GET', body: undefined })],
    ['a query', () => post(`${reqPath()}?p=abc`)],
    ['a non-error redirect', () => post(reqPath(), { redirect: 'follow' })],
    ['another host', () => post(reqPath(), {}, 'evil.example.com')],
    ['a custom port', () => post(reqPath(), {}, 'obs.line-apps.com:8443')],
    ['an uppercase request id', () => post(`/r/talk/emi/reqid-${UUID.toUpperCase()}`)],
    ['the wrong namespace', () => post(reqPath('emf'))],
    ['a message path', () => post(`/r/talk/m/${OID}`)],
    ['a double-slash path', () => post(`/${reqPath()}`)],
  ])('denies %s', async (_name, build) => {
    const { gate, transport } = setup();
    const scope = gate.openMediaUploadScope(LEASE, 'image');
    await expect(gate.runMediaUpload(scope, build())).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('denies a third POST and a reused path', async () => {
    const { gate, transport } = setup();
    const scope = gate.openMediaUploadScope(LEASE, 'image');
    await gate.runMediaUpload(scope, post(reqPath()));
    await expect(gate.runMediaUpload(scope, post(reqPath()))).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
    const other = gate.openMediaUploadScope(LEASE, 'image');
    await gate.runMediaUpload(other, post(reqPath()));
    await gate.runMediaUpload(other, post(previewPath));
    await expect(gate.runMediaUpload(other, post(`/r/talk/emi/${OID}b__ud-preview`))).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('denies concurrent reuse of one path', async () => {
    const { gate, transport } = setup();
    const scope = gate.openMediaUploadScope(LEASE, 'image');
    const results = await Promise.allSettled([gate.runMediaUpload(scope, post(reqPath())), gate.runMediaUpload(scope, post(reqPath()))]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('re-validates the lease before each POST', async () => {
    let valid = true;
    const validate = vi.fn(() => valid);
    const { gate, transport } = setup(validate);
    const scope = gate.openMediaUploadScope(LEASE, 'image');
    await gate.runMediaUpload(scope, post(reqPath()));
    valid = false;
    await expect(gate.runMediaUpload(scope, post(previewPath))).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledWith(LEASE, 'CONTROL_SEND');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('rejects a scope for a foreign lease and keeps runFetch GET-only', async () => {
    const { gate, transport } = setup();
    expect(() => gate.openMediaUploadScope({ ...LEASE, accountId: 'other' }, 'image')).toThrow();
    await expect(gate.runFetch({ phase: 'CONTROL_READ', lease: LEASE }, post(reqPath()))).rejects.toMatchObject({ code: 'SIDE_EFFECT_DENIED' });
    expect(transport).not.toHaveBeenCalled();
  });
});
