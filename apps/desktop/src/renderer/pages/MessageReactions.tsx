import { useDesktopText } from '../desktop-i18n.js';
import React from 'react';
import type { DesktopApi } from '../../preload/api.js';
import type { TimelineMessage } from '../../main/service-facade.js';
import { LineMediaImage } from '../LineMediaImage.js';
import { LINE_REACTION_GLYPHS } from '../AgentStatusMarker.js';

type Reaction = NonNullable<TimelineMessage['reactions']>[number];

/** Reaction pills under a bubble: neutral glyphs for predefined kinds, the cached sticon image for paid ones. */
export function MessageReactions({ api, message }: { api: DesktopApi; message: Pick<TimelineMessage, 'accountId' | 'chatType' | 'chatId' | 'messageId' | 'reactions'> }) {
  const desktopText = useDesktopText();
  const reactions = message.reactions;
  if (!reactions || reactions.length === 0) return null;
  return <div className="message-reactions">
    {reactions.map((reaction: Reaction) => {
      const names = reaction.reactorNames.join('、');
      const label = reaction.kind === 'PAID' ? desktopText('reactions') : reaction.kind;
      const paid = reaction.kind === 'PAID' && reaction.productId && reaction.emojiId;
      return <span key={`${reaction.kind}:${reaction.productId ?? ''}:${reaction.emojiId ?? ''}`} className="message-reaction"
        role="img" title={names} aria-label={desktopText('arg0Arg1PeopleArg2', { arg0: label, arg1: reaction.count, arg2: names })}>
        {reaction.kind === 'PAID'
          ? paid
            ? <LineMediaImage api={api} enabled accessibleFallback fallback={desktopText('reactions')} className="message-reaction-icon"
              target={{ type: 'reaction', accountId: message.accountId, chatType: message.chatType, chatId: message.chatId,
                messageId: message.messageId, productId: reaction.productId!, emojiId: reaction.emojiId! }} />
            : <span className="message-reaction-fallback">{desktopText('reactions')}</span>
          : <span className="message-reaction-icon" aria-hidden="true">{LINE_REACTION_GLYPHS[reaction.kind]}</span>}
        {reaction.count > 1 && <span className="message-reaction-count">{reaction.count}</span>}
      </span>;
    })}
  </div>;
}
