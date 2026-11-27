// Feature snapshot of the LINE Chrome extension code (main.js of 3.7.2) that the bridge needs.
// A store-installed extension of any version is accepted when every signature below is found in its main.js.
// Each signature has a name (safe characters only: A-Z, 0-9, _) and one comment line that names the dependency.
// Minified variable names (IA, XC, eB, QO, zD) are part of the dependency: the bridge finds its handles by these names.
// Other minified names are matched with [\w$]+, so a rename of them does not fail the check.

import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';

export interface ExtensionFeature {
  readonly name: string;
  readonly pattern: RegExp;
}

const MAIN_JS_RELATIVE = ['static', 'js', 'main.js'] as const;

export const EXTENSION_FEATURES: readonly ExtensionFeature[] = [
  // extension-handles.ts: the Redux store `IA` is made by configureStore with `reducer` as first option (handle IA).
  { name: 'STORE_IA', pattern: /[,;]IA=function\(e\)\{const t=[\w$]+\(\),\{reducer:n,middleware:r,devTools:/ },
  // extension-handles.ts, login-state.ts, bridge-download.ts: the store state has the slices `auth` and `message`.
  { name: 'STORE_SLICES', pattern: /reducer:[\w$]+\(\{auth:[\w$]+,chat:[\w$]+,common:[\w$]+,contact:[\w$]+,message:[\w$]+,/ },
  // login-state.ts, extension-handles.ts: `auth.loginState` starts as log_in_progressing in the slice `auth`.
  { name: 'AUTH_SLICE', pattern: /\{loginState:[\w$]+\.LOG_IN_PROGRESSING\},[\w$]+=[\w$]+\(\{name:"auth"/ },
  // login-state.ts, official-download-bridge-service.ts: values of `auth.loginState`.
  { name: 'LOGIN_STATES', pattern: /e\.LOGGED_OUT="logged_out",e\.LOG_IN_PROGRESSING="log_in_progressing",e\.LOGGED_IN="logged_in"/ },
  // login-state.ts, official-download-bridge-service.ts: `auth.profile.mid` is the profile ID of the logged-in account.
  { name: 'AUTH_PROFILE_MID', pattern: /\.auth\.profile\)\|\|void 0===[\w$]+\?void 0:[\w$]+\.mid/ },
  // login-state.ts: the QR login component gets the prop `qrCodeLogin` with these fields (fiber walk, startLogin).
  { name: 'QR_LOGIN_PROP', pattern: /\(\{qrCodeLogin:\{state:\w,qrCodeLink:\w,pinCode:\w,errorMessage:\w,startLogin:\w,abortCheckPinCodeVerifiedRequest:\w\}/ },
  // login-state.ts: the QR login hook returns state, errorCode, startLogin and pinCode (errorCode and refresh).
  { name: 'QR_LOGIN_HOOK', pattern: /qrCodeLink:[\w$]+,pinCode:[\w$]+,errorMessage:[\w$]+,errorCode:[\w$]+,startLogin:[\w$]+,abortCheckPinCodeVerifiedRequest:[\w$]+\}/ },
  // login-state.ts, official-download-bridge-service.ts: values of the QR flow state.
  { name: 'QR_STATES', pattern: /e\.IDLE="idle",e\.QR_CODE_LOADING="qr_code_loading",e\.WAIT_FOR_QR_CODE_VERIFIED="wait_for_qr_code_verified",e\.WAIT_FOR_PIN_CODE_VERIFIED="wait_for_pin_code_verified",e\.SUCCESS="success",e\.ERROR="error"/ },
  // extension-handles.ts, login-state.ts: React container key on #root (fiber walk).
  { name: 'REACT_CONTAINER', pattern: /"__reactContainer\$"/ },
  // bridge-download.ts: the reducer `updateMessageEntities` writes `entities.messages` (store message path).
  { name: 'MESSAGE_ENTITIES', pattern: /updateMessageEntities:\(e,t\)=>\{const n=t\.payload;for\(const\[r,a\]of Object\.entries\(n\)\)e\.entities\.messages\[r\]=a\}/ },
  // extension-handles.ts: handle XC is the message action object.
  { name: 'HANDLE_XC', pattern: /[,;]XC=\{\.\.\.[\w$]+\.actions,upsertMessageEntities:/ },
  // bridge-download.ts: handle eB downloads a message file with two parameters (message, place).
  { name: 'HANDLE_EB', pattern: /[,;]eB=async\(e,t\)=>\{var n,r;const a=null===\(n=IA\.getState\(\)\.message\.extraInfos\[e\.id\]\)/ },
  // bridge-download.ts: the place value `media_viewer` that is the second argument of eB.
  { name: 'MEDIA_VIEWER', pattern: /e\.MEDIA_VIEWER="media_viewer"/ },
  // bridge-verification.ts: handle QO builds the media path of a message (option withoutTid).
  { name: 'HANDLE_QO', pattern: /[,;]QO=\(e,t\)=>\{var n;if\(!e\)return"";const\{isPreview:r,withoutTid:a\}=/ },
  // extension-handles.ts: handle zD is the media request function.
  { name: 'HANDLE_ZD', pattern: /[,;]zD=async\(\{path:e,isPrivateResource:t=!1,keyMaterial:n,messageId:r,isVideo:a,cdn:i,config:o\}\)=>/ },
  // bridge-download.ts, bridge-verification.ts: content types IMAGE=1 and FILE=14.
  { name: 'CONTENT_TYPES', pattern: /e\[e\.IMAGE=1\]="IMAGE"[^;]{0,400}e\[e\.FILE=14\]="FILE"/ },
  // native-message.ts, bridge-verification.ts: the message field `contentMetadata.ENC_KM` is the key material.
  { name: 'ENC_KM', pattern: /contentMetadata\)\|\|void 0===[\w$]+\?void 0:[\w$]+\.ENC_KM\)&&Object\.assign\([\w$]+,\{keyMaterial:/ },
];

export interface FeatureCheckResult {
  readonly ok: boolean;
  /** Names of the signatures that were not found. Empty when ok. */
  readonly failed: readonly string[];
}

/** Tests every signature on the text of main.js. */
export function checkExtensionFeatures(mainJs: string): FeatureCheckResult {
  const failed = EXTENSION_FEATURES.filter((feature) => !feature.pattern.test(mainJs)).map((feature) => feature.name);
  return { ok: failed.length === 0, failed };
}

/** Reads `<dir>/static/js/main.js` and tests every signature. A missing file fails with the name MAIN_JS_MISSING. */
export async function checkExtensionFolderFeatures(dir: string): Promise<FeatureCheckResult> {
  let text: string;
  try {
    text = await readFile(nodePath.join(dir, ...MAIN_JS_RELATIVE), 'latin1');
  } catch {
    return { ok: false, failed: ['MAIN_JS_MISSING'] };
  }
  return checkExtensionFeatures(text);
}
