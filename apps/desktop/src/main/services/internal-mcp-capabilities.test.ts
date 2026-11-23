import { describe, expect, it } from 'vitest';
import { InternalMcpCapabilityRegistry, isInternalMcpToken, type InternalMcpObservation } from './internal-mcp-capabilities.js';

const job = { jobId: 'j1', accountId: 'a', generation: 2, endpointInstance: 'e1' };

describe('InternalMcpCapabilityRegistry', () => {
  it('mints a 256-bit memory-only token bound to the job and validates only live capabilities', () => {
    const registry = new InternalMcpCapabilityRegistry();
    const { token, capability } = registry.mint(job);
    expect(isInternalMcpToken(token)).toBe(true);
    expect(Buffer.from(token.slice('li_job_'.length), 'base64url')).toHaveLength(32);
    expect(registry.validate(token)).toBe(capability);
    expect(capability).toMatchObject(job);
    expect(registry.validate(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).toBeNull();
    expect(registry.validate('la_mcp_' + 'A'.repeat(43))).toBeNull();
    expect(registry.mint({ ...job, jobId: 'j2' }).token).not.toBe(token);
  });

  it('stores the interactive approval binding, and null when absent', () => {
    const registry = new InternalMcpCapabilityRegistry();
    expect(registry.mint(job).capability.approval).toBeNull();
    expect(registry.mint({ ...job, jobId: 'j2', approval: null }).capability.approval).toBeNull();
    const binding = { sessionKey: '{"provider":"claude"}|3', workspaceRoot: 'C:\\ws' };
    const { token, capability } = registry.mint({ ...job, jobId: 'j3', approval: binding });
    expect(capability.approval).toEqual(binding);
    expect(capability.approval).not.toBe(binding);
    expect(registry.validate(token)?.approval).toEqual(binding);
  });

  it('aborts in-flight work and rejects on release, replacement, and releaseAll', () => {
    const registry = new InternalMcpCapabilityRegistry();
    const first = registry.mint(job);
    registry.release('j1');
    expect(first.capability.controller.signal.aborted).toBe(true);
    expect(registry.validate(first.token)).toBeNull();
    expect(registry.isLive(first.capability)).toBe(false);
    const second = registry.mint(job);
    const replacement = registry.mint(job);
    expect(second.capability.controller.signal.aborted).toBe(true);
    expect(registry.validate(second.token)).toBeNull();
    expect(registry.validate(replacement.token)).toBe(replacement.capability);
    expect(registry.size).toBe(1);
    registry.releaseAll();
    expect(registry.size).toBe(0);
    expect(registry.validate(replacement.token)).toBeNull();
  });

  it('reports availability only after both initialize and tools/list, on live capabilities', () => {
    const seen: InternalMcpObservation[] = [];
    const registry = new InternalMcpCapabilityRegistry(8, (_id, observation) => seen.push(observation));
    const { capability } = registry.mint(job);
    registry.observe(capability, 'tools_listed');
    expect(seen).not.toContain('available');
    registry.observe(capability, 'initialized');
    expect(seen).toContain('available');
    registry.release('j1');
    const before = seen.length;
    registry.observe(capability, 'initialized');
    expect(seen).toHaveLength(before);
  });

  describe('resident slots', () => {
    const resident = { residentKey: 'r1', jobId: 'j1', accountId: 'a', generation: 1, endpointInstance: 'e1' };

    it('bindResident fresh makes a token, and a new fresh bind replaces the old slot', () => {
      const registry = new InternalMcpCapabilityRegistry();
      const first = registry.bindResident({ ...resident, fresh: true }) as { token: string };
      expect(isInternalMcpToken(first.token)).toBe(true);
      const firstCapability = registry.validate(first.token)!;
      expect(firstCapability.jobId).toBe('j1');
      const second = registry.bindResident({ ...resident, jobId: 'j2', fresh: true }) as { token: string };
      expect(second.token).not.toBe(first.token);
      expect(firstCapability.controller.signal.aborted).toBe(true);
      expect(registry.validate(first.token)).toBeNull();
      expect(registry.resolveToken(first.token)).toBeNull();
      expect(registry.validate(second.token)?.jobId).toBe('j2');
      expect(registry.size).toBe(1);
    });

    it('bindResident rebound keeps the token, aborts the old capability and carries a complete handshake', () => {
      const seen: Array<[string, InternalMcpObservation]> = [];
      const registry = new InternalMcpCapabilityRegistry(8, (id, observation) => seen.push([id, observation]));
      const { token } = registry.bindResident({ ...resident, fresh: true }) as { token: string };
      const old = registry.validate(token)!;
      expect(registry.bindResident({ ...resident, jobId: 'j2', fresh: false })).toBe('rebound');
      expect(old.controller.signal.aborted).toBe(true);
      expect(registry.isLive(old)).toBe(false);
      const incomplete = registry.validate(token)!;
      expect(incomplete).toMatchObject({ jobId: 'j2', initialized: false, toolsListed: false, available: false });
      registry.observe(incomplete, 'initialized');
      registry.observe(incomplete, 'tools_listed');
      seen.length = 0;
      expect(registry.bindResident({ ...resident, jobId: 'j3', fresh: false })).toBe('rebound');
      const next = registry.validate(token)!;
      expect(next).toMatchObject({ jobId: 'j3', initialized: true, toolsListed: true, available: true });
      expect(seen).toEqual([['j3', 'available']]);
      expect(registry.isLive(next)).toBe(true);
      expect(registry.size).toBe(1);
    });

    it('bindResident not fresh returns null without a slot or with another endpoint instance', () => {
      const registry = new InternalMcpCapabilityRegistry();
      expect(registry.bindResident({ ...resident, fresh: false })).toBeNull();
      registry.bindResident({ ...resident, fresh: true });
      expect(registry.bindResident({ ...resident, jobId: 'j2', fresh: false, endpointInstance: 'e2' })).toBeNull();
    });

    it('release unbinds a resident slot and keeps the token; releaseResident deletes it', () => {
      const registry = new InternalMcpCapabilityRegistry();
      const { token } = registry.bindResident({ ...resident, fresh: true }) as { token: string };
      const capability = registry.validate(token)!;
      registry.release('j1');
      expect(capability.controller.signal.aborted).toBe(true);
      expect(registry.validate(token)).toBeNull();
      expect(registry.resolveToken(token)).toEqual({ kind: 'idle', slotKey: expect.any(String), endpointInstance: 'e1' });
      expect(registry.size).toBe(1);
      registry.releaseResident('r1');
      expect(registry.resolveToken(token)).toBeNull();
      expect(registry.size).toBe(0);
    });

    it('releaseResident aborts a live capability', () => {
      const registry = new InternalMcpCapabilityRegistry();
      const { token } = registry.bindResident({ ...resident, fresh: true }) as { token: string };
      const capability = registry.validate(token)!;
      registry.releaseResident('r1');
      expect(capability.controller.signal.aborted).toBe(true);
    });

    it('counts one-shot and resident slots in the limit', () => {
      const registry = new InternalMcpCapabilityRegistry(2);
      registry.bindResident({ ...resident, fresh: true });
      registry.mint({ ...job, jobId: 'j9' });
      expect(() => registry.mint({ ...job, jobId: 'j10' })).toThrow(/limit/);
      expect(() => registry.bindResident({ ...resident, residentKey: 'r2', jobId: 'j11', fresh: true })).toThrow(/limit/);
      registry.release('j9');
      expect(registry.size).toBe(1);
      registry.releaseAll();
      expect(registry.size).toBe(0);
    });

    it('keeps the last tool list of a resident slot', () => {
      const registry = new InternalMcpCapabilityRegistry();
      const { token } = registry.bindResident({ ...resident, fresh: true }) as { token: string };
      registry.recordToolList(registry.validate(token)!, [{ name: 't' }]);
      registry.release('j1');
      const idle = registry.resolveToken(token);
      expect(idle?.kind === 'idle' && registry.idleToolList(idle.slotKey)).toEqual([{ name: 't' }]);
    });
  });
});
