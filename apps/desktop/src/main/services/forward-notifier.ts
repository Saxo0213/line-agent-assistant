import type { Notification as ElectronNotification } from 'electron';

/** One desktop notification of a message rule. It carries only local data. */
export interface ForwardNotice {
  title: string;
  body: string;
  accountId: string;
  chatType: string;
  chatId: string;
}

export type ForwardNotify = (notice: ForwardNotice) => Promise<boolean>;

export interface ForwardNotifierOptions {
  /** The Electron Notification class (injected, so the module needs no Electron at load time). */
  Notification: Pick<typeof ElectronNotification, 'isSupported'> & (new (options: { title: string; body: string; silent?: boolean }) => Pick<ElectronNotification, 'show' | 'on'>);
  /** Shows and focuses the main window, then asks the renderer to open the chat of the notice. */
  focusWindow(notice: ForwardNotice): void;
  onError?(error: unknown): void;
}

/**
 * Shows desktop notifications with the Electron Notification API. A click hands the notice to focusWindow: Main shows the window and publishes the
 * openConversation event. Resolves true after show(); false when notifications are not supported or show() throws.
 */
export function createForwardNotifier(options: ForwardNotifierOptions): ForwardNotify {
  return async (notice) => {
    try {
      if (!options.Notification.isSupported()) return false;
      const notification = new options.Notification({ title: notice.title, body: notice.body, silent: false });
      notification.on('click', () => {
        try { options.focusWindow(notice); } catch (error) { options.onError?.(error); }
      });
      notification.show();
      return true;
    } catch (error) {
      options.onError?.(error);
      return false;
    }
  };
}
