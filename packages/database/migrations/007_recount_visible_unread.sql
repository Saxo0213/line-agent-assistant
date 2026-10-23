UPDATE conversations c SET unread_count = (
  SELECT count(*)::integer FROM messages m
  JOIN line_accounts la ON la.account_id = m.account_id
  WHERE m.account_id = c.account_id AND m.chat_type = c.chat_type AND m.chat_id = c.chat_id
    AND m.ingestion_source = 'live' AND m.kind <> 'event' AND m.sender_id IS DISTINCT FROM la.own_mid
);
