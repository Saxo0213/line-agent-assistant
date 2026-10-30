import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverLtsmAssets, verifyManualFolder } from './discovery.js';
import { fakePin, MemFs } from './mem-fs.testkit.js';
import { LTSM_PINS, requiredLtsmPin } from './pins.js';

const LOCAL = 'C:\\Users\\u\\AppData\\Local';
const EXT = 'ophjlpahpchlmihnnnihgmmeilfjmjjc';
const WASM = 'FAKE-WASM-BYTES-0123456789';
const SANDBOX = 'FAKE-SANDBOX-JS-CONTENT-abcdefghijklmnop';
const pin = fakePin(WASM, SANDBOX);
const env = { LOCALAPPDATA: LOCAL };

function ext(browser: 'chrome' | 'edge', profile: string, version: string): string {
  const root = browser === 'chrome' ? 'Google\\Chrome' : 'Microsoft\\Edge';
  return `${LOCAL}\\${root}\\User Data\\${profile}\\Extensions\\${EXT}\\${version}`;
}

function install(fs: MemFs, dir: string, rel = ''): void {
  const prefix = rel ? `${dir}\\${rel}\\` : `${dir}\\`;
  fs.addFile(`${prefix}ltsm.wasm`, WASM);
  fs.addFile(`${prefix}ltsmSandbox.js`, SANDBOX);
}

const options = (fs: MemFs) => ({ env, fs, path: win32, pin });

describe('pins', () => {
  it('pins the 3.7.2 assets by md5 and size', () => {
    const p = requiredLtsmPin();
    expect(p.version).toBe('3.7.2');
    expect(p.assets).toEqual([
      { fileName: 'ltsm.wasm', md5: 'a7948ea39df1f3ae4cc9cf3ab2811da5', size: 2_254_973 },
      { fileName: 'ltsmSandbox.js', md5: '4769d3fd80c6dcc637bcd8153ba6c087', size: 2_420_558 },
    ]);
    expect(LTSM_PINS.map((entry) => entry.version)).toEqual(['3.7.2']);
  });
});

describe('discoverLtsmAssets', () => {
  it('finds the right version across profiles and browsers, locating files by size then md5', async () => {
    const fs = new MemFs();
    install(fs, ext('chrome', 'Default', '3.7.1_0'), 'ltsm'); // wrong version folder
    install(fs, ext('chrome', 'Profile 2', '3.7.2_0'), 'a\\b');
    install(fs, ext('edge', 'Default', '3.7.2_0'), 'ltsm');
    // decoys: right size, wrong content, and a node_modules copy that must be skipped
    fs.addFile(`${ext('chrome', 'Profile 2', '3.7.2_0')}\\node_modules\\x\\ltsm.wasm`, WASM);
    fs.addFile(`${ext('chrome', 'Profile 2', '3.7.2_0')}\\other.bin`, 'Y'.repeat(WASM.length));

    const result = await discoverLtsmAssets(options(fs));
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.match.browser).toBe('chrome');
    expect(result.match.profile).toBe('Profile 2');
    expect(result.match.extensionVersion).toBe('3.7.2');
    expect(result.match.extensionDir).toBe(ext('chrome', 'Profile 2', '3.7.2_0'));
    expect(result.match.assets.map((a) => [a.fileName, a.relativePath])).toEqual([
      ['ltsm.wasm', 'a/b/ltsm.wasm'],
      ['ltsmSandbox.js', 'a/b/ltsmSandbox.js'],
    ]);
  });

  it('prefers the Default profile and Chrome over later candidates', async () => {
    const fs = new MemFs();
    install(fs, ext('chrome', 'Profile 1', '3.7.2_0'));
    install(fs, ext('chrome', 'Default', '3.7.2_0'));
    install(fs, ext('edge', 'Default', '3.7.2_0'));
    const result = await discoverLtsmAssets(options(fs));
    expect(result.kind === 'found' && [result.match.browser, result.match.profile]).toEqual(['chrome', 'Default']);
  });

  it('falls back to Edge when Chrome has nothing', async () => {
    const fs = new MemFs();
    install(fs, ext('edge', 'Profile 3', '3.7.2_1'));
    const result = await discoverLtsmAssets(options(fs));
    expect(result.kind === 'found' && [result.match.browser, result.match.profile]).toEqual(['edge', 'Profile 3']);
  });

  it('reports detected versions and the required one when only another version is installed', async () => {
    const fs = new MemFs();
    install(fs, ext('chrome', 'Default', '3.7.1_0'));
    install(fs, ext('edge', 'Default', '3.8.0_0'));
    const result = await discoverLtsmAssets(options(fs));
    expect(result.kind).toBe('wrong-version');
    if (result.kind !== 'wrong-version') return;
    expect(result.required).toBe('3.7.2');
    expect(result.detected.map((d) => [d.browser, d.extensionVersion, d.reason])).toEqual([
      ['chrome', '3.7.1', 'version-mismatch'],
      ['edge', '3.8.0', 'version-mismatch'],
    ]);
  });

  it('reports an md5 mismatch for a 3.7.2 folder whose files differ (same size)', async () => {
    const fs = new MemFs();
    const dir = ext('chrome', 'Default', '3.7.2_0');
    fs.addFile(`${dir}\\ltsm.wasm`, 'X'.repeat(WASM.length));
    fs.addFile(`${dir}\\ltsmSandbox.js`, SANDBOX);
    const result = await discoverLtsmAssets(options(fs));
    expect(result.kind).toBe('wrong-version');
    if (result.kind !== 'wrong-version') return;
    expect(result.detected).toEqual([
      expect.objectContaining({ extensionVersion: '3.7.2', reason: 'md5-mismatch', mismatchedFiles: ['ltsm.wasm'] }),
    ]);
  });

  it('reports not-found when nothing is installed or LOCALAPPDATA is unset', async () => {
    const fs = new MemFs();
    fs.addDir(`${LOCAL}\\Google\\Chrome\\User Data\\Default\\Extensions\\someotherextension\\1.0_0`);
    expect(await discoverLtsmAssets(options(fs))).toEqual({ kind: 'not-found', required: '3.7.2', searched: [] });
    expect(await discoverLtsmAssets({ env: {}, fs, path: win32, pin })).toMatchObject({ kind: 'not-found' });
  });

  it('does not read files whose size matches no pin', async () => {
    const fs = new MemFs();
    const dir = ext('chrome', 'Default', '3.7.2_0');
    install(fs, dir, 'lib');
    fs.addFile(`${dir}\\big.bin`, 'Z'.repeat(5000));
    fs.addFile(`${dir}\\manifest.json`, '{}');
    await discoverLtsmAssets(options(fs));
    expect(fs.reads.every((p) => /ltsm(Sandbox)?\.(wasm|js)$/.test(p))).toBe(true);
  });

  it('searches a bounded depth', async () => {
    const fs = new MemFs();
    install(fs, ext('chrome', 'Default', '3.7.2_0'), 'a\\b\\c\\d'); // depth 4 below the version folder: found
    expect((await discoverLtsmAssets(options(fs))).kind).toBe('found');
    const deep = new MemFs();
    install(deep, ext('chrome', 'Default', '3.7.2_0'), 'a\\b\\c\\d\\e'); // depth 5: not searched
    const result = await discoverLtsmAssets(options(deep));
    expect(result.kind === 'wrong-version' && result.detected[0]?.reason).toBe('assets-missing');
  });
});

describe('verifyManualFolder', () => {
  it('accepts a folder that passes the same check', async () => {
    const fs = new MemFs();
    install(fs, 'D:\\picked', 'x');
    const result = await verifyManualFolder('D:\\picked', options(fs));
    expect(result.kind === 'found' && result.match.browser).toBe('manual');
    expect(result.kind === 'found' && result.match.extensionVersion).toBe('3.7.2');
  });

  it('rejects a folder with a mismatching file and reports the manifest version', async () => {
    const fs = new MemFs();
    fs.addFile('D:\\picked\\ltsm.wasm', 'X'.repeat(WASM.length));
    fs.addFile('D:\\picked\\ltsmSandbox.js', SANDBOX);
    fs.addFile('D:\\picked\\manifest.json', JSON.stringify({ version: '3.9.0' }));
    const result = await verifyManualFolder('D:\\picked', options(fs));
    expect(result.kind).toBe('wrong-version');
    if (result.kind !== 'wrong-version') return;
    expect(result.required).toBe('3.7.2');
    expect(result.detected[0]).toMatchObject({ browser: 'manual', extensionVersion: '3.9.0', reason: 'md5-mismatch' });
  });

  it('rejects an empty folder', async () => {
    const fs = new MemFs();
    fs.addDir('D:\\empty');
    const result = await verifyManualFolder('D:\\empty', options(fs));
    expect(result.kind === 'wrong-version' && result.detected[0]?.reason).toBe('assets-missing');
  });
});
