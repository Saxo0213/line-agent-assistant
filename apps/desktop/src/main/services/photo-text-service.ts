import type { ForwardOcrImage, ForwardOcrWork, ScheduleForwardRepository } from '@line-agent/database';
import type { PhotoOcrEngine } from './photo-ocr.js';
import { classifyPhotoText, combinePhotoVerdicts, type PhotoTextVerdict } from './photo-text-match.js';

/** One pass reads at most this many work rows. */
export const PHOTO_TEXT_ROWS_PER_PASS = 5;
export const PHOTO_TEXT_INTERVAL_MS = 2_000;
/** A photo that is still not downloaded after this time is given up. */
export const PHOTO_TEXT_DOWNLOAD_WAIT_MS = 15 * 60_000;
const TERMINAL_STATUSES = ['ready', 'failed', 'expired', 'unavailable'];
const UNNAMED_CHAT = '未命名聊天室';
const NOTICE = '【照片文字比對】';
const TITLE_MAX = 100;

type PhotoTextStore = Pick<ScheduleForwardRepository, 'pendingOcrWork' | 'ocrImages' | 'finishOcr'>;

const taipeiTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function noticeSuffix(work: ForwardOcrWork): string {
  return `${clip(oneLine(work.sourceTitle), TITLE_MAX) || UNNAMED_CHAT}｜${clip(oneLine(work.senderName), TITLE_MAX)}｜${taipeiTime.format(work.occurredAt)}`;
}
/** The text part of a photo that matched. */
export function photoHitText(work: ForwardOcrWork, keywords: readonly string[]): string {
  return `${NOTICE}${noticeSuffix(work)}｜命中：${keywords.join('、')}`;
}
/** The text part of a photo that could not be compared. */
export function photoUnavailableText(work: ForwardOcrWork, reason: 'download' | 'ocr'): string {
  return `${NOTICE}${reason === 'download' ? '無法下載照片' : '照片文字辨識失敗'}，未比對：${noticeSuffix(work)}`;
}

/**
 * Reads the text of the photos of capture rows that wait for OCR (ocr_state = 'pending') and writes the result:
 * hit -> the photos are forwarded; unclear -> the Agent copy checks them; miss -> nothing. No network, no LLM, and the
 * photo text is never stored or logged: only keywords and codes reach the database.
 */
export class PhotoTextService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private flight: Promise<void> | undefined;
  private readonly controller = new AbortController();
  constructor(private readonly options: {
    store: PhotoTextStore;
    ocr: PhotoOcrEngine;
    /** The absolute path of a stored attachment inside the attachment root; null when it is not a managed file. */
    resolveImage(relativePath: string): Promise<string | null>;
    publish(): void;
    onError(error: unknown): void;
    now?(): number;
  }) {}
  start(): void {
    this.timer = setInterval(() => this.wake(), PHOTO_TEXT_INTERVAL_MS);
    this.timer.unref();
    this.wake();
  }
  wake(): void {
    if (this.flight || this.controller.signal.aborted) return;
    this.flight = this.drain().catch((error) => this.options.onError(error)).finally(() => { this.flight = undefined; });
  }
  async drain(): Promise<void> {
    const rows = await this.options.store.pendingOcrWork(PHOTO_TEXT_ROWS_PER_PASS);
    for (const work of rows) {
      if (this.controller.signal.aborted) return;
      try { await this.process(work); } catch (error) { this.options.onError(error); }
    }
    if (rows.length > 0) this.options.publish();
  }
  private async process(work: ForwardOcrWork): Promise<void> {
    const { store, ocr, resolveImage } = this.options;
    const images = await store.ocrImages(work);
    const waiting = images.some((image) => !TERMINAL_STATUSES.includes(image.status));
    if (waiting && (this.options.now?.() ?? Date.now()) - work.createdAt.getTime() < PHOTO_TEXT_DOWNLOAD_WAIT_MS) return;
    const ready = images.filter((image): image is ForwardOcrImage & { relativePath: string } => image.status === 'ready' && image.relativePath !== null);
    if (ready.length === 0) {
      const detail = images.length === 0 ? 'no_image' : waiting ? 'download_timeout' : images[0]!.status;
      await store.finishOcr(work.workId, { state: 'unavailable', detail, text: photoUnavailableText(work, 'download') });
      return;
    }
    const verdicts: PhotoTextVerdict[] = [];
    let failure: string | null = null;
    for (const image of ready) {
      if (this.controller.signal.aborted) return;
      const path = await resolveImage(image.relativePath).catch(() => null);
      const result = path === null ? { ok: false as const, code: 'OCR_FILE_UNREADABLE' } : await ocr.recognize(path);
      if (!result.ok) { failure ??= result.code; continue; }
      verdicts.push(classifyPhotoText(result.passes.map((pass) => pass.text), work.keywords));
    }
    if (this.controller.signal.aborted) return;
    if (verdicts.length === 0) {
      await store.finishOcr(work.workId, { state: 'unavailable', detail: failure ?? 'OCR_FAILED', text: photoUnavailableText(work, 'ocr') });
      return;
    }
    const verdict = combinePhotoVerdicts(verdicts);
    if (verdict.state === 'hit') {
      await store.finishOcr(work.workId, { state: 'hit', keywords: verdict.keywords,
        images: ready.map((image) => ({ attachmentId: image.attachmentId, name: image.name })), text: photoHitText(work, verdict.keywords) });
    } else if (verdict.state === 'unclear') await store.finishOcr(work.workId, { state: 'unclear', keywords: verdict.keywords });
    else await store.finishOcr(work.workId, { state: 'miss' });
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    // Stop the OCR child first, so a running request ends at once and the pass can finish.
    await this.options.ocr.stop();
    if (this.flight) await this.flight;
  }
}
