import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** SHA-256 over the JS modules distributed by JSR @evex/linejs 3.5.0 revision 11. */
export const LINEJS_SOURCE_FIXTURE = Object.freeze({
  'base/request/mod.js': '2419c8e757fba3f72304223a7b9587ae40ad6269d7ce114d3e48f46c2c94ea8e',
  'base/request/legy.js': 'd3432745a03c6a2f5bee51989c8ab815450fc3bb536ca30c0ce0736ad22189aa',
  'base/login/mod.js': '43e79c5266d91c138323825cf1403416ab1525733a032d637473de8c55d9c6f5',
  'base/service/talk/mod.js': '4ebf01fec286439e71d57f906f78ad1c616b183c8ce5f3a77acbbb16578fc2d3',
  'base/service/relation/mod.js': 'a861d956a2a697fa40883552c68c1228a91a0aa3e749b74f780a94d4b71b2bd1',
  'base/e2ee/mod.js': 'e4307c407e274e033dc2be7e2b4aac13217cc5e82e5a5200cd14b9f8f7ff1960',
  'base/obs/mod.js': 'a983b40948839deaea07742858f149fc7cb8068e6d19e91108577738d7629c53',
  'base/core/mod.js': '6ba694ae2201d7d02e83b673c228ce1e2fb2a05c893282c21b1bc92c73db0225',
});

export type ProtocolVerification =
  | Readonly<{ status: 'verified'; version: '3.5.0'; source: 'jsr:@evex/linejs@3.5.0' }>
  | Readonly<{ status: 'PROTOCOL_UNVERIFIED'; reason: string }>;

export async function verifyLinejsPackage(root: string): Promise<ProtocolVerification> {
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    if (manifest.name !== '@jsr/evex__linejs' || manifest.version !== '3.5.0' || manifest._jsr_revision !== 11) {
      return { status: 'PROTOCOL_UNVERIFIED', reason: 'LINEJS package identity/version/revision drift' };
    }
    for (const [relativePath, expected] of Object.entries(LINEJS_SOURCE_FIXTURE)) {
      const source = await readFile(join(root, relativePath));
      if (createHash('sha256').update(source).digest('hex') !== expected) {
        return { status: 'PROTOCOL_UNVERIFIED', reason: `LINEJS source drift: ${relativePath}` };
      }
    }
    return { status: 'verified', version: '3.5.0', source: 'jsr:@evex/linejs@3.5.0' };
  } catch {
    return { status: 'PROTOCOL_UNVERIFIED', reason: 'LINEJS source fixture unavailable' };
  }
}
