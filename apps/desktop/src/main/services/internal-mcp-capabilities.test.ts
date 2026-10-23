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
});
