import { describe, expect, it } from 'vitest';
import {
  buildAddFriendRequest, buildCancelReactionRequest, buildMediaMessage, buildReactRequest, buildTextMessage, midToType, PREDEFINED_REACTION_TYPE,
} from './messaging.js';

describe('midToType (OkLine models.py:29-43)', () => {
  it('maps the mid prefix case-insensitively', () => {
    expect(midToType(`u${'a'.repeat(32)}`)).toBe(0);
    expect(midToType(`C${'a'.repeat(32)}`)).toBe(2);
    expect(midToType(`r${'a'.repeat(32)}`)).toBe(1);
    expect(midToType(`s${'a'.repeat(32)}`)).toBe(4);
    expect(midToType('')).toBe(0);
  });
});

describe('buildTextMessage (OkLine Message.text)', () => {
  it('has exactly the plain text fields, in order', () => {
    const message = buildTextMessage({ to: `u${'a'.repeat(32)}`, text: 'hi' });
    expect(Object.keys(message)).toEqual(['to', 'toType', 'contentMetadata', 'sessionId', 'text', 'contentType', 'hasContent']);
    expect(message).toEqual({ to: `u${'a'.repeat(32)}`, toType: 0, contentMetadata: {}, sessionId: 0, text: 'hi', contentType: 0, hasContent: false });
  });

  it('adds the reply fields and the mention metadata', () => {
    const message = buildTextMessage({ to: `c${'a'.repeat(32)}`, text: 'hi', mention: '{"MENTIONEES":[]}', replyToMessageId: '123' });
    expect(message).toMatchObject({ toType: 2, contentMetadata: { MENTION: '{"MENTIONEES":[]}' },
      relatedMessageId: '123', messageRelationType: 3, relatedMessageServiceCode: 1 });
  });
});

describe('buildMediaMessage', () => {
  it('builds the sealed image placeholder without MEDIA_CONTENT_INFO', () => {
    const message = buildMediaMessage({ to: `u${'a'.repeat(32)}`, kind: 'image', sid: 'emi', oid: 'o1', fileSize: 99, encKm: 'km', fileName: 'p.png' });
    expect(message).toMatchObject({ contentType: 1, hasContent: true, text: '', toType: 0 });
    const meta = message.contentMetadata as Record<string, string>;
    expect(meta).toMatchObject({ SID: 'emi', OID: 'o1', FILE_SIZE: '99', ENC_KM: 'km', FILE_NAME: 'p.png' });
    expect(Object.keys(meta)).toEqual(['SID', 'OID', 'FILE_SIZE', 'ENC_KM', 'FILE_NAME']);
    expect(meta.MEDIA_CONTENT_INFO).toBeUndefined();
  });

  it('builds the file placeholder without MEDIA_CONTENT_INFO', () => {
    const message = buildMediaMessage({ to: `c${'a'.repeat(32)}`, kind: 'file', sid: 'emf', oid: 'o2', fileSize: 5, encKm: 'km', fileName: 'a.pdf' });
    expect(message).toMatchObject({ contentType: 14, toType: 2 });
    expect((message.contentMetadata as Record<string, string>).MEDIA_CONTENT_INFO).toBeUndefined();
  });
});

describe('reaction, friend request builders', () => {
  it('maps the reaction contract values to OkLine PredefinedReactionType', () => {
    expect(PREDEFINED_REACTION_TYPE).toEqual({ NICE: 2, LOVE: 3, FUN: 4, AMAZING: 5, SAD: 6, OMG: 7 });
    expect(buildReactRequest(4, '99', 'OMG')).toEqual({ reqSeq: 4, messageId: '99', reactionType: { predefinedReactionType: 7 } });
    expect(buildCancelReactionRequest(5, '99')).toEqual({ reqSeq: 5, messageId: '99' });
  });

  it('builds both tracking variants of addFriendByMid', () => {
    expect(buildAddFriendRequest(1, 'uX')).toEqual({ reqSeq: 1, userMid: 'uX', tracking: { reference: '', trackingMetaV2: { friendRecommendation: {} } } });
    expect(buildAddFriendRequest(2, 'uX', 'cY')).toEqual({ reqSeq: 2, userMid: 'uX', tracking: { reference: '', trackingMetaV2: { chat: { chatMid: 'cY' } } } });
    expect(buildAddFriendRequest(3, 'uX', '')).toMatchObject({ tracking: { trackingMetaV2: { friendRecommendation: {} } } });
  });
});
