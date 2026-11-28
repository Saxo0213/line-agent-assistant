/**
 * Text that goes to a LINE chat must not show the absolute path of the app data folder or of the chat workspace.
 * Such a path (and the rest of it, up to a space or a closing quote or bracket) becomes a short label.
 * The paths of bound project folders (for example a NAS folder) are not app paths and stay as they are.
 */
export const CHAT_WORKSPACE_LABEL = '本聊天室的工作資料夾';
export const APP_DATA_LABEL = 'App 資料夾';

export interface AppPathRoots {
  /** The workspace folder of the chat that the text is for; the rest of the path stays as a relative path. */
  chatWorkspace?: string | null;
  /** Other folders that belong to the app (for example the configured Agent workspace root). */
  appRoots?: readonly string[];
}

// A drive path that ends at a space, a quote or a closing bracket.
const DRIVE_PATH = /[A-Za-z]:[\\/][^\s"'`“”‘’<>|)\]}）」』】，。；：！？、]*/g;
const TRAILING_PUNCTUATION = /[.,;:!?，。；：！？、]+$/;
const APP_FOLDER_NAME = /(^|\\)(lineagentassistant|agent-workspace)(\\|$)/;

const normalize = (value: string): string => value.replace(/\//g, '\\').replace(/\\+$/, '');

/** The part of `candidate` below `root` (no leading separator, may be empty), or null when `candidate` is not inside `root`. */
function below(candidate: string, root: string): string | null {
  const base = normalize(root);
  if (base.length < 3) return null;
  if (candidate.toLowerCase() === base.toLowerCase()) return '';
  return candidate.toLowerCase().startsWith(`${base.toLowerCase()}\\`) ? candidate.slice(base.length + 1) : null;
}

/** Replaces every app path in `text` with its label. */
export function redactAppPaths(text: string, roots: AppPathRoots = {}): string {
  return text.replace(DRIVE_PATH, (match) => {
    const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    const candidate = normalize(trailing ? match.slice(0, -trailing.length) : match);
    if (roots.chatWorkspace) {
      const rest = below(candidate, roots.chatWorkspace);
      if (rest !== null) return `${CHAT_WORKSPACE_LABEL}${rest ? `\\${rest}` : ''}${trailing}`;
    }
    if ((roots.appRoots ?? []).some((root) => below(candidate, root) !== null) || APP_FOLDER_NAME.test(candidate.toLowerCase())) {
      return `${APP_DATA_LABEL}${trailing}`;
    }
    return match;
  });
}
