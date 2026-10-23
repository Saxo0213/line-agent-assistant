import { describe, expect, it, vi } from 'vitest';
import { createFileTypeIconResolver, isSafeFileIconExtension } from './file-type-icon.js';

const png = `data:image/png;base64,${'A'.repeat(48)}`;
const image = { isEmpty: () => false, toDataURL: () => png };

describe('file type icons', () => {
  it('accepts only short lowercase safe extensions', () => {
    expect(isSafeFileIconExtension('pdf')).toBe(true);
    for (const extension of ['PDF', '.pdf', 'a'.repeat(13), 'exe', 'dll', 'ico', 'ps1', 'bad/path']) {
      expect(isSafeFileIconExtension(extension)).toBe(false);
    }
  });

  it('uses a synthetic extension path and coalesces repeated requests', async () => {
    let complete!: (value: typeof image) => void;
    const getFileIcon = vi.fn((_filePath: string, _options: { size: 'normal' }) => new Promise<typeof image>((resolve) => { complete = resolve; }));
    const resolver = createFileTypeIconResolver({ platform: 'win32', tempDirectory: 'C:\\temp', getFileIcon });
    const first = resolver.resolve('pdf');
    const second = resolver.resolve('pdf');
    await Promise.resolve();
    expect(getFileIcon).toHaveBeenCalledTimes(1);
    expect(getFileIcon.mock.calls[0]?.[0]).toBe('C:\\temp\\line-agent-icon.pdf');
    complete(image);
    await expect(Promise.all([first, second])).resolves.toEqual([png, png]);
    await expect(resolver.resolve('pdf')).resolves.toBe(png);
  });

  it('caps native calls at four, rejects overflow without queueing, and clears on disable', async () => {
    const completions: Array<(value: typeof image) => void> = [];
    const getFileIcon = vi.fn((_filePath: string, _options: { size: 'normal' }) => new Promise<typeof image>((resolve) => completions.push(resolve)));
    const resolver = createFileTypeIconResolver({ platform: 'win32', tempDirectory: 'C:\\temp', getFileIcon });
    const pending = ['pdf', 'docx', 'zip', 'csv'].map((extension) => resolver.resolve(extension));
    await Promise.resolve();
    await expect(resolver.resolve('txt')).resolves.toBeNull();
    expect(getFileIcon).toHaveBeenCalledTimes(4);
    resolver.disable();
    expect(resolver.getStats()).toMatchObject({ cached: 0, inFlight: 4, activeNativeCalls: 4 });
    completions.forEach((complete) => complete(image));
    await expect(Promise.all(pending)).resolves.toEqual([null, null, null, null]);
    expect(resolver.getStats()).toMatchObject({ cached: 0, inFlight: 0, activeNativeCalls: 0 });
  });

  it('returns null on non-Windows, empty, malformed, and failed icons', async () => {
    const native = vi.fn(async () => image);
    const nonWindows = createFileTypeIconResolver({ platform: 'linux', tempDirectory: '/tmp', getFileIcon: native });
    await expect(nonWindows.resolve('pdf')).resolves.toBeNull();
    expect(native).not.toHaveBeenCalled();
    const invalid = createFileTypeIconResolver({ platform: 'win32', tempDirectory: 'C:\\temp', getFileIcon: async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/jpeg;base64,AA==' }) });
    await expect(invalid.resolve('pdf')).resolves.toBeNull();
    const rejected = createFileTypeIconResolver({ platform: 'win32', tempDirectory: 'C:\\temp', getFileIcon: async () => { throw new Error('shell failure'); } });
    await expect(rejected.resolve('pdf')).resolves.toBeNull();
  });

  it('keeps the completed icon cache within 64 extensions', async () => {
    const resolver = createFileTypeIconResolver({ platform: 'win32', tempDirectory: 'C:\\temp', getFileIcon: async () => image });
    for (let index = 0; index < 65; index += 1) await resolver.resolve(`x${index.toString(36)}`);
    expect(resolver.getStats().cached).toBe(64);
    await expect(resolver.resolve('x0')).resolves.toBe(png);
    expect(resolver.getStats().cached).toBe(64);
  });
});
