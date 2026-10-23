import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowGeometryPersistence, readWindowGeometry, type WindowBounds } from './window-geometry.js';

const defaultBounds = { x: 0, y: 0, width: 960, height: 900 };
const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

function memoryIo(initial?: string) {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set('geometry.json', initial);
  return {
    files,
    readFileSync: (filePath: string) => {
      const value = files.get(filePath);
      if (value === undefined) throw new Error('missing file');
      return value;
    },
    writeFileSync: (filePath: string, contents: string) => { files.set(filePath, contents); },
    renameSync: (from: string, to: string) => {
      const contents = files.get(from);
      if (contents === undefined) throw new Error('missing temp file');
      files.set(to, contents);
      files.delete(from);
    },
    unlinkSync: (filePath: string) => { files.delete(filePath); },
  };
}

class FakeWindow extends EventEmitter {
  bounds: WindowBounds = { ...defaultBounds, x: 120, y: 80 };
  normalBounds: WindowBounds = this.bounds;
  maximized = false;
  getBounds() { return this.bounds; }
  getNormalBounds() { return this.normalBounds; }
  isMaximized() { return this.maximized; }
  move(bounds: WindowBounds) { this.bounds = bounds; this.normalBounds = bounds; this.emit('move'); }
  resize(bounds: WindowBounds) { this.bounds = bounds; this.normalBounds = bounds; this.emit('resize'); }
  maximize() { this.maximized = true; this.emit('maximize'); }
  unmaximize(bounds: WindowBounds) { this.maximized = false; this.bounds = bounds; this.normalBounds = bounds; this.emit('unmaximize'); }
}

afterEach(() => vi.useRealTimers());

describe('main window geometry', () => {
  it('uses existing defaults when no saved record exists', () => {
    const geometry = readWindowGeometry({ filePath: 'geometry.json', defaultBounds, minWidth: 960, minHeight: 640, workAreas: [workArea], io: memoryIo() });
    expect(geometry).toEqual({ bounds: defaultBounds, maximized: false, restored: false });
  });

  it('restores valid bounds and keeps an off-screen window reachable', () => {
    const io = memoryIo(JSON.stringify({ version: 1, bounds: { x: -3000, y: 3000, width: 1100, height: 700 }, maximized: true }));
    const geometry = readWindowGeometry({ filePath: 'geometry.json', defaultBounds, minWidth: 960, minHeight: 640, workAreas: [workArea], io });
    expect(geometry).toEqual({ bounds: { x: -1004, y: 1032, width: 1100, height: 700 }, maximized: true, restored: true });
  });

  it('shrinks oversized saved bounds before clamping them to a display', () => {
    const io = memoryIo(JSON.stringify({ version: 1, bounds: { x: -5000, y: -5000, width: 5000, height: 4000 }, maximized: false }));
    const geometry = readWindowGeometry({ filePath: 'geometry.json', defaultBounds, minWidth: 960, minHeight: 640,
      workAreas: [{ x: 0, y: 0, width: 1280, height: 720 }], io });
    expect(geometry.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  });

  it.each([
    ['corrupt JSON', '{'],
    ['unsupported version', JSON.stringify({ version: 2, bounds: defaultBounds, maximized: false })],
    ['non-finite bounds', JSON.stringify({ version: 1, bounds: { ...defaultBounds, x: null }, maximized: false })],
    ['excessive dimensions', JSON.stringify({ version: 1, bounds: { ...defaultBounds, width: 20_001 }, maximized: false })],
  ])('ignores %s and keeps the existing default', (_name, contents) => {
    const geometry = readWindowGeometry({ filePath: 'geometry.json', defaultBounds, minWidth: 960, minHeight: 640, workAreas: [workArea], io: memoryIo(contents) });
    expect(geometry).toEqual({ bounds: defaultBounds, maximized: false, restored: false });
  });

  it('coalesces move and resize writes, then flushes the latest normal bounds on close', () => {
    vi.useFakeTimers();
    const io = memoryIo();
    const window = new FakeWindow();
    const persistence = createWindowGeometryPersistence({ window, filePath: 'geometry.json', initial: { bounds: window.bounds, maximized: false, restored: false },
      workAreas: () => [workArea], debounceMs: 250, io });
    window.move({ x: 200, y: 90, width: 960, height: 800 });
    window.resize({ x: 200, y: 90, width: 1000, height: 800 });
    vi.advanceTimersByTime(249);
    expect(io.files.has('geometry.json')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(JSON.parse(io.files.get('geometry.json')!)).toMatchObject({ bounds: { x: 200, y: 90, width: 1000, height: 800 }, maximized: false });

    window.maximize();
    window.emit('closed');
    expect(JSON.parse(io.files.get('geometry.json')!)).toMatchObject({ bounds: { x: 200, y: 90, width: 1000, height: 800 }, maximized: true });
    persistence.flush();
    expect(window.listenerCount('move')).toBe(0);
  });

  it('leaves the previous record readable when atomic replacement fails', () => {
    const io = memoryIo('{"version":1,"bounds":{"x":1,"y":2,"width":960,"height":640},"maximized":false}');
    io.renameSync = () => { throw new Error('rename failed'); };
    const window = new FakeWindow();
    const persistence = createWindowGeometryPersistence({ window, filePath: 'geometry.json', initial: { bounds: { x: 300, y: 200, width: 960, height: 640 }, maximized: false, restored: false },
      workAreas: () => [workArea], io });
    persistence.flush();
    expect(io.files.get('geometry.json')).toBe('{"version":1,"bounds":{"x":1,"y":2,"width":960,"height":640},"maximized":false}');
    expect(io.files.has('geometry.json.tmp')).toBe(false);
  });
});
