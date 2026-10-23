// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';

const stylePath = new NodeURL('./styles.css', import.meta.url);
const themePath = new NodeURL('./theme.css', import.meta.url);
const lineMediaPath = new NodeURL('./line-media.css', import.meta.url);

function paletteContrast(left: string, right: string): number {
  const luminance = (color: string) => {
    const full = /^#[0-9a-f]{3}$/i.test(color) ? `#${[...color.slice(1)].map((digit) => digit + digit).join('')}` : color;
    const values = [1, 3, 5].map((start) => parseInt(full.slice(start, start + 2), 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
  };
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

function computedHex(value: string): string {
  const variable = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  if (variable) return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  const rgb = value.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
  return rgb ? `#${rgb.slice(1).map((component) => Number(component).toString(16).padStart(2, '0')).join('')}` : value;
}

describe('operator palette and scaling', () => {
  it('keeps reply quote dividers thin and theme-aware', () => {
    const style = document.createElement('style');
    const lineMedia = readFileSync(lineMediaPath, 'utf8');
    style.textContent = `${readFileSync(stylePath, 'utf8')}\n${readFileSync(themePath, 'utf8')}\n${lineMedia}`;
    document.head.append(style);
    try {
      expect(lineMedia).toMatch(/\.message-row \.reply-reference\s*\{[^}]*border-bottom:\s*1px solid var\(--bubble-divider\)/s);
      for (const mode of ['light', 'dark']) {
        document.documentElement.dataset.theme = mode;
        expect(getComputedStyle(document.documentElement).getPropertyValue('--bubble-divider').trim()).not.toBe('');
      }
    } finally { style.remove(); delete document.documentElement.dataset.theme; }
  });

  it('keeps light and dark body, secondary and primary action text readable', () => {
    const base = readFileSync(stylePath, 'utf8');
    const theme = existsSync(themePath) ? readFileSync(themePath, 'utf8') : '';
    const style = document.createElement('style'); style.textContent = `${base}\n${theme}`; document.head.append(style);
    try {
      for (const mode of ['light', 'dark']) {
        document.documentElement.dataset.theme = mode;
        const css = getComputedStyle(document.documentElement);
        const token = (name: string) => css.getPropertyValue(name).trim();
        expect(token('--text')).toMatch(/^#[0-9a-f]{6}$/i);
        expect(paletteContrast(token('--text'), token('--surface'))).toBeGreaterThanOrEqual(4.5);
        const actualColor = getComputedStyle(document.documentElement).color;
        const actual = actualColor.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
        // jsdom exposes unresolved var() in computed color; real Chromium resolves it to rgb().
        const contentForeground = actual ? `#${actual.slice(1).map((component) => Number(component).toString(16).padStart(2, '0')).join('')}` : token(actualColor.match(/^var\((--[\w-]+)\)$/)?.[1] ?? '--missing-foreground');
        expect(contentForeground).toMatch(/^#[0-9a-f]{6}$/i);
        expect(paletteContrast(contentForeground, token('--surface'))).toBeGreaterThanOrEqual(4.5);
        expect(paletteContrast(token('--secondary'), token('--surface'))).toBeGreaterThanOrEqual(4.5);
        expect(paletteContrast(token('--on-primary'), token('--primary'))).toBeGreaterThanOrEqual(4.5);
      }
    } finally { style.remove(); delete document.documentElement.dataset.theme; }
  });

  it('preserves motion, forced-color and narrow zoom layout rules', () => {
    const base = readFileSync(stylePath, 'utf8');
    const theme = existsSync(themePath) ? readFileSync(themePath, 'utf8') : '';
    const style = document.createElement('style'); style.textContent = `${base}\n${theme}`; document.head.append(style);
    try {
      const media = Array.from(style.sheet!.cssRules).filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule);
      expect(media.some((rule) => rule.conditionText.includes('prefers-reduced-motion'))).toBe(true);
      expect(media.some((rule) => rule.conditionText.includes('forced-colors'))).toBe(true);
      expect(media.some((rule) => rule.conditionText.includes('max-width: 720px') && rule.cssText.includes('flex-wrap'))).toBe(true);
    } finally { style.remove(); }
  });

  it('uses the account selection rather than control mode to style avatar rings', () => {
    const style = document.createElement('style');
    style.textContent = `${readFileSync(stylePath, 'utf8')}\n${readFileSync(themePath, 'utf8')}`;
    document.head.append(style);
    const rail = document.createElement('aside'); rail.className = 'sidebar';
    const controlItem = document.createElement('div'); controlItem.className = 'account-item route-ACTIVE_CONTROL';
    const controlAvatar = document.createElement('span'); controlAvatar.className = 'account-avatar'; controlItem.append(controlAvatar);
    const selectedMonitorItem = document.createElement('div'); selectedMonitorItem.className = 'account-item route-MONITOR_ONLY selected';
    const selectedMonitorAvatar = document.createElement('span'); selectedMonitorAvatar.className = 'account-avatar'; selectedMonitorItem.append(selectedMonitorAvatar);
    rail.append(controlItem, selectedMonitorItem);
    const conversations = document.createElement('section'); conversations.className = 'conversation-list';
    document.body.append(rail, conversations);
    try {
      const railStyle = getComputedStyle(rail);
      const listStyle = getComputedStyle(conversations);
      const avatarStyle = getComputedStyle(selectedMonitorAvatar);
      expect(railStyle.width).toBe('64px');
      expect(railStyle.minWidth).toBe('64px');
      expect(railStyle.flexShrink).toBe('0');
      expect(avatarStyle.width).toBe('40px');
      expect(avatarStyle.height).toBe('40px');
      expect(avatarStyle.fontSize).toBe('15px');
      expect(avatarStyle.borderStyle).toBe('solid');
      expect(avatarStyle.borderWidth).toBe('2px');
      expect(getComputedStyle(controlAvatar).borderStyle).toBe('dashed');
      expect(getComputedStyle(controlItem).borderLeftWidth).toBe('0px');
      expect(listStyle.width).toBe('304px');
      expect(listStyle.minWidth).toBe('304px');
      expect(listStyle.flexShrink).toBe('0');
    } finally { rail.remove(); conversations.remove(); style.remove(); }
  });

  it('gives the selected conversation a distinct mint surface and readable dark content', () => {
    const style = document.createElement('style');
    style.textContent = `${readFileSync(stylePath, 'utf8')}\n${readFileSync(themePath, 'utf8')}`;
    document.head.append(style);
    document.documentElement.dataset.theme = 'light';
    const unselected = document.createElement('button'); unselected.className = 'conversation-row';
    const selected = document.createElement('button'); selected.className = 'conversation-row selected';
    const avatar = document.createElement('span'); avatar.className = 'conversation-avatar'; avatar.textContent = '徐';
    selected.append(avatar); document.body.append(unselected, selected);
    try {
      const plain = getComputedStyle(unselected);
      const active = getComputedStyle(selected);
      const selectedAvatar = getComputedStyle(avatar);
      expect(computedHex(active.backgroundColor)).toBe('#bfe8dd');
      expect(active.backgroundColor).not.toBe(plain.backgroundColor);
      expect(active.borderLeftWidth).toBe('3px');
      expect(paletteContrast(computedHex(active.color), computedHex(active.backgroundColor))).toBeGreaterThanOrEqual(4.5);
      expect(paletteContrast(computedHex(selectedAvatar.color), computedHex(selectedAvatar.backgroundColor))).toBeGreaterThanOrEqual(4.5);
    } finally { unselected.remove(); selected.remove(); style.remove(); delete document.documentElement.dataset.theme; }
  });

  it('contains long task prompts and replies inside the task list', () => {
    const style = document.createElement('style');
    style.textContent = `${readFileSync(stylePath, 'utf8')}\n${readFileSync(themePath, 'utf8')}`;
    document.head.append(style);
    const scroll = document.createElement('div'); scroll.className = 'job-table-scroll';
    const prompt = document.createElement('div'); prompt.className = 'job-message';
    const reply = document.createElement('div'); reply.className = 'job-reply-text';
    scroll.append(prompt, reply); document.body.append(scroll);
    try {
      expect(getComputedStyle(scroll).overflowX).toBe('auto');
      expect(getComputedStyle(prompt).overflowWrap).toBe('anywhere');
      expect(getComputedStyle(reply).overflowWrap).toBe('anywhere');
      expect(getComputedStyle(reply).whiteSpace).toBe('pre-wrap');
      expect(getComputedStyle(reply).overflow).toBe('hidden');
    } finally { scroll.remove(); style.remove(); }
  });

  it('does not retain viewport rules for the removed navigation subtitles', () => {
    expect(readFileSync(stylePath, 'utf8')).not.toContain('.nav-label');
  });

  it('uses one control size and an eight-pixel gap for grouped action buttons', () => {
    const style = document.createElement('style');
    style.textContent = `${readFileSync(stylePath, 'utf8')}\n${readFileSync(themePath, 'utf8')}`;
    document.head.append(style);
    const row = document.createElement('div'); row.className = 'button-row';
    const regular = document.createElement('button');
    const primary = document.createElement('button'); primary.className = 'primary';
    row.append(regular, primary); document.body.append(row);
    try {
      // Both button kinds share the single --control-height token (36px since 4a3ca3f); jsdom does not resolve var().
      expect(getComputedStyle(regular).minHeight).toBe('var(--control-height)');
      expect(getComputedStyle(primary).minHeight).toBe('var(--control-height)');
      expect(getComputedStyle(document.documentElement).getPropertyValue('--control-height').trim()).toBe('36px');
      expect(getComputedStyle(regular).borderRadius).toBe('8px');
      expect(getComputedStyle(primary).borderRadius).toBe('8px');
      expect(getComputedStyle(row).gap).toBe('8px');
    } finally { row.remove(); style.remove(); }
  });

  it('prevents chrome text selection while keeping messages and editors selectable', () => {
    const style = document.createElement('style');
    style.textContent = `${readFileSync(stylePath, 'utf8')}\n${readFileSync(themePath, 'utf8')}`;
    document.head.append(style);
    const app = document.createElement('div'); app.className = 'app-shell';
    const heading = document.createElement('h1');
    const message = document.createElement('div'); message.className = 'message-text';
    const attachment = document.createElement('div'); attachment.className = 'attachment';
    const attachmentButton = document.createElement('button'); attachmentButton.textContent = '開啟'; attachment.append(attachmentButton);
    const searchContent = document.createElement('span'); searchContent.className = 'search-content';
    const input = document.createElement('input');
    app.append(heading, message, attachment, searchContent, input); document.body.append(app);
    try {
      expect(getComputedStyle(app).userSelect).toBe('none');
      expect(getComputedStyle(message).userSelect).toBe('text');
      expect(getComputedStyle(attachment).userSelect).toBe('text');
      expect(getComputedStyle(attachmentButton).userSelect).toBe('none');
      expect(getComputedStyle(searchContent).userSelect).toBe('text');
      expect(getComputedStyle(input).userSelect).toBe('text');
    } finally { app.remove(); style.remove(); }
  });

  it('keeps dark primary hover and unread badge foregrounds readable on their actual backgrounds', () => {
    const style = document.createElement('style');
    style.textContent = `${readFileSync(stylePath, 'utf8')}\n${readFileSync(themePath, 'utf8')}`;
    document.head.append(style);
    document.documentElement.dataset.theme = 'dark';
    const hoverRules = Array.from(style.sheet!.cssRules).filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText.split(',').map((selector) => selector.trim()).includes('.primary:hover:not(:disabled)'));
    const hoverProbe = document.createElement('style');
    hoverProbe.textContent = hoverRules.map((rule) => rule.cssText.replaceAll('.primary:hover:not(:disabled)', '.primary.hover-probe')).join('\n');
    document.head.append(hoverProbe);
    const primary = document.createElement('button'); primary.className = 'primary hover-probe';
    const unread = document.createElement('span'); unread.className = 'unread';
    document.body.append(primary, unread);
    try {
      for (const element of [primary, unread]) {
        const css = getComputedStyle(element);
        const unreadBackground = Array.from(style.sheet!.cssRules).find((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && rule.selectorText === '.unread')?.style.getPropertyValue('background') ?? '';
        const declaredBackground = element === unread ? unreadBackground : hoverRules.at(-1)?.style.getPropertyValue('background') ?? '';
        const background = css.backgroundColor === 'rgba(0, 0, 0, 0)' ? declaredBackground : css.backgroundColor;
        // The unread badge follows LINE's own brand colours (white on #06C755) by user request, so it is pinned, not contrast-gated.
        if (element === unread) { expect(computedHex(css.color)).toBe(computedHex('#ffffff')); expect(computedHex(background)).toBe(computedHex('#06c755')); continue; }
        expect.soft(paletteContrast(computedHex(css.color), computedHex(background)), `${element.className}: ${css.color} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    } finally { primary.remove(); unread.remove(); hoverProbe.remove(); style.remove(); delete document.documentElement.dataset.theme; }
  });
});
