// @vitest-environment jsdom
// Existing workflow assertions explicitly exercise the retained Traditional Chinese catalog.
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { lineMediaUrl } from '@line-agent/contracts';
import { accountAvatarRefreshed, LineMediaImage } from './LineMediaImage.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('reloads only account and own direct-chat avatar projections when their path is unchanged', () => {
  const accountId = 'account-refresh-test';
  const ownMid = `u${'d'.repeat(32)}`;
  const view = render(<>
    <LineMediaImage enabled target={{ type: 'account', accountId }} fallbackKind="person" className="avatar" alt="account" />
    <LineMediaImage enabled target={{ type: 'conversation', accountId, chatType: 'direct', chatId: ownMid }} fallbackKind="person" className="avatar" alt="own conversation" />
    <LineMediaImage enabled target={{ type: 'member', accountId, chatType: 'group', chatId: 'group-1', memberId: ownMid }} fallbackKind="person" className="avatar" alt="own member" />
    <LineMediaImage enabled target={{ type: 'conversation', accountId, chatType: 'direct', chatId: 'u-peer' }} fallbackKind="person" className="avatar" alt="peer conversation" />
    <LineMediaImage enabled target={{ type: 'member', accountId, chatType: 'group', chatId: 'group-1', memberId: 'u-peer' }} fallbackKind="person" className="avatar" alt="peer member" />
  </>);
  const before = Object.fromEntries(['account', 'own conversation', 'own member', 'peer conversation', 'peer member']
    .map((alt) => [alt, screen.getByAltText(alt)]));

  act(() => accountAvatarRefreshed(accountId, ownMid));

  for (const alt of ['account', 'own conversation', 'own member']) {
    const after = screen.getByAltText(alt);
    expect(after).not.toBe(before[alt]);
    expect(after.getAttribute('src')).toBe(before[alt]?.getAttribute('src'));
  }
  for (const alt of ['peer conversation', 'peer member']) expect(screen.getByAltText(alt)).toBe(before[alt]);
});

it('renders a fixed media URL directly and uses the existing fallback on error', async () => {
  render(<LineMediaImage enabled target={{ type: 'conversation', accountId: 'account A', chatType: 'group', chatId: 'chat/A' }}
    fallbackKind="group" className="avatar" alt="group avatar" />);
  const image = screen.getByAltText('group avatar');
  expect(image.getAttribute('src')).toBe(lineMediaUrl({ type: 'conversation', accountId: 'account A', chatType: 'group', chatId: 'chat/A' }));
  await act(async () => { image.dispatchEvent(new Event('error')); });
  expect(document.querySelector('[data-avatar-placeholder="group"]')).toBeTruthy();
  expect(screen.queryByAltText('group avatar')).toBeNull();
});

it('uses the attachment fixed URL after it enters the viewport and keeps the placeholder on error', async () => {
  let intersect!: IntersectionObserverCallback;
  class FakeIntersectionObserver {
    constructor(callback: IntersectionObserverCallback) { intersect = callback; }
    observe(target: Element) { intersect([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  render(<LineMediaImage enabled attachment={{ key: { accountId: 'account-A', chatType: 'group', chatId: 'chat-A' },
    attachmentId: '2a653934-7064-4d90-a9f0-e6e24cf4f93d' }} fallback="Image" className="inline-image" alt="image attachment" />);
  const image = screen.getByAltText('image attachment');
  expect(image.getAttribute('src')).toBe(lineMediaUrl({ type: 'attachment', accountId: 'account-A', chatType: 'group', chatId: 'chat-A', attachmentId: '2a653934-7064-4d90-a9f0-e6e24cf4f93d' }));
  await act(async () => { image.dispatchEvent(new Event('error')); });
  expect(screen.getByText('Image')).toBeTruthy();
});

it('renders the existing fallback immediately for an invalid media target', () => {
  render(<LineMediaImage enabled target={{ type: 'account', accountId: '' }} fallbackKind="person" className="avatar" alt="person avatar" />);
  expect(screen.queryByAltText('person avatar')).toBeNull();
  expect(document.querySelector('[data-avatar-placeholder="person"]')).toBeTruthy();
});
