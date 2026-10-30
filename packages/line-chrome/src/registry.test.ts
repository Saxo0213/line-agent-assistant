import { describe, expect, it } from 'vitest';
import {
  AUTH_KICKOUT_CODES,
  GATEWAY_BASE_URL,
  LAL_MAP,
  OBS_APPLICATION_HEADER,
  OBS_BASE_URL,
  CHROME_EXTENSION_ID,
  SPECIAL_ENDPOINTS,
  THRIFT_ENDPOINTS,
  USED_ENDPOINTS,
  allEndpointKeys,
  extractErrorInfo,
  isTalkAuthScoped,
  lalForLocale,
  parsePreciseJson,
  PreciseJsonError,
  specialPath,
  thriftPath,
} from './index.js';

describe('constants', () => {
  it('pins the base urls, extension id and OBS application header with trailing tab', () => {
    expect(GATEWAY_BASE_URL).toBe('https://line-chrome-gw.line-apps.com');
    expect(OBS_BASE_URL).toBe('https://obs.line-apps.com');
    expect(CHROME_EXTENSION_ID).toBe('ophjlpahpchlmihnnnihgmmeilfjmjjc');
    expect(OBS_APPLICATION_HEADER).toBe('CHROMEOS\t3.7.2\tChrome_OS\t');
    expect(OBS_APPLICATION_HEADER.endsWith('\t')).toBe(true);
  });

  it('ports the LAL map and falls back to en_US', () => {
    expect(Object.keys(LAL_MAP)).toHaveLength(11);
    expect(lalForLocale('zh-TW')).toBe('zh_TW');
    expect(lalForLocale('es-419')).toBe('es_419');
    expect(lalForLocale('xx-YY')).toBe('en_US');
  });
});

describe('endpoint registry', () => {
  it('contains the full OkLine registry (77 thrift endpoints, 11 special)', () => {
    expect(Object.keys(THRIFT_ENDPOINTS)).toHaveLength(77);
    expect(Object.keys(SPECIAL_ENDPOINTS)).toHaveLength(11);
    expect(allEndpointKeys()).toHaveLength(77);
  });

  it('derives thrift paths', () => {
    expect(thriftPath('Talk.TalkService.sendMessage')).toBe('/api/talk/thrift/Talk/TalkService/sendMessage');
    expect(thriftPath('ShopService.ShopService.getOwnedProductSummaries')).toBe(
      '/api/shop/thrift/ShopService/ShopService/getOwnedProductSummaries',
    );
    expect(specialPath('operation.receive')).toBe('/api/operation/receive');
    expect(specialPath('auth.tokenRefresh')).toBe('/api/auth/tokenRefresh');
    expect(() => thriftPath('Nope.Nope.nope' as never)).toThrow(RangeError);
  });

  it('every entry follows the <area>/thrift/<Ns>/<Service>/<method> shape matching its key', () => {
    for (const [key, suffix] of Object.entries(THRIFT_ENDPOINTS)) {
      const [ns, service, method] = key.split('.');
      expect(suffix).toMatch(new RegExp(`^(talk|shop)/thrift/${ns}/${service}/${method}$`));
    }
  });

  it('every used endpoint exists in the registry', () => {
    for (const key of Object.keys(USED_ENDPOINTS)) expect(key in THRIFT_ENDPOINTS).toBe(true);
  });
});

describe('talk-auth scope', () => {
  it.each([
    ['/api/talk/thrift/Talk/TalkService/getProfile', true],
    ['/api/talk/thrift/Talk/AuthService/logoutV2', true],
    ['/api/talk/thrift/Talk/ChannelService/issueChannelToken', false],
    ['/api/talk/thrift/Talk/E2EEKeyBackupService/x', false],
    ['/api/talk/thrift/Relation/RelationService/addFriendByMid', false],
    ['/api/talk/thrift/LoginQrCode/SecondaryQrCodeLoginService/createSession', false],
    ['/api/auth/tokenRefresh', false],
  ])('%s -> %s', (path, scoped) => {
    expect(isTalkAuthScoped(path)).toBe(scoped);
  });

  it('kickout codes are 1/7/8', () => {
    expect([...AUTH_KICKOUT_CODES].sort()).toEqual([1, 7, 8]);
  });
});

describe('extractErrorInfo', () => {
  it('reads the {"error": {...}} shape', () => {
    const info = extractErrorInfo({ message: 'FAILED', error: { code: 20, message: 'bad request' } });
    expect(info).toMatchObject({ outerCode: 20, code: 20, reason: 'bad request', innerCode: undefined });
  });

  it('returns empty info for non-object payloads', () => {
    expect(extractErrorInfo('oops')).toMatchObject({ code: undefined, outerCode: undefined });
    expect(extractErrorInfo(undefined)).toMatchObject({ code: undefined });
  });
});

describe('parsePreciseJson', () => {
  it('matches JSON.parse for ordinary documents', () => {
    const doc = '{"a":[1,2.5,-3e2,true,false,null,"x\\n\\u00e9\\ud83d\\ude00"],"b":{"c":{}},"__proto__":1}';
    expect(parsePreciseJson(doc)).toEqual(JSON.parse(doc));
  });

  it('keeps only integer literals beyond the safe range as strings', () => {
    expect(parsePreciseJson('[9007199254740991,9007199254740992,-9007199254740992,12345678901234567890,1.2345678901234567890e5]')).toEqual([
      9007199254740991,
      '9007199254740992',
      '-9007199254740992',
      '12345678901234567890',
      123456.78901234568,
    ]);
  });

  it.each(['', '{', '[1,]', '{"a":1,}', '01', '1.', '"abc', '{"a" 1}', '[1] x', 'tru', '"\\x"'])('rejects %j', (bad) => {
    expect(() => parsePreciseJson(bad)).toThrow(PreciseJsonError);
  });
});
