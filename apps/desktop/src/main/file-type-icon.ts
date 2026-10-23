import path from 'node:path';

const BLOCKED_EXTENSIONS = new Set(['exe', 'dll', 'ico', 'com', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'jse', 'wsf', 'wsh', 'scr', 'msi', 'msp', 'hta', 'cpl', 'sh']);
const MAX_CACHE = 64;
const MAX_IN_FLIGHT = 4;

export function isSafeFileIconExtension(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]{1,12}$/.test(value) && !BLOCKED_EXTENSIONS.has(value);
}

export type FileTypeIconNativeImage = { isEmpty(): boolean; toDataURL(): string };
export type FileTypeIconResolverOptions = {
  platform: string;
  tempDirectory: string;
  getFileIcon(filePath: string, options: { size: 'normal' }): Promise<FileTypeIconNativeImage>;
};

export function createFileTypeIconResolver(options: FileTypeIconResolverOptions) {
  const cache = new Map<string, string | null>();
  const inFlight = new Map<string, Promise<string | null>>();
  let activeNativeCalls = 0;
  let disabled = false;

  const remember = (extension: string, value: string | null) => {
    cache.delete(extension);
    cache.set(extension, value);
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  };

  return {
    resolve(extension: string): Promise<string | null> {
      if (disabled || options.platform !== 'win32' || !isSafeFileIconExtension(extension)) return Promise.resolve(null);
      if (cache.has(extension)) {
        const value = cache.get(extension)!;
        cache.delete(extension); cache.set(extension, value);
        return Promise.resolve(value);
      }
      const pending = inFlight.get(extension);
      if (pending) return pending;
      if (activeNativeCalls >= MAX_IN_FLIGHT) return Promise.resolve(null);

      activeNativeCalls += 1;
      const task = Promise.resolve().then(async () => {
        const syntheticPath = path.join(options.tempDirectory, `line-agent-icon.${extension}`);
        const image = await options.getFileIcon(syntheticPath, { size: 'normal' });
        if (disabled || image.isEmpty()) return null;
        const dataUrl = image.toDataURL();
        return dataUrl.startsWith('data:image/png;base64,') && dataUrl.length <= 128_000 ? dataUrl : null;
      }).catch(() => null).then((value) => {
        if (!disabled) remember(extension, value);
        return disabled ? null : value;
      }).finally(() => {
        activeNativeCalls -= 1;
        inFlight.delete(extension);
      });
      inFlight.set(extension, task);
      return task;
    },
    disable() {
      disabled = true;
      cache.clear();
    },
    getStats() { return { cached: cache.size, inFlight: inFlight.size, activeNativeCalls }; },
  };
}
