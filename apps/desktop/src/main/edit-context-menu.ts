import { BrowserWindow, clipboard, Menu } from 'electron';
import type { Locale } from '../locale.js';
import { getEffectiveLocale } from './locale-settings.js';

export interface EditContextMenuParams {
  isEditable: boolean;
  editFlags: { canUndo: boolean; canRedo: boolean; canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
  selectionText: string;
  linkURL: string;
}

type LabelKey = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'copyLink';

const LABELS: Record<Locale, Record<LabelKey, string>> = {
  en: { undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All', copyLink: 'Copy link' },
  'zh-TW': { undo: '復原', redo: '重做', cut: '剪下', copy: '複製', paste: '貼上', selectAll: '全選', copyLink: '複製連結' },
  ja: { undo: '元に戻す', redo: 'やり直す', cut: '切り取り', copy: 'コピー', paste: '貼り付け', selectAll: 'すべてを選択', copyLink: 'リンクをコピー' },
  ko: { undo: '실행 취소', redo: '다시 실행', cut: '잘라내기', copy: '복사', paste: '붙여넣기', selectAll: '전체 선택', copyLink: '링크 복사' },
};

function isWebUrl(value: string): boolean {
  if (!value) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch { return false; }
}

export function buildEditContextMenuTemplate(params: EditContextMenuParams, locale: Locale, copyText: (text: string) => void): Electron.MenuItemConstructorOptions[] {
  const label = LABELS[locale] ?? LABELS.en;
  const template: Electron.MenuItemConstructorOptions[] = [];
  if (params.isEditable) {
    const flags = params.editFlags;
    template.push(
      { role: 'undo', label: label.undo, enabled: flags.canUndo },
      { role: 'redo', label: label.redo, enabled: flags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: label.cut, enabled: flags.canCut },
      { role: 'copy', label: label.copy, enabled: flags.canCopy },
      { role: 'paste', label: label.paste, enabled: flags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: label.selectAll, enabled: flags.canSelectAll },
    );
  } else if (params.selectionText.trim().length > 0) {
    template.push({ role: 'copy', label: label.copy });
  }
  if (isWebUrl(params.linkURL)) {
    if (template.length > 0) template.push({ type: 'separator' });
    const url = params.linkURL;
    template.push({ label: label.copyLink, click: () => copyText(url) });
  }
  return template;
}

export interface EditContextMenuDeps {
  getLocale: () => Locale;
  copyText: (text: string) => void;
  popup: (template: Electron.MenuItemConstructorOptions[], window: Electron.BrowserWindow | undefined) => void;
  windowFor: (contents: Electron.WebContents) => Electron.BrowserWindow | undefined;
}

const defaultDeps: EditContextMenuDeps = {
  getLocale: getEffectiveLocale,
  copyText: (text) => clipboard.writeText(text),
  popup: (template, window) => Menu.buildFromTemplate(template).popup(window ? { window } : {}),
  windowFor: (contents) => BrowserWindow.fromWebContents(contents) ?? undefined,
};

export function installEditContextMenu(contents: Electron.WebContents, deps: Partial<EditContextMenuDeps> = {}): void {
  const resolved = { ...defaultDeps, ...deps };
  contents.on('context-menu', (_event, params) => {
    const template = buildEditContextMenuTemplate(params, resolved.getLocale(), resolved.copyText);
    if (template.length === 0) return;
    resolved.popup(template, resolved.windowFor(contents));
  });
}
