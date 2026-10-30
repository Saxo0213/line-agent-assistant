// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_BLOCK_REASONS, type GeneratedPreview } from '@line-agent/contracts';
import { FileAttachmentCard } from './FileAttachmentCard.js';
import { LocaleProvider, type LocaleState } from './locale-context.js';
import { attachmentBlockReasonKey, desktopTextFor, generatedPreviewFor } from './desktop-i18n.js';
import { ENGLISH_DESKTOP_COPY } from '../desktop-copy.js';
import type { DesktopApi } from '../preload/api.js';

afterEach(() => { cleanup(); });

const state = (effectiveLocale: LocaleState['effectiveLocale']): LocaleState => ({ status: 'loaded', effectiveLocale, preference: effectiveLocale,
  busy: false, error: null, retry() {}, retryRestart() {} } as unknown as LocaleState);
const api = { resolveFileTypeIcon: async () => null } as unknown as DesktopApi;

function card(locale: LocaleState['effectiveLocale'], attachment: Partial<React.ComponentProps<typeof FileAttachmentCard>['attachment']>) {
  return render(<LocaleProvider value={state(locale)}><FileAttachmentCard
    attachment={{ id: 'a', kind: 'file', name: 'report.pdf', sizeBytes: 1, status: 'queued', ...attachment }}
    api={api} onDownload={() => undefined} onOpen={() => undefined} /></LocaleProvider>);
}

describe('queued attachment cause text', () => {
  it('shows the cause on the card in place of the plain not downloaded text', () => {
    card('zh-TW', { blockReason: 'ATTACHMENT_WORKER_UNAVAILABLE' });
    expect(screen.getByText('需登入 Agent 帳號才能下載')).toBeTruthy();
    expect(screen.queryByText('尚未下載')).toBeNull();
    cleanup();
    card('zh-TW', { blockReason: 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE' });
    expect(screen.getByText('外部監控來源無法下載')).toBeTruthy();
    cleanup();
    card('zh-TW', { blockReason: 'ATTACHMENT_WORKER_NOT_READY' });
    expect(screen.getByText('Agent 連線未就緒')).toBeTruthy();
  });

  it('keeps the plain text for a queued card without a reason and for any other status', () => {
    card('zh-TW', {});
    expect(screen.getByText('尚未下載')).toBeTruthy();
    cleanup();
    card('zh-TW', { status: 'downloading', blockReason: 'ATTACHMENT_WORKER_NOT_READY' });
    expect(screen.getByText('下載中')).toBeTruthy();
    cleanup();
    card('zh-TW', { status: 'expired', blockReason: 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE' });
    expect(screen.getByText('下載重試期限已過')).toBeTruthy();
  });

  it('has en, ja and ko copy for each reason, different from the plain text', () => {
    for (const locale of ['en', 'zh-TW', 'ja', 'ko'] as const) {
      const plain = desktopTextFor(locale, 'notDownloaded');
      const texts = ATTACHMENT_BLOCK_REASONS.map((reason) => desktopTextFor(locale, attachmentBlockReasonKey(reason)));
      expect(new Set(texts).size, locale).toBe(3);
      for (const text of texts) { expect(text, locale).toBeTruthy(); expect(text, locale).not.toBe(plain); }
    }
    expect(desktopTextFor('en', 'attachmentBlockWorkerUnavailable')).toBe(ENGLISH_DESKTOP_COPY.attachmentBlockWorkerUnavailable);
  });

  it('shows the cause in the chat list preview for a queued attachment', () => {
    const display = (overrides: Partial<GeneratedPreview>): GeneratedPreview => ({ kind: 'file', name: 'report.pdf', status: 'queued', ...overrides });
    expect(generatedPreviewFor('zh-TW', display({ blockReason: 'ATTACHMENT_WORKER_UNAVAILABLE' }), 'x')).toBe('report.pdf (需登入 Agent 帳號才能下載)');
    expect(generatedPreviewFor('zh-TW', display({ blockReason: 'EXTERNAL_SOURCE_DOWNLOAD_UNAVAILABLE' }), 'x')).toBe('report.pdf (外部監控來源無法下載)');
    expect(generatedPreviewFor('zh-TW', display({ blockReason: 'ATTACHMENT_WORKER_NOT_READY' }), 'x')).toBe('report.pdf (Agent 連線未就緒)');
    expect(generatedPreviewFor('zh-TW', display({}), 'x')).toBe('report.pdf (尚未下載)');
    expect(generatedPreviewFor('zh-TW', display({ status: 'failed', blockReason: 'ATTACHMENT_WORKER_NOT_READY' }), 'x')).toBe('report.pdf (下載失敗)');
    expect(generatedPreviewFor('ja', display({ blockReason: 'ATTACHMENT_WORKER_NOT_READY' }), 'x'))
      .toBe(`report.pdf (${desktopTextFor('ja', 'attachmentBlockWorkerNotReady')})`);
  });
});
