import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** SHA-256 over the JS modules distributed by JSR @evex/linejs 3.6.9 revision 11. */
export const LINEJS_SOURCE_FIXTURE = Object.freeze({
  'base/request/mod.js': 'e5dcb0e106fbe1ecedb9a99707eae7da565f54b4f45e7ee5f42e8c144a73def4',
  'base/request/legy.js': 'd3432745a03c6a2f5bee51989c8ab815450fc3bb536ca30c0ce0736ad22189aa',
  'base/login/mod.js': 'fdcdae9853c4d936ca1e912d196e1bb45ddef9e3588bcc3d21e108f66ddf68e6',
  'base/service/talk/mod.js': '5442b8d4e2a1e630e7d230f8a11b6d741dcbd44ce1457728da2783f03d6db77b',
  'base/service/relation/mod.js': 'a861d956a2a697fa40883552c68c1228a91a0aa3e749b74f780a94d4b71b2bd1',
  'base/e2ee/mod.js': '2c1a7479771d8bb83c8d86656485a473499c991888c9c0cba59adc4ab7fbcab9',
  'base/obs/mod.js': '506b0d5bbf3cd4b1759704772498888fd5c8ef746eee2b7967090394c9dd78f9',
  'base/core/mod.js': 'd3fecb6de7dec3a3c3d26bf2f6ed944e6e4bfc9c8dc1eaa5a8648a3d910e64aa',
});

export type ProtocolVerification =
  | Readonly<{ status: 'verified'; version: '3.6.9'; source: 'jsr:@evex/linejs@3.6.9' }>
  | Readonly<{ status: 'PROTOCOL_UNVERIFIED'; reason: string }>;

export async function verifyLinejsPackage(root: string): Promise<ProtocolVerification> {
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    if (manifest.name !== '@jsr/evex__linejs' || manifest.version !== '3.6.9' || manifest._jsr_revision !== 11) {
      return { status: 'PROTOCOL_UNVERIFIED', reason: 'LINEJS package identity/version/revision drift' };
    }
    for (const [relativePath, expected] of Object.entries(LINEJS_SOURCE_FIXTURE)) {
      const source = await readFile(join(root, relativePath));
      if (createHash('sha256').update(source).digest('hex') !== expected) {
        return { status: 'PROTOCOL_UNVERIFIED', reason: `LINEJS source drift: ${relativePath}` };
      }
    }
    return { status: 'verified', version: '3.6.9', source: 'jsr:@evex/linejs@3.6.9' };
  } catch {
    return { status: 'PROTOCOL_UNVERIFIED', reason: 'LINEJS source fixture unavailable' };
  }
}
