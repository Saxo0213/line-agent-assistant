export const SETTINGS_TAB_IDS = ['system', 'conversation', 'agent', 'help', 'work', 'about'] as const;
export type SettingsTabId = typeof SETTINGS_TAB_IDS[number];

export const SETTINGS_TAB_KEY = 'line-agent:settings-tab';

/** The last Settings tab the user chose; null when nothing valid is stored or storage is unavailable. */
export function readStoredSettingsTab(): SettingsTabId | null {
  try {
    const value = window.localStorage.getItem(SETTINGS_TAB_KEY);
    if (value === 'permissions') return 'agent';
    if (value === 'accounts' || value === 'database') {
      try { window.localStorage.setItem(SETTINGS_TAB_KEY, 'system'); } catch { /* Keep the mapped tab when storage is unavailable. */ }
      return 'system';
    }
    if (value === 'status') {
      try { window.localStorage.setItem(SETTINGS_TAB_KEY, 'system'); } catch { /* Keep the mapped tab when storage is unavailable. */ }
      return 'system';
    }
    return SETTINGS_TAB_IDS.find((id) => id === value) ?? null;
  } catch { return null; }
}

export function storeSettingsTab(tab: SettingsTabId): void {
  try { window.localStorage.setItem(SETTINGS_TAB_KEY, tab); } catch { /* Storage can be disabled; the tab still switches. */ }
}
