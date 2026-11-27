import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';

/** One recognition of a photo; `rotation` is the clockwise turn (0, 90, 180, 270) that was applied before the OCR run. */
export interface PhotoOcrPass { rotation: number; text: string }
export type PhotoOcrResult = { ok: true; width: number; height: number; passes: PhotoOcrPass[] } | { ok: false; code: string };
export interface PhotoOcrEngine {
  /** Reads the text of one image file with the Windows OCR engine of this computer. Never rejects; an error is a result code. */
  recognize(absolutePath: string): Promise<PhotoOcrResult>;
  /** Stops the child process, if any. A later recognize() starts a new one. */
  stop(): Promise<void>;
}
export type PhotoOcrSpawn = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export const PHOTO_OCR_TIMEOUT_MS = 30_000;

/**
 * The PowerShell 5.1 script of the OCR child. It reads one JSON line per request from stdin
 * ({"id":n,"path":"..."}) and writes one JSON line per answer to stdout. Non-ASCII characters of an answer are written as JSON unicode escapes,
 * so the answer does not depend on a console code page. The script never writes the photo text or the path to any other place.
 */
export const PHOTO_OCR_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(); $task.Result }
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
$engine = $null
function Send($obj) {
  $json = ConvertTo-Json $obj -Compress -Depth 6
  $json = [regex]::Replace($json, '[^ -~]', { param($m) [string][char]92 + 'u' + ([int][char]$m.Value).ToString('x4') })
  [Console]::Out.WriteLine($json); [Console]::Out.Flush()
}
$cjkPattern = '[' + [char]0x3400 + '-' + [char]0x9fff + ']'
function Cjk($t) { ([regex]::Matches($t, $cjkPattern)).Count }
function Read-Bitmap($bitmap) {
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  ($result.Lines | ForEach-Object { $_.Text }) -join [Environment]::NewLine
}
function Transformed($decoder, $rotation, $factor) {
  $tf = New-Object Windows.Graphics.Imaging.BitmapTransform
  $tf.Rotation = $rotation
  if ($factor -ne 1) {
    $tf.ScaledWidth = [uint32]($decoder.PixelWidth * $factor); $tf.ScaledHeight = [uint32]($decoder.PixelHeight * $factor)
    $tf.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
  }
  Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $tf, [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $id = 0
  $stage = 'OCR_FAILED'
  try {
    $req = $line | ConvertFrom-Json
    $id = [int]$req.id
    if ($null -eq $engine) {
      $stage = 'OCR_LANGUAGE_UNAVAILABLE'
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hant-TW'))
      if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
      if ($null -eq $engine) { throw 'no engine' }
    }
    $stage = 'OCR_FILE_UNREADABLE'
    $bytes = [System.IO.File]::ReadAllBytes([string]$req.path)
    $stage = 'OCR_DECODE_FAILED'
    $ms = New-Object System.IO.MemoryStream(,$bytes)
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $w = [int]$bitmap.PixelWidth; $h = [int]$bitmap.PixelHeight
    $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if ([Math]::Max($w, $h) -gt $max) { $stage = 'OCR_IMAGE_TOO_LARGE'; throw 'too large' }
    $stage = 'OCR_FAILED'
    if ($bitmap.BitmapPixelFormat -ne [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8) { $bitmap = Transformed $decoder ([Windows.Graphics.Imaging.BitmapRotation]::None) 1 }
    $text = Read-Bitmap $bitmap
    if ([Math]::Max($w, $h) -lt 1600 -and [Math]::Max($w, $h) * 2 -le $max) {
      try {
        $scaled = Read-Bitmap (Transformed $decoder ([Windows.Graphics.Imaging.BitmapRotation]::None) 2)
        if ((Cjk $scaled) -gt (Cjk $text)) { $text = $scaled }
      } catch { }
    }
    $passes = @(@{ rotation = 0; text = $text })
    if ((Cjk $text) -lt 8) {
      foreach ($turn in @(@(90, 'Clockwise90Degrees'), @(180, 'Clockwise180Degrees'), @(270, 'Clockwise270Degrees'))) {
        try {
          $rotated = Transformed $decoder ([Windows.Graphics.Imaging.BitmapRotation]::($turn[1])) 1
          $passes += @{ rotation = $turn[0]; text = (Read-Bitmap $rotated) }
        } catch { }
      }
    }
    Send @{ id = $id; ok = $true; width = $w; height = $h; passes = $passes }
  } catch {
    Send @{ id = $id; ok = $false; code = $stage }
  }
}
`;

/** UTF-16LE base64, the form that powershell.exe -EncodedCommand reads. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** JSON of one request; characters above ASCII are escaped, so the script reads the path without a code page. */
export function ocrRequestLine(id: number, absolutePath: string): string {
  return `${JSON.stringify({ id, path: absolutePath }).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

function parseAnswer(line: string): { id: number; result: PhotoOcrResult } | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (typeof value !== 'object' || value === null) return null;
  const answer = value as Record<string, unknown>;
  if (typeof answer.id !== 'number') return null;
  if (answer.ok === true) {
    const passes = (Array.isArray(answer.passes) ? answer.passes : [answer.passes]).filter((pass): pass is { rotation: number; text: unknown } =>
      typeof pass === 'object' && pass !== null && typeof (pass as { rotation?: unknown }).rotation === 'number')
      .map((pass) => ({ rotation: pass.rotation, text: typeof pass.text === 'string' ? pass.text : '' }));
    return { id: answer.id, result: { ok: true, width: Number(answer.width) || 0, height: Number(answer.height) || 0, passes } };
  }
  return { id: answer.id, result: { ok: false, code: typeof answer.code === 'string' && /^[A-Z_]{1,40}$/.test(answer.code) ? answer.code : 'OCR_FAILED' } };
}

/**
 * One long-lived powershell.exe child, started on the first request, one request at a time. A timeout kills the child
 * (a later request starts a new one). Nothing about a photo is logged: not the path, not the text.
 */
export function createPhotoOcrEngine(options: { spawn?: PhotoOcrSpawn; timeoutMs?: number } = {}): PhotoOcrEngine {
  const spawn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams);
  const timeoutMs = options.timeoutMs ?? PHOTO_OCR_TIMEOUT_MS;
  let child: ChildProcessWithoutNullStreams | undefined;
  let nextId = 1;
  let waiting: { id: number; owner: ChildProcessWithoutNullStreams; finish(result: PhotoOcrResult): void } | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let stopped = false;

  const start = (): ChildProcessWithoutNullStreams => {
    const started = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShellCommand(PHOTO_OCR_SCRIPT)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    started.stdout.setEncoding('utf8');
    started.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const answer = parseAnswer(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
        if (answer && waiting && waiting.id === answer.id) waiting.finish(answer.result);
      }
    });
    started.stderr.on('data', () => undefined);
    started.stdin.on('error', () => undefined);
    const ended = (): void => {
      if (child === started) child = undefined;
      // Only the request of this child fails; a dropped child must not end the request of its successor.
      if (waiting && waiting.owner === started) waiting.finish({ ok: false, code: 'OCR_ENGINE_EXITED' });
    };
    started.on('exit', ended);
    started.on('error', ended);
    return started;
  };

  const run = (absolutePath: string): Promise<PhotoOcrResult> => new Promise<PhotoOcrResult>((resolve) => {
    if (stopped) { resolve({ ok: false, code: 'OCR_ENGINE_STOPPED' }); return; }
    const id = nextId++;
    let current: ChildProcessWithoutNullStreams;
    try { current = child ?? (child = start()); } catch { child = undefined; resolve({ ok: false, code: 'OCR_ENGINE_START_FAILED' }); return; }
    const timer = setTimeout(() => {
      // A stuck request: drop the child so the next request starts a clean one.
      if (child === current) child = undefined;
      current.kill();
      entry.finish({ ok: false, code: 'OCR_TIMEOUT' });
    }, timeoutMs);
    const entry = {
      id,
      owner: current,
      finish: (result: PhotoOcrResult) => {
        clearTimeout(timer);
        if (waiting === entry) waiting = undefined;
        resolve(result);
      },
    };
    waiting = entry;
    try { current.stdin.write(ocrRequestLine(id, absolutePath)); } catch { entry.finish({ ok: false, code: 'OCR_ENGINE_EXITED' }); }
  });

  return {
    recognize(absolutePath) {
      const result = tail.then(() => run(absolutePath));
      tail = result.catch(() => undefined);
      return result;
    },
    async stop() {
      stopped = true;
      const current = child;
      child = undefined;
      if (waiting) waiting.finish({ ok: false, code: 'OCR_ENGINE_STOPPED' });
      if (current) { try { current.stdin.end(); } catch { /* the child is already gone */ } current.kill(); }
    },
  };
}
