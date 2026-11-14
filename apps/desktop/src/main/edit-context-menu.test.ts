import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: {}, clipboard: {}, Menu: {} }));

const { buildEditContextMenuTemplate } = await import('./edit-context-menu.js');
type Params = Parameters<typeof buildEditContextMenuTemplate>[0];

const noFlags = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false };
const base: Params = { isEditable: false, editFlags: noFlags, selectionText: '', linkURL: '' };
const copyText = vi.fn();

describe('edit context menu template', () => {
  it('builds the full edit menu for an editable field and maps the edit flags', () => {
    const template = buildEditContextMenuTemplate({ ...base, isEditable: true, editFlags: { ...noFlags, canCopy: true, canPaste: true, canSelectAll: true } }, 'en', copyText);
    expect(template.map((item) => item.role ?? item.type)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll']);
    expect(template.filter((item) => item.role).map((item) => [item.role, item.enabled])).toEqual([
      ['undo', false], ['redo', false], ['cut', false], ['copy', true], ['paste', true], ['selectAll', true],
    ]);
  });

  it('shows only Copy for a read-only selection', () => {
    const template = buildEditContextMenuTemplate({ ...base, selectionText: 'hello' }, 'en', copyText);
    expect(template).toEqual([{ role: 'copy', label: 'Copy' }]);
  });

  it('shows no menu for a whitespace-only selection or no selection', () => {
    expect(buildEditContextMenuTemplate({ ...base, selectionText: ' \n\t' }, 'en', copyText)).toEqual([]);
    expect(buildEditContextMenuTemplate(base, 'en', copyText)).toEqual([]);
  });

  it('adds Copy link for an http or https link and copies the URL without opening it', () => {
    const copy = vi.fn();
    const template = buildEditContextMenuTemplate({ ...base, linkURL: 'https://example.com/a' }, 'en', copy);
    expect(template).toHaveLength(1);
    expect(template[0]?.label).toBe('Copy link');
    (template[0]?.click as () => void)();
    expect(copy).toHaveBeenCalledWith('https://example.com/a');
  });

  it('ignores links that are not http or https', () => {
    for (const linkURL of ['javascript:alert(1)', 'file:///C:/a', 'not a url']) {
      expect(buildEditContextMenuTemplate({ ...base, linkURL }, 'en', copyText)).toEqual([]);
    }
  });

  it('puts Copy link after a selection Copy item with a separator', () => {
    const template = buildEditContextMenuTemplate({ ...base, selectionText: 'x', linkURL: 'http://a.test/' }, 'en', copyText);
    expect(template.map((item) => item.role ?? item.type ?? item.label)).toEqual(['copy', 'separator', 'Copy link']);
  });

  it('uses Traditional Chinese labels', () => {
    const template = buildEditContextMenuTemplate({ ...base, isEditable: true, editFlags: noFlags, linkURL: 'https://a.test/' }, 'zh-TW', copyText);
    expect(template.filter((item) => item.label).map((item) => item.label)).toEqual(['復原', '重做', '剪下', '複製', '貼上', '全選', '複製連結']);
  });

  it('uses English labels', () => {
    const template = buildEditContextMenuTemplate({ ...base, isEditable: true, editFlags: noFlags }, 'en', copyText);
    expect(template.filter((item) => item.label).map((item) => item.label)).toEqual(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All']);
  });

  it('has non-empty labels for every locale', () => {
    for (const locale of ['en', 'zh-TW', 'ja', 'ko'] as const) {
      const template = buildEditContextMenuTemplate({ ...base, isEditable: true, editFlags: noFlags, linkURL: 'https://a.test/' }, locale, copyText);
      expect(template.filter((item) => item.type !== 'separator').every((item) => (item.label ?? '').length > 0)).toBe(true);
    }
  });
});
