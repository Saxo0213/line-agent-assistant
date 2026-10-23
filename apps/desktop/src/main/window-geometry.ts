import * as fs from 'node:fs';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowGeometry {
  bounds: WindowBounds;
  maximized: boolean;
  restored: boolean;
}

export interface WorkArea extends WindowBounds {}

interface GeometryRecord {
  version: 1;
  bounds: WindowBounds;
  maximized: boolean;
}

interface GeometryWindow {
  getBounds(): WindowBounds;
  getNormalBounds(): WindowBounds;
  isMaximized(): boolean;
  on(event: 'move' | 'resize' | 'maximize' | 'unmaximize' | 'closed', listener: () => void): this;
  removeListener(event: 'move' | 'resize' | 'maximize' | 'unmaximize' | 'closed', listener: () => void): this;
}

interface GeometryIo {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, contents: string, encoding: 'utf8'): void;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
}

const geometryIo: GeometryIo = fs;
const TITLE_BAR_REACHABLE_WIDTH = 96;
const TITLE_BAR_REACHABLE_HEIGHT = 48;

function validBounds(value: unknown): value is WindowBounds {
  if (!value || typeof value !== 'object') return false;
  const bounds = value as Partial<WindowBounds>;
  return [bounds.x, bounds.y, bounds.width, bounds.height].every((part) => typeof part === 'number' && Number.isFinite(part))
    && Number.isInteger(bounds.x) && Number.isInteger(bounds.y)
    && Number.isInteger(bounds.width) && Number.isInteger(bounds.height)
    && bounds.width! > 0 && bounds.height! > 0;
}

function intersectionArea(bounds: WindowBounds, area: WorkArea): number {
  const width = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x));
  const height = Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
  return width * height;
}

function distanceToArea(bounds: WindowBounds, area: WorkArea): number {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const areaX = area.x + area.width / 2;
  const areaY = area.y + area.height / 2;
  return (centerX - areaX) ** 2 + (centerY - areaY) ** 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function keepBoundsReachable(bounds: WindowBounds, workAreas: readonly WorkArea[]): WindowBounds {
  const validAreas = workAreas.filter((area) => validBounds(area));
  if (validAreas.length === 0) return bounds;
  const area = [...validAreas].sort((left, right) => {
    const overlap = intersectionArea(bounds, right) - intersectionArea(bounds, left);
    return overlap || distanceToArea(bounds, left) - distanceToArea(bounds, right);
  })[0]!;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  const minX = bounds.width > width ? area.x : area.x - width + Math.min(TITLE_BAR_REACHABLE_WIDTH, width);
  const maxX = bounds.width > width ? area.x + area.width - width : area.x + area.width - Math.min(TITLE_BAR_REACHABLE_WIDTH, width);
  const minY = area.y;
  const maxY = bounds.height > height ? area.y + area.height - height : area.y + area.height - Math.min(TITLE_BAR_REACHABLE_HEIGHT, height);
  return {
    x: clamp(bounds.x, minX, maxX),
    y: clamp(bounds.y, minY, maxY),
    width,
    height,
  };
}

export function readWindowGeometry(options: {
  filePath: string;
  defaultBounds: WindowBounds;
  minWidth: number;
  minHeight: number;
  workAreas: readonly WorkArea[];
  io?: GeometryIo;
}): WindowGeometry {
  let geometry: WindowGeometry = { bounds: options.defaultBounds, maximized: false, restored: false };
  try {
    const record = JSON.parse((options.io ?? geometryIo).readFileSync(options.filePath, 'utf8')) as Partial<GeometryRecord>;
    if (record.version !== 1 || !validBounds(record.bounds) || typeof record.maximized !== 'boolean') return geometry;
    if (record.bounds.width > 20_000 || record.bounds.height > 20_000) return geometry;
    geometry = {
      bounds: {
        ...record.bounds,
        width: Math.max(record.bounds.width, options.minWidth),
        height: Math.max(record.bounds.height, options.minHeight),
      },
      maximized: record.maximized,
      restored: true,
    };
  } catch {
    return geometry;
  }
  return { ...geometry, bounds: keepBoundsReachable(geometry.bounds, options.workAreas) };
}

export function createWindowGeometryPersistence(options: {
  window: GeometryWindow;
  filePath: string;
  initial: WindowGeometry;
  workAreas: () => readonly WorkArea[];
  debounceMs?: number;
  io?: GeometryIo;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const io = options.io ?? geometryIo;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  const tempPath = `${options.filePath}.tmp`;
  let snapshot = { bounds: options.initial.bounds, maximized: options.initial.maximized };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const update = () => {
    if (disposed) return;
    const maximized = options.window.isMaximized();
    const bounds = maximized ? options.window.getNormalBounds() : options.window.getBounds();
    snapshot = { bounds: keepBoundsReachable(bounds, options.workAreas()), maximized };
    if (timer) cancel(timer);
    timer = schedule(() => { timer = undefined; flush(); }, options.debounceMs ?? 250);
  };
  const onClosed = () => { flush(); dispose(); };

  function flush(): void {
    if (timer) { cancel(timer); timer = undefined; }
    if (disposed) return;
    const record: GeometryRecord = { version: 1, bounds: snapshot.bounds, maximized: snapshot.maximized };
    try {
      io.writeFileSync(tempPath, JSON.stringify(record), 'utf8');
      io.renameSync(tempPath, options.filePath);
    } catch {
      try { io.unlinkSync(tempPath); } catch { /* leave the previous record intact */ }
    }
  }

  function dispose(): void {
    if (disposed) return;
    if (timer) { cancel(timer); timer = undefined; }
    disposed = true;
    options.window.removeListener('move', update);
    options.window.removeListener('resize', update);
    options.window.removeListener('maximize', update);
    options.window.removeListener('unmaximize', update);
    options.window.removeListener('closed', onClosed);
  }

  options.window.on('move', update);
  options.window.on('resize', update);
  options.window.on('maximize', update);
  options.window.on('unmaximize', update);
  options.window.on('closed', onClosed);
  return { flush, dispose };
}
