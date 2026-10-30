import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChromeLtsmService, publicLtsmStatus } from './chrome-ltsm-service.js';
import { fakePin, MemFs } from '../../../../../packages/line-chrome/src/ltsm/mem-fs.testkit.js';

const WASM = 'FAKE-WASM-BYTES-0123456789';
const SANDBOX = 'FAKE-SANDBOX-JS-CONTENT-abcdefghijklmnop';
const pin = fakePin(WASM, SANDBOX);
const USER_DATA = 'C:\\Users\\u\\AppData\\Roaming\\LineAgent';
const LOCAL = 'C:\\Users\\u\\AppData\\Local';
const EXT = (browser: string, profile: string, version: string) =>
  `${LOCAL}\\${browser}\\User Data\\${profile}\\Extensions\\ophjlpahpchlmihnnnihgmmeilfjmjjc\\${version}`;

function service(fs: MemFs): ChromeLtsmService {
  return new ChromeLtsmService({ userDataDir: USER_DATA, env: { LOCALAPPDATA: LOCAL }, fs, path: win32, pin });
}

describe('ChromeLtsmService', () => {
  it('uses <userData>\\line-chrome\\ltsm as the store root handed to workers', () => {
    expect(service(new MemFs()).rootDir).toBe(`${USER_DATA}\\line-chrome\\ltsm`);
  });

  it('reports missing, then available after an automatic install from a Chrome profile', async () => {
    const fs = new MemFs();
    const ltsm = service(fs);
    expect(await ltsm.status()).toEqual({ kind: 'missing', required: '3.7.2' });
    const dir = EXT('Google\\Chrome', 'Profile 2', '3.7.2_0');
    fs.addFile(`${dir}\\x\\ltsm.wasm`, WASM);
    fs.addFile(`${dir}\\x\\ltsmSandbox.js`, SANDBOX);
    const result = await ltsm.detectAndInstall();
    expect(result).toEqual({ kind: 'installed', status: { kind: 'available', version: '3.7.2' }, source: { browser: 'chrome', profile: 'Profile 2' } });
    expect(await ltsm.status()).toEqual({ kind: 'available', version: '3.7.2' });
    expect(fs.files.has(`${USER_DATA}\\line-chrome\\ltsm\\3.7.2\\ltsm.wasm`)).toBe(true);
  });

  it('finds the extension under Edge too', async () => {
    const fs = new MemFs();
    const dir = EXT('Microsoft\\Edge', 'Default', '3.7.2_0');
    fs.addFile(`${dir}\\ltsm.wasm`, WASM);
    fs.addFile(`${dir}\\ltsmSandbox.js`, SANDBOX);
    const result = await service(fs).detectAndInstall();
    expect(result).toMatchObject({ kind: 'installed', source: { browser: 'edge', profile: 'Default' } });
  });

  it('lists the detected versions when only another version is installed', async () => {
    const fs = new MemFs();
    fs.addDir(EXT('Google\\Chrome', 'Default', '3.8.0_0'));
    fs.addDir(EXT('Microsoft\\Edge', 'Default', '3.6.9_0'));
    const result = await service(fs).detectAndInstall();
    expect(result).toEqual({ kind: 'wrong-version', required: '3.7.2', detected: [
      { browser: 'chrome', profile: 'Default', version: '3.8.0' },
      { browser: 'edge', profile: 'Default', version: '3.6.9' },
    ] });
    expect(await service(fs).status()).toEqual({ kind: 'missing', required: '3.7.2' });
  });

  it('reports not-found when no extension is installed', async () => {
    expect(await service(new MemFs()).detectAndInstall()).toEqual({ kind: 'not-found', required: '3.7.2' });
  });

  it('installs from a manually chosen folder with the same md5 check, and rejects a changed file', async () => {
    const fs = new MemFs();
    fs.addFile('D:\\picked\\ltsm.wasm', 'TAMPERED-WASM-CONTENT-0123456');
    fs.addFile('D:\\picked\\ltsmSandbox.js', SANDBOX);
    const ltsm = service(fs);
    const rejected = await ltsm.installFromFolder('D:\\picked');
    expect(rejected.kind).toBe('wrong-version');
    expect(await ltsm.status()).toEqual({ kind: 'missing', required: '3.7.2' });
    fs.addFile('D:\\picked\\ltsm.wasm', WASM);
    expect(await ltsm.installFromFolder('D:\\picked')).toEqual({ kind: 'installed', status: { kind: 'available', version: '3.7.2' },
      source: { browser: 'manual', profile: '' } });
  });

  it('turns a damaged stored copy into corrupt, without paths', async () => {
    const fs = new MemFs();
    const dir = EXT('Google\\Chrome', 'Default', '3.7.2_0');
    fs.addFile(`${dir}\\ltsm.wasm`, WASM);
    fs.addFile(`${dir}\\ltsmSandbox.js`, SANDBOX);
    const ltsm = service(fs);
    await ltsm.detectAndInstall();
    fs.addFile(`${USER_DATA}\\line-chrome\\ltsm\\3.7.2\\ltsm.wasm`, 'DAMAGED');
    const status = await ltsm.status();
    expect(status.kind).toBe('corrupt');
    expect(JSON.stringify(status)).not.toContain(USER_DATA);
  });

  it('publicLtsmStatus drops the store directory', () => {
    expect(publicLtsmStatus({ kind: 'available', version: '3.7.2', dir: 'C:\\secret' })).toEqual({ kind: 'available', version: '3.7.2' });
    expect(publicLtsmStatus({ kind: 'missing', required: '3.7.2', dir: 'C:\\secret' })).toEqual({ kind: 'missing', required: '3.7.2' });
  });
});
