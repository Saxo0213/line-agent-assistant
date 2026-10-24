import { describe, expect, it, vi } from 'vitest';
import { LINE_CONTENT_TYPE_NUMBER_BY_NAME, lineContentKind, redactSensitiveText } from '@line-agent/contracts';
import { CONTENT_BRIDGE_RULES, bridgeKindFor, bridgeLiveMessage, bridgeNativeEnvelope, bridgeRuleFor, liveChatEventMids, nativeChatEventMids, contentTypeAliases, postNotificationSubtypeFromRaw, remapSticonRangesForDisplay, sticonRangesFromNativeEnvelope, MAX_METADATA_BYTES } from './index.js';
import { dpapiEnvelope, plainEnvelope } from './test-support.js';

const metadata = (value: Record<string, unknown>) => JSON.stringify(value);
const native = (fields: Record<string, string | number | null>) => bridgeNativeEnvelope(plainEnvelope({ _id: 'm1', ...fields }));
const live = (message: Record<string, unknown>, contact?: { mid: string; displayName: string | null }) =>
  bridgeLiveMessage({ raw: { revision: 1, message: { id: 'm1', ...message } }, ...(contact ? { contact } : {}) });

describe('content bridge rules', () => {
  it('classifies only stored type-16 live and plain native service tokens', () => {
    expect(postNotificationSubtypeFromRaw({ message: { contentType: 16, contentMetadata: { serviceType: 'GB' } } })).toBe('note');
    expect(postNotificationSubtypeFromRaw({ message: { contentType: 16, contentMetadata: { serviceType: 'AB' } } })).toBe('album');
    expect(postNotificationSubtypeFromRaw({ message: { contentType: 16, contentMetadata: { serviceType: 'gb' } } })).toBeNull();
    expect(postNotificationSubtypeFromRaw({ message: { contentType: 1, contentMetadata: { serviceType: 'GB' } } })).toBeNull();
    expect(postNotificationSubtypeFromRaw({ message: { contentType: 16, contentMetadata: { serviceType: 'OTHER' } } })).toBeNull();
    expect(postNotificationSubtypeFromRaw({ message: { contentType: 'POSTNOTIFICATION', contentMetadata: { serviceType: 'GB' } }, unrelated: 'x'.repeat(1_000_000) })).toBe('note');
    expect(postNotificationSubtypeFromRaw({ message: { contentType: 16, contentMetadata: '{"serviceType":"GB"}' } })).toBeNull();
    expect(postNotificationSubtypeFromRaw({ sourceDeleted: true, message: { contentType: 16, contentMetadata: { serviceType: 'GB' } } })).toBe('note');
    const nativeEnvelope = plainEnvelope({ _id: 'post', _contentType: 16, _contentMetadata: '{"serviceType":"AB"}' });
    expect(postNotificationSubtypeFromRaw({ native: nativeEnvelope })).toBe('album');
    expect(postNotificationSubtypeFromRaw({ native: plainEnvelope({ _id: 'post-note', _contentType: 16, _contentMetadata: '{"serviceType":"GB"}' }),
      unrelated: 'x'.repeat(1_000_000) })).toBe('note');
    expect(postNotificationSubtypeFromRaw({ native: plainEnvelope({ _id: 'bad-meta', _contentType: 16, _contentMetadata: '{bad' }) })).toBeNull();
    expect(postNotificationSubtypeFromRaw({ native: { ...nativeEnvelope, encoding: 'dpapi' } })).toBeNull();
  });
  it('treats a community note notification (serviceType SN) as a note, including when source-deleted', () => {
    const squareUrl = 'line://square/post?squareMid=s123&postId=p1&sourceType=TALKROOM_HOME';
    const squarePost = (extra: Record<string, unknown>) => JSON.stringify({ contentType: 'P', officialName: 'x', 'push-temp-key': 'QPS', postEndUrl: squareUrl, ...extra });
    const nativeSquare = (extra: Record<string, unknown>) => plainEnvelope({ _id: 'sq', _contentType: 16, _contentMetadata: squarePost(extra) });
    expect(postNotificationSubtypeFromRaw({ sourceDeleted: { detectedAt: 'x' }, message: { contentType: 16 }, native: nativeSquare({ serviceType: 'SN' }) })).toBe('note');
    expect(postNotificationSubtypeFromRaw({ native: nativeSquare({ serviceType: 'SN' }) })).toBe('note');
    expect(postNotificationSubtypeFromRaw({ message: { contentType: 16, contentMetadata: { serviceType: 'SN', postEndUrl: squareUrl } } })).toBe('note');
    expect(postNotificationSubtypeFromRaw({ native: nativeSquare({ serviceType: 'sn' }) })).toBeNull();
    expect(postNotificationSubtypeFromRaw({ native: nativeSquare({}) })).toBeNull();
    expect(postNotificationSubtypeFromRaw({ message: { contentType: 16, contentMetadata: { 'push-action-uri': squareUrl } } })).toBeNull();
  });
  it('uses native history subtype when sanitized raw also has a metadata-free message projection', () => {
    for (const [serviceType, expected] of [['AB', 'album'], ['GB', 'note']] as const) {
      const row = { message: { id: 'sanitized-id', contentType: 16 },
        native: plainEnvelope({ _id: 'native-id', _contentType: 16, _contentMetadata: JSON.stringify({ serviceType }) }) };
      expect(postNotificationSubtypeFromRaw(row)).toBe(expected);
    }
  });
  it('keeps native history subtype within source, state, type, and metadata boundaries', () => {
    const native = plainEnvelope({ _id: 'native-id', _contentType: 16, _contentMetadata: '{"serviceType":"GB"}' });
    expect(postNotificationSubtypeFromRaw({ sourceDeleted: true, message: { contentType: 16 }, native })).toBe('note');
    expect(postNotificationSubtypeFromRaw({ contentState: 'decrypt_failed', message: { contentType: 16 }, native })).toBeNull();
    expect(postNotificationSubtypeFromRaw({ message: { contentType: 16, contentMetadata: { serviceType: 'GB' } },
      native: plainEnvelope({ _id: 'tampered-type', _contentType: 1, _contentMetadata: '{"serviceType":"GB"}' }) })).toBeNull();
    expect(postNotificationSubtypeFromRaw({ message: { contentType: 16 }, native: plainEnvelope({ _id: 'bad', _contentType: 16, _contentMetadata: '{bad' }) })).toBeNull();
    expect(postNotificationSubtypeFromRaw({ message: { contentType: 16 }, native: plainEnvelope({ _id: 'large', _contentType: 16, _contentMetadata: ' '.repeat(MAX_METADATA_BYTES + 1) }) })).toBeNull();
  });
  it('remaps sticons with redaction and drops overlapping ranges for native and live sources', () => {
    const rawText = 'LW-ABCDEFGH (pray) @Ada https://x.test (wave) RA-token';
    const ranges = [{ start: 12, end: 18, productId: 'p', sticonId: 's', animated: false },
      { start: rawText.indexOf('(wave)'), end: rawText.indexOf('(wave)') + 6, productId: 'p2', sticonId: 's2', animated: true },
      { start: 0, end: 4, productId: 'drop', sticonId: 'overlap', animated: false }];
    expect(remapSticonRangesForDisplay(rawText, ranges)).toEqual([
      { ...ranges[0], start: 29, end: 35 },
      { ...ranges[1], start: rawText.indexOf('(wave)') + 17, end: rawText.indexOf('(wave)') + 23 },
    ]);
    const display = redactSensitiveText(rawText).text;
    expect(display.slice(29, 35)).toBe('(pray)');
  });
  it('orders exact rules before the per-source fallback and versions every producing rule', () => {
    for (const source of ['native', 'live'] as const) {
      const rules = CONTENT_BRIDGE_RULES.filter((rule) => rule.source === source);
      expect(rules.at(-1)?.contentType).toBe('*');
      expect(rules.filter((rule) => rule.contentType === '*')).toHaveLength(1);
      expect(rules.find((rule) => rule.contentType === 13)?.version).toBeGreaterThanOrEqual(1);
      expect(rules.find((rule) => rule.contentType === 0)?.version).toBe(source === 'native' ? 2 : 0);
    }
    expect(bridgeRuleFor('native', 4242).contentType).toBe('*');
    expect(contentTypeAliases(15)).toEqual(['15', 'LOCATION']);
  });

  // C5: the live worker format and the native row format reduce to the same fields, so one rule gives equal content.
  it.each([
    ['contact', { contentType: 13, metadata: { mid: `u${'a'.repeat(32)}`, displayName: 'Friend' } }, null,
      { format: 1, type: 'contact', mid: `u${'a'.repeat(32)}`, displayName: 'Friend' }],
    ['rich', { contentType: 17, metadata: { ALT_TEXT: 'Card', FLEX_JSON: 'ignored' } }, null, { format: 1, type: 'rich', variant: 'rich', altText: 'Card' }],
    ['flex', { contentType: 22, metadata: { ALT_TEXT: 'Flex' } }, null, { format: 1, type: 'rich', variant: 'flex', altText: 'Flex' }],
    ['video', { contentType: 2, metadata: { DURATION: '12345' } }, null, { format: 1, type: 'media', durationMs: 12345 }],
    ['audio with a bad duration', { contentType: 3, metadata: { DURATION: 'bad' } }, null, { format: 1, type: 'media', durationMs: null }],
    ['call', { contentType: 6, text: 'Missed call' }, null, { format: 1, type: 'event', nativeContentType: 6, text: 'Missed call', call: null }],
    ['gift', { contentType: 9, text: null }, null, { format: 1, type: 'event', nativeContentType: 9, text: null }],
    ['post notification', { contentType: 16, text: 'New post' }, null, { format: 1, type: 'event', nativeContentType: 16, text: 'New post' }],
    ['chat event', { contentType: 18, text: 'Pinned' }, null, { format: 1, type: 'event', nativeContentType: 18, text: 'Pinned' }],
    ['unsupported', { contentType: 42, text: 'Fallback' }, null, { format: 1, type: 'unsupported', nativeContentType: 42, fallbackText: 'Fallback' }],
    ['unsupported with ALT_TEXT', { contentType: 12, metadata: { ALT_TEXT: 'Link card' } }, null, { format: 1, type: 'unsupported', nativeContentType: 12, fallbackText: 'Link card' }],
  ] as const)('live and native rows of type %s give equal content', (_name, input, _unused, expected) => {
    const meta = 'metadata' in input ? input.metadata : undefined;
    const text = 'text' in input ? input.text : null;
    const nativeResult = native({ _contentType: input.contentType, _text: text, _contentMetadata: meta ? metadata(meta) : null });
    const contact = input.contentType === 13 ? { mid: String((meta as { mid: string }).mid), displayName: (meta as { displayName: string }).displayName } : undefined;
    const liveResult = live({ contentType: input.contentType, text, ...(meta ? { contentMetadata: meta } : {}) }, contact);
    expect(nativeResult?.content).toEqual(expected);
    expect(liveResult?.content).toEqual(expected);
    expect(nativeResult?.version).toBe(liveResult?.version);
    expect(nativeResult?.kind).toBe(liveResult?.kind);
  });

  it('projects unsent metadata for native text, image, file and live rows', () => {
    for (const _contentType of [0, 1, 3]) {
      expect(native({ _contentType, _text: 'old body', _contentMetadata: metadata({ UNSENT: true }) })?.content)
        .toEqual({ format: 1, type: 'unsent' });
    }
    expect(native({ _contentType: 3, _contentMetadata: metadata({ UNSENT: 'true' }) })?.content)
      .toEqual({ format: 1, type: 'unsent' });
    expect(live({ contentType: 3, contentMetadata: { UNSENT: true } })?.content).toEqual({ format: 1, type: 'unsent' });
  });

  it('projects validated call details from metadata', () => {
    expect(live({ contentType: 6, text: 'Rang', contentMetadata: { RESULT: 'NORMAL', DURATION: '74000', TYPE: 'A' } })?.content)
      .toEqual({ format: 1, type: 'event', nativeContentType: 6, text: 'Rang', call: { media: 'audio', result: 'NORMAL', durationMs: 74000 } });
    expect(native({ _contentType: 6, _contentMetadata: metadata({ RESULT: 'CANCELED', DURATION: '0', TYPE: 'A' }) })?.content)
      .toMatchObject({ call: { media: 'audio', result: 'CANCELED', durationMs: 0 } });
    expect(live({ contentType: 6, contentMetadata: { TYPE: 'V' } })?.content).toMatchObject({ call: { media: 'video', result: null, durationMs: null } });
    expect(live({ contentType: 6 })?.content).toMatchObject({ call: null });
    expect(live({ contentType: 6, contentMetadata: { RESULT: 'bad result', DURATION: '-1' } })?.content)
      .toMatchObject({ call: { media: null, result: null, durationMs: null } });
  });

  it('N3: the bridge kind map and the normalizer routing map agree for every linejs ContentType name and number', () => {
    for (const [name, number] of Object.entries(LINE_CONTENT_TYPE_NUMBER_BY_NAME)) {
      expect(lineContentKind(name)).toBe(bridgeKindFor(number));
      expect(lineContentKind(number)).toBe(bridgeKindFor(number));
      expect(lineContentKind(String(number))).toBe(bridgeKindFor(number));
      expect(live({ contentType: name })?.kind).toBe(bridgeKindFor(number));
    }
    expect(lineContentKind('NOT_A_TYPE')).toBe('event');
    expect(bridgeKindFor(null)).toBe('event');
  });

  it('maps kinds, text types project nothing, and live content type names are understood', () => {
    expect(native({ _contentType: 0, _text: 'hello' })).toMatchObject({ kind: 'text', content: null, version: 2 });
    expect(native({ _contentType: 1 })?.kind).toBe('image');
    expect(live({ contentType: 'IMAGE' })?.kind).toBe('image');
    expect(live({ contentType: 'FLEX', contentMetadata: { ALT_TEXT: 'x' } })).toMatchObject({ kind: 'rich', content: { variant: 'flex' } });
    expect(live({ contentType: 'CALL', text: 'Call ended' })).toMatchObject({ kind: 'event', content: { nativeContentType: 6, text: 'Call ended' } });
    expect(live({ contentType: 'POSTNOTIFICATION' })?.content).toMatchObject({ nativeContentType: 16 });
    expect(native({ _contentType: null, _text: 'x' })).toMatchObject({ kind: 'event', content: { type: 'unsupported', nativeContentType: null } });
  });

  describe('group chat events (native type 18, LOC_KEY / LOC_ARGS)', () => {
    const A = 'ua'.padEnd(33, 'a');
    const B = 'ub'.padEnd(33, 'b');
    const C = 'uc'.padEnd(33, 'c');
    const chatEvent = (locKey: string, locArgs: string, names?: Record<string, string>) =>
      bridgeNativeEnvelope(plainEnvelope({ _id: 'm18', _contentType: 18, _text: '', _eventInfo: '',
        _contentMetadata: JSON.stringify({ LOC_KEY: locKey, LOC_ARGS: locArgs, NOTIFICATION_DISABLED: 'true' }) }),
      undefined, names ? new Map(Object.entries(names)) : undefined);
    const text = (result: ReturnType<typeof chatEvent>) => (result?.content && 'text' in result.content ? result.content.text : undefined);
    const names = { [A]: '小薪', [B]: '徐佳誠', [C]: '黃英智' };

    it('renders the four known keys with LINE wording', () => {
      expect(chatEvent('C_MI', `${A}\u001e${B}`, names)).toMatchObject({ version: 2, kind: 'event',
        content: { format: 1, type: 'event', nativeContentType: 18, text: '小薪已新增徐佳誠至群組。' } });
      expect(text(chatEvent('C_GI', `${A}\u001e${B}`, names))).toBe('小薪已邀請徐佳誠加入群組，等對方加入再一起聊天吧！');
      expect(text(chatEvent('C_MJ', A, names))).toBe('小薪已加入群組。');
      expect(text(chatEvent('A_MC', `${A}\u001e${B}\u001f${C}`, names))).toBe('小薪已新增徐佳誠, 黃英智至群組。');
    });
    it('falls back to 成員 for unresolved or blank names', () => {
      expect(text(chatEvent('C_MI', `${A}\u001e${B}`))).toBe('成員已新增成員至群組。');
      expect(text(chatEvent('A_MC', `${A}\u001e${B}\u001f${C}`, { [A]: '  ', [B]: '徐佳誠' }))).toBe('成員已新增徐佳誠, 成員至群組。');
    });
    it('bounds names to 128 characters and targets to 20', () => {
      const mids = Array.from({ length: 30 }, (_, index) => `u${index.toString(16).padStart(32, '0')}`);
      const long = Object.fromEntries(mids.map((mid) => [mid, 'x'.repeat(300)]));
      const result = text(chatEvent('A_MC', `${mids[0]}\u001e${mids.slice(1).join('\u001f')}`, long)) ?? '';
      expect(result.startsWith(`${'x'.repeat(128)}已新增${'x'.repeat(128)}, `)).toBe(true);
      expect(result.slice(0, -'至群組。'.length).split(', ')).toHaveLength(20);
    });
    it('keeps today\'s text-less output for unknown keys and malformed arguments', () => {
      const plain = { format: 1, type: 'event', nativeContentType: 18, text: null };
      expect(chatEvent('SOMETHING_ELSE', `${A}\u001e${B}`, names)?.content).toEqual(plain);
      for (const bad of ['', 'not-a-mid', `${A}\u001e`, `${A}\u001e${B}\u001e${C}`, `${A}\u001e${B}\u001fbad`, `${A}\u001f${B}`, `${A}\u001e${B}`.toUpperCase()]) {
        expect(chatEvent('C_MI', bad, names)?.content, JSON.stringify(bad)).toEqual(plain);
      }
      expect(chatEvent('C_MJ', `${A}\u001e${B}`, names)?.content).toEqual(plain);
      expect(chatEvent('C_MI', A, names)?.content).toEqual(plain);
      expect(bridgeNativeEnvelope(plainEnvelope({ _id: 'm18', _contentType: 18, _text: '', _contentMetadata: '{"LOC_KEY":"C_MI"}' }))?.content).toEqual(plain);
    });
    it('lists the MIDs a recognised event depends on, actor first', () => {
      const envelope = (key: string, args: string) => plainEnvelope({ _id: 'm18', _contentType: 18, _contentMetadata: JSON.stringify({ LOC_KEY: key, LOC_ARGS: args }) });
      expect(nativeChatEventMids(envelope('A_MC', `${A}\u001e${B}\u001f${C}`))).toEqual([A, B, C]);
      expect(nativeChatEventMids(envelope('C_MJ', A))).toEqual([A]);
      expect(nativeChatEventMids(envelope('UNKNOWN', A))).toEqual([]);
      expect(nativeChatEventMids(envelope('C_MI', 'bad'))).toEqual([]);
    });
    it('extracts live type-18 actor and target MIDs safely', () => {
      const live = (locArgs: unknown) => ({ message: { contentType: 18, contentMetadata: { LOC_KEY: 'C_MI', LOC_ARGS: locArgs } } });
      expect(liveChatEventMids(live(`${A}\u001e${B}`))).toEqual([A, B]);
      expect(liveChatEventMids(live(`${A}\u001ebad`))).toEqual([]);
      expect(liveChatEventMids({ message: { contentType: 18, contentMetadata: {} } })).toEqual([]);
    });
  });

  describe('community member removal (native type 0, _eventInfo type 15)', () => {
    const event = (info: unknown, extra: Record<string, string | number | null> = {}) =>
      native({ _contentType: 0, _text: '', _contentMetadata: '', _eventInfo: typeof info === 'string' ? info : JSON.stringify(info), ...extra });
    const A = 'ua'.padEnd(33, 'a');
    const B = 'ub'.padEnd(33, 'b');
    const C = 'uc'.padEnd(33, 'c');
    it('projects the removal line as an event with the actor and target names', () => {
      expect(event({ type: 15, fromId: A, midList: [B], displayNameMap: { [A]: '甲', [B]: '乙' }, param: '' }))
        .toMatchObject({ kind: 'event', version: 2, content: { format: 1, type: 'event', nativeContentType: 0, text: '甲已將乙強制退出社群。' } });
      expect(event({ type: '15', fromId: A, midList: [B], displayNameMap: { [A]: '甲', [B]: '乙' } })?.content)
        .toMatchObject({ text: '甲已將乙強制退出社群。' });
    });
    it('projects a target-less type-14 row as a member-join system line from the joiner', () => {
      expect(event({ type: 14, fromId: A, midList: [], displayNameMap: { [A]: 'Zoom' }, param: '' }))
        .toMatchObject({ kind: 'event', version: 2, content: { format: 1, type: 'event', nativeContentType: 0, text: 'Zoom加入聊天' } });
      expect(event({ type: '14', fromId: A, displayNameMap: {} })?.content).toMatchObject({ text: '成員加入聊天' });
    });
    it('joins several targets with 、 and falls back to 成員 for missing or invalid names', () => {
      expect(event({ type: 15, fromId: A, midList: [B, C], displayNameMap: { [A]: '甲', [B]: '乙', [C]: '丙' } })?.content)
        .toMatchObject({ text: '甲已將乙、丙強制退出社群。' });
      expect(event({ type: 15, fromId: A, midList: [B, C], displayNameMap: { [B]: 7, [C]: '  ' } })?.content)
        .toMatchObject({ text: '成員已將成員、成員強制退出社群。' });
      expect(event({ type: 15, fromId: A, displayNameMap: { [A]: '甲' } })?.content).toMatchObject({ text: '甲已將成員強制退出社群。' });
      expect(event({ type: 15, fromId: A, midList: [], displayNameMap: { [A]: '甲' } })?.content).toMatchObject({ text: '甲已將成員強制退出社群。' });
      expect(event({ type: 15, fromId: A, midList: 'bad', displayNameMap: 'bad' })?.content).toMatchObject({ text: '成員已將成員強制退出社群。' });
    });
    it('bounds names and the number of targets', () => {
      const mids = Array.from({ length: 30 }, (_, index) => `m${index}`);
      const names = Object.fromEntries(mids.map((mid) => [mid, 'x'.repeat(300)]));
      const content = event({ type: 15, fromId: 'm0', midList: mids, displayNameMap: names })?.content;
      const text = content && 'text' in content ? content.text ?? '' : '';
      expect(text.split('、')).toHaveLength(20);
      expect(text.startsWith(`${'x'.repeat(128)}已將`)).toBe(true);
    });
    it('keeps oversized, malformed, other-type and absent eventInfo as plain text', () => {
      const plain = { kind: 'text', content: null, version: 2 };
      expect(event('{not json')).toMatchObject(plain);
      expect(event({ type: 14, fromId: A, midList: [B], displayNameMap: { [A]: '甲' } })).toMatchObject(plain);
      expect(event('[1,2]')).toMatchObject(plain);
      expect(event({ type: 15, fromId: A, midList: [B], displayNameMap: { [B]: 'x'.repeat(MAX_METADATA_BYTES) } })).toMatchObject(plain);
      expect(event({ type: 24, fromId: A, midList: [], displayNameMap: {}, param: '' })).toMatchObject(plain);
      expect(event('')).toMatchObject(plain);
      expect(native({ _contentType: 0, _text: 'hello', _eventInfo: null })).toMatchObject(plain);
      expect(native({ _contentType: 0, _text: 'hello' })).toMatchObject(plain);
    });
    it('does not read eventInfo for other content types and never changes the live type-0 rule', () => {
      expect(native({ _contentType: 1, _eventInfo: JSON.stringify({ type: 15, fromId: A, midList: [B] }) })).toMatchObject({ kind: 'image', content: null });
      expect(live({ contentType: 0, text: 'hi' })).toMatchObject({ kind: 'text', content: null, version: 0 });
    });
  });

  it('takes the live location struct and the native _text fallback through one location rule', () => {
    expect(live({ contentType: 15, location: { title: 'Place', address: 'Street', latitude: 25.03, longitude: 121.5 } }))
      .toMatchObject({ kind: 'location', content: { type: 'location', title: 'Place', address: 'Street', latitude: 25.03, longitude: 121.5 } });
    expect(live({ contentType: 0, location: { title: 'Cafe', latitude: 200, longitude: 1 } })?.content)
      .toEqual({ format: 1, type: 'location', title: 'Cafe', address: null, latitude: null, longitude: 1 });
    expect(native({ _contentType: 15, _text: 'Native place' })?.content)
      .toEqual({ format: 1, type: 'location', title: 'Native place', address: null, latitude: null, longitude: null });
    const withBlob = bridgeNativeEnvelope(plainEnvelope({ _id: 'm2', _contentType: 0, _text: 'Pin', _location: Buffer.from([1, 2, 3]) }));
    expect(withBlob).toMatchObject({ kind: 'location', content: { type: 'location', title: 'Pin' } });
  });

  it('treats a text row with an empty or blank _location cell as text, not a location', () => {
    for (const _location of ['', '   ', null, Buffer.alloc(0)]) {
      const result = bridgeNativeEnvelope(plainEnvelope({ _id: 'm3', _contentType: 0, _text: '凡哥賠錢', _location }));
      expect(result).toMatchObject({ kind: 'text', content: null });
    }
    expect(bridgeNativeEnvelope(plainEnvelope({ _id: 'm4', _contentType: 0, _text: 'hi', _location: '{"title":"x"}' })))
      .toMatchObject({ kind: 'location', content: { type: 'location', title: 'hi' } });
  });

  it('reads the reply relation from relation type 3 or REPLY only', () => {
    expect(native({ _contentType: 0, _messageRelationType: 3, _relatedMessageId: 'parent' })?.replyToMessageId).toBe('parent');
    expect(native({ _contentType: 0, _messageRelationType: 1, _relatedMessageId: 'parent' })?.replyToMessageId).toBeNull();
    expect(live({ contentType: 0, messageRelationType: 'REPLY', relatedMessageId: 'parent' })?.replyToMessageId).toBe('parent');
    expect(live({ contentType: 0, messageRelationType: 3, relatedMessageId: 77 })?.replyToMessageId).toBe('77');
    expect(live({ contentType: 0, messageRelationType: 0, relatedMessageId: 'parent' })?.replyToMessageId).toBeNull();
  });

  it('redacts sensitive strings, bounds text, and ignores malformed or oversized metadata', () => {
    expect(live({ contentType: 6, text: 'code LW-ABCDEFGH' })?.content).toMatchObject({ text: 'code [REDACTED_VERIFICATION_CODE]' });
    const long = 'x'.repeat(9000);
    expect((live({ contentType: 42, text: long })?.content as { fallbackText: string }).fallbackText).toHaveLength(4096);
    expect(native({ _contentType: 17, _contentMetadata: '{not-json' })?.content).toMatchObject({ type: 'rich', altText: null });
    expect(native({ _contentType: 17, _contentMetadata: metadata({ ALT_TEXT: 'a'.repeat(20_000) }) })?.content).toMatchObject({ altText: null });
    expect(live({ contentType: 6, text: 'a\0b' })?.content).toMatchObject({ text: 'a�b' });
  });

  it('rejects oversized native metadata before JSON decoding', () => {
    const envelope = plainEnvelope({ _id: 'oversized', _text: 'x', _contentMetadata: ' '.repeat(16 * 1024 + 1) });
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(sticonRangesFromNativeEnvelope(envelope)).toEqual([]);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });

  it('accepts valid sticon resources at the exact native metadata byte limit for plain and Base64 cells', () => {
    const exactMetadata = (sticonId: string, productId: string, resourceType: 'STATIC' | 'ANIMATION') => {
      const base = { REPLACE: JSON.stringify({ sticon: { resources: [
        { S: 0, E: 6, resourceType, version: 1, sticonId, productId },
      ] } }) };
      const unpadded = JSON.stringify({ ...base, padding: '' });
      const paddingLength = 16_384 - Buffer.byteLength(unpadded, 'utf8');
      expect(paddingLength).toBeGreaterThanOrEqual(0);
      const result = JSON.stringify({ ...base, padding: 'x'.repeat(paddingLength) });
      expect(Buffer.byteLength(result, 'utf8')).toBe(16_384);
      return result;
    };
    const plainMetadata = exactMetadata('004', '0123456789abcdef01234567', 'ANIMATION');
    expect(sticonRangesFromNativeEnvelope(plainEnvelope({ _id: 'exact-plain', _text: '(pray)', _contentMetadata: plainMetadata })))
      .toEqual([{ start: 0, end: 6, productId: '0123456789abcdef01234567', sticonId: '004', animated: true }]);

    const encodedMetadata = exactMetadata('005', 'abcdef0123456789abcdef01', 'STATIC');
    const encoded = Buffer.from(encodedMetadata).toString('base64');
    const envelope = plainEnvelope({ _id: 'exact-base64', _text: '(pray)', _contentMetadata: Buffer.alloc(0) });
    const index = envelope.row.columns.indexOf('_contentMetadata');
    const cells = [...envelope.row.cells];
    cells[index] = { sqliteType: 'blob', encoding: 'base64', data: encoded };
    expect(sticonRangesFromNativeEnvelope({ ...envelope, row: { ...envelope.row, cells } }))
      .toEqual([{ start: 0, end: 6, productId: 'abcdef0123456789abcdef01', sticonId: '005', animated: false }]);
  });

  it('enforces the UTF-8 byte limit for plain and Base64 metadata before decoding', () => {
    const multibyte = JSON.stringify({ value: '界'.repeat(5450) });
    const exact = multibyte + ' '.repeat(16_384 - Buffer.byteLength(multibyte, 'utf8'));
    const tooLarge = `${exact} `;
    expect(sticonRangesFromNativeEnvelope(plainEnvelope({ _id: 'exact', _text: 'x', _contentMetadata: exact }))).toEqual([]);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(sticonRangesFromNativeEnvelope(plainEnvelope({ _id: 'large', _text: 'x', _contentMetadata: tooLarge }))).toEqual([]);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }

    const encodedExact = Buffer.from('{}' + ' '.repeat(16_382)).toString('base64');
    const encodedLarge = Buffer.alloc(16_385, 32).toString('base64');
    const binaryEnvelope = (id: string, data: string) => {
      const env = plainEnvelope({ _id: id, _text: 'x', _contentMetadata: Buffer.alloc(0) });
      const index = env.row.columns.indexOf('_contentMetadata');
      const cells = [...env.row.cells];
      cells[index] = { sqliteType: 'blob', encoding: 'base64', data };
      return { ...env, row: { ...env.row, cells } };
    };
    const from = vi.spyOn(Buffer, 'from');
    const json = vi.spyOn(JSON, 'parse');
    try {
      expect(sticonRangesFromNativeEnvelope(binaryEnvelope('encoded-exact', encodedExact))).toEqual([]);
      expect(from).toHaveBeenCalled();
      from.mockClear(); json.mockClear();
      expect(sticonRangesFromNativeEnvelope(binaryEnvelope('encoded-large', encodedLarge))).toEqual([]);
      expect(from).not.toHaveBeenCalled(); expect(json).not.toHaveBeenCalled();
      expect(sticonRangesFromNativeEnvelope(binaryEnvelope('encoded-bad', 'a!=='))).toEqual([]);
      expect(from).not.toHaveBeenCalled();
    } finally { from.mockRestore(); json.mockRestore(); }
  });

  it('skips dpapi envelopes, other tables, and live rows without a convertible message', () => {
    expect(bridgeNativeEnvelope(dpapiEnvelope('1'.repeat(64)))).toBeNull();
    expect(bridgeNativeEnvelope({ ...plainEnvelope({ _id: 'c1' }), table: '_chat' })).toBeNull();
    expect(bridgeNativeEnvelope(null)).toBeNull();
    expect(bridgeLiveMessage({ raw: { contentState: 'decrypt_failed', message: { contentType: 6 } } })).toBeNull();
    expect(bridgeLiveMessage({ raw: {} })).toBeNull();
    expect(bridgeLiveMessage({ raw: {}, contact: { mid: `u${'b'.repeat(32)}`, displayName: null } })).toMatchObject({ kind: 'contact', content: { type: 'contact', displayName: null } });
  });
});
