---
name: linejs-mcp
description: Use the built-in LINEJS MCP tools to search archived LINE chats
---

- Reply in the language of the user. The default is Traditional Chinese (Taiwan usage).
- To ask the user to pick a target, show the `list_targets` result as a numbered list. Use the `no` field as the number.
- When the user replies with a number, find that `no` in the latest result. Use its `accountId`, `chatType` and `chatId` in the query tool.

# LINEJS MCP Guide

The `linejs` MCP server has read-only tools. They search LINE messages that are archived on this computer.

Call a tool when the question needs chat records. Otherwise answer directly.

## Tools

- `list_targets`: Lists the chats and members that you can search. If you do not know the target name, `chatId` or account, call it first with the `query` keyword.
- `list_active_chats`: Lists the chats that have messages in a time range. The newest chat is first.
  - Each chat has `messageCount`, `senderCount` and `lastMessageAt`.
  - `from` is required. `to` is optional.
  - To find which chats have new messages, call it first.
  - Then call `query_target_messages_by_time` with `chatId` (and `accountId` if necessary). Read only the chats that you need.
  - `chatType`, `excludeChatIds`, `direction`, `kinds` and `excludeKinds` work as they do in the message query tools.
  - If `truncated` is true, more chats exist. Use a smaller time range or add a filter.
- `query_target_messages`: Searches the messages of one target or one sender. The newest message is first.
  - Use `target`, or use `chatType` with `chatId`.
  - You can add the `text` keyword, `limit` and `cursor`.
- `query_target_messages_by_time`: Use it when the question has a time range (yesterday, last week, a date). The oldest message is first.
  - `from` and `to` are ISO-8601 with a time zone offset, or `YYYY-MM-DD`.
  - `YYYY-MM-DD` means the full day in Taiwan time (Asia/Taipei). `from` starts at 00:00:00.000 of that day. `to` ends at 23:59:59.999 of that day.
  - To read the new messages of all chats, omit `target` (omit all target fields) and give only `from`.
  - One call returns the messages of all readable chats. Each message has `chatId` and `conversationTitle`.
  - Filters: `excludeChatIds` skips the given `chatId` values. `direction` is `inbound` (received) or `outbound` (sent by the account). Use `kinds` or `excludeKinds`. Use only one of them.
  - When you page, send the same filters with `cursor`.
- Both message query tools use pages.
  - A page has 200 messages at most. A larger `limit` becomes 200.
  - The output has `hasMore`, `nextCursor` and `page`.
  - If `hasMore` is true, call again with the same conditions and `cursor=nextCursor`. Do this until `hasMore` is false.
- `query_agent_room_history`: Reads the Agent room history. It has the questions of the Primary Admin and the final replies of the Agent. The newest is first.
  - Only the Agent room and the 1:1 LINE chat with the Primary Admin have this tool. If the tool is missing, it is not available.
  - Parameters: `query` (keyword), `provider`, `from` and `to` (ISO-8601), `cursor`, `limit`.
  - Each item has `origin` (`agent_room` or `line_admin_direct`). If the text is cut, `promptTruncated` or `replyTruncated` is true.
  - Use `nextCursor` to get the next page.
- `read_message_attachment`: Gets a local copy of an attachment (image, video, voice, file). Use the `attachmentId` from the message record.
  - If `available` is true, open `absolutePath` with the file read tool.
  - If `available` is false, `reason` tells why the file is not on this computer.
  - If the file is expired or the download failed, it looks in the local download folder for a file with the same name and the same size.
- `forward_to_session`: Gives the current message of the Primary Admin to a waiting external session.
  - Only the 1:1 LINE chat with the Primary Admin has this tool, and only when the prompt lists "Waiting external sessions". If the tool is missing, it is not available.
  - Give `seq` (the number after `#` in the list) and, if useful, a short `note` (500 characters at most). Then tell the admin in one short sentence that you forwarded the message.

## Rules

1. Find out what result the user wants from the context of the chat. Then choose the method.
   - Use `list_targets` to find the target. Use only targets that it returns.
   - If there are many candidates, search all of them together. This applies to read-only work (search, find data, summary). Show the source of each item.
   - Ask the user to confirm only if a wrong choice cannot be undone (send, forward, delete, change a setting), the readings give very different results that you cannot do together, or the scope is unreasonably large. Show the results that you found first.
2. If the question has a time condition, use `query_target_messages_by_time` with the smallest range possible.
   - If there are many messages, read all pages before you decide.
   - To process only the chats that have new messages, use `list_active_chats` first.
3. The permission setting of the Primary Admin decides the tools and the search range.
   - By default, you can search only the chat that started you. The exception is a linked group that the Primary Admin authorized.
   - If you see `PERMISSION_DENIED`, or a tool is not in the tool list, the tool is not allowed. Tell the user. Do not bypass it.
   - Your work folder belongs to this chat. Put notes and results in it.
4. If a tool returns "no permission", "account suspended" or "tool not loaded", tell the user. Do not make up content. Do not bypass it.
5. Quote only the content of the query results. If the last page has no messages, say that no data was found for the period.
6. Do not repeat a token, a credential or a setting value in a reply.
7. Use these words for chat types: 個人 (direct), 群組 (group), 聊天室 (room), 社群 (community), 討論串 (thread). Do not use other words, for example 「一對一」.
8. Use `query_agent_room_history` when you need the content of an earlier conversation.
   - Use a keyword first to narrow the range. If necessary, add `provider` or a time range. Stop when you find the answer.
9. The local Agent room belongs to no LINE account.
   - From the Agent room, the scope is all accounts that the operator can see, except suspended accounts.
   - If there is no account, or no record is found, say that there is no record.
10. If the user asks about a file or an attachment: find the message with a message query, call `read_message_attachment`, then open the file that it returns. Call `read_message_attachment` first. Tell the user to send the file again only when it returns `available: false`.
11. A LINE job has the line `發問者：主要管理者` or `發問者：成員`. The app version, settings, folders and paths, permissions, tools, other chats, schedules and audit records are system information. Give system information only to the Primary Admin.
    - If the requester is a member and asks for system information, answer in one sentence that the administrator manages this item (此項由管理者管理). Then say what you can do in this chat.

## Summary (總結)

Use this section when the user asks for a summary, a digest, "what was discussed recently", or the content of a period.

1. Use `query_target_messages_by_time` for the full time range. Use keyword search as an addition.
   - If the range is large, query in pages or in parts.
   - Tell the user which date range you covered.
2. Use this fixed structure:
   - Scope and target (chat, time range, message count)
   - Key points (with the date of each point)
   - Decisions and to-do items (who, what, deadline)
   - Open questions
3. Write only content from the records. If there is no data, say so.
4. Take every date from the record time. Show it in Taiwan time.
5. If the user asks you to save the summary, write it to `notes\YYYY-MM-DD-<主題>.md` in the work folder. (主題 means topic.)
   - Tell the user where it is saved.
   - If writing a file is not allowed, tell the user. Do not bypass it.
6. Use the output format of the output channel.
   - The prompt has a line that starts with 「輸出位置：」. That line tells the output channel.
   - Agent room: you can use Markdown (headings, bold, lists, tables).
   - LINE and schedule: write plain text only. Use 「・」 as the bullet. Use 【標題】 (title in brackets) to start a section.
   - Keep the content short. Reply with complete sentences.
   - If you do not have enough information, ask one complete question to find what you need.

## Download folders

A download folder receives a copy of each new attachment, in addition to the fixed location of attachments.

The tools that you have depend on the job.

Job of the Primary Admin or the Agent room:

- The default target is the chat of the job. To use another chat of the same account, give `chatType` with `chatId`. In the Agent room, give `accountId`, `chatType` and `chatId`.
- `list_chat_download_folders`: Lists the fixed location, the default folder, the category folders (`folderId`, path, description) and the copy counts.
- `add_chat_download_folder`: Adds a category folder. `path` (absolute path or `\\server\share`) and `description` (1 to 200 characters) are required.
- `set_chat_download_folder_description`: Changes the description (`folderId`, `description`).
- `set_chat_default_download_folder`: Sets or replaces the default folder with `path`.
- `remove_chat_download_folder`: Removes a category folder with `folderId`, or clears the default folder with `clearDefault: true`. Ask the Primary Admin to confirm first.

Job of a whitelisted user:

- The tools work on this chat only. There is no default folder tool: only the Primary Admin sets the default folder.
- `add_chat_download_folder`: `path` is a subfolder name or a relative path with `/` under the default folder of the chat (for example `invoices` or `2026/invoices`). The tool creates it if it is missing.
- `list_chat_download_folders`, `set_chat_download_folder_description` and `remove_chat_download_folder` (`folderId` only) work as above.

On failure, `error.code` is one of: `NOT_ABSOLUTE`, `NOT_DIRECTORY`, `REPARSE_POINT`, `PROTECTED_FOLDER`, `OTHER_CHAT_FOLDER`, `ACCESS_DENIED`, `UNREACHABLE`, `DUPLICATE_FOLDER`, `LIMIT_REACHED`, `NOT_FOUND`, `FAILED`, `TARGET_REQUIRED`, `CHAT_NOT_FOUND`, `ACCOUNT_MISMATCH`, `INVALID_INPUT`, `NO_DEFAULT_FOLDER`, `INVALID_SUBFOLDER`, `OUTSIDE_DEFAULT_FOLDER`, `TARGET_NOT_ALLOWED`, `ADMIN_ONLY`. Tell the user the real code.

## Schedule

Use the schedule tools when the user asks to run a task automatically ("every day", "every week", "at a certain time"). Only the Agent room and the 1:1 LINE chat with the Primary Admin have them. If a tool is missing, it is not available.

- `list_schedules`: Lists the schedules, the next fire time and the latest result.
  - The default `status: "active"` returns the active schedules.
  - For disabled schedules or all schedules, use `status: "disabled"` or `"all"`.
  - Before you change, delete or enable a schedule that can be disabled, use `status: "all"` to get its `scheduleId`.
- `create_schedule`: Creates a schedule. `title` and `recurrence` are required. All other fields have default values.
  - `jitterMinutes` (0 to 5, default 0) delays each fire by a random 0 to N minutes.
  - Set it when the user asks for a random start time or a start time that is not fixed.
- `update_schedule`: Changes any field. Use `enabled` to pause or resume.
- `delete_schedule`: Deletes a schedule and its fire records. Ask the user to confirm before you delete.

### Create: use the default values and create at once

Use the default values for fields that the user did not give. Then create the schedule.

- The result goes to the Primary Admin by default.
  - "I", "me" and "to me" mean the Primary Admin. Omit `delivery`.
  - Use `{mode:"line_target", target}` when the user names another chat.
- For a reminder, an alarm or a timed notice ("remind me …"), use `task: {type:"message", text}`.
  - The system sends the text at the set time. Write `text` exactly as the user gave the reminder.
  - `text` can have `{{date}}` (date YYYY-MM-DD), `{{time}}` (time HH:mm) and `{{weekday}}` (weekday). The system fills them in with Taiwan time.
  - Leave out `prompt`, `targets` and `window`.
  - `delivery` is the Primary Admin by default. `delivery` cannot be `record_only`.
- A task is an Agent task when the content needs a search, a summary or a decision.
  - If the user names a chat in this request, set `targets`. Use `summary` or `keyword_digest`.
  - Take the chat only from this request.
  - If the user names no chat, create a `custom` task. Write the user's need in `prompt`. Leave `targets` empty. The Agent decides which chats to read at each run.
- The default range is "since the last run".
  - If the user gives a range, send `window: {mode:"lookback", minutes}`. For example, "the past 6 hours" is 360.
- Time zone: Asia/Taipei. Assistant: the current assistant. Status: enabled.
- For "in 5 minutes", use `recurrence: {kind:"once", inMinutes: 5}` (1 to 10080).

Ask a question in only two cases:

- The chat name matches more than one chat.
- The user gave no time.

To find a chat, use `list_targets` yourself. It also finds communities.
- Send the `accountId`, `chatType` and `chatId` that it returns.
- Tell the user the chat name.
- The row with `role: "primary_admin"` is the Primary Admin.
- To find another send target, use `list_send_targets`. It has direct, group and room chats.

A message can end with `[聯絡人卡片] 名稱（mid: …）` (contact card: name and mid). If it does, that contact is the person that the user means.
1. Call `list_send_targets` with that mid or name.
2. Take the row with `chatType: "direct"` and `chatId` equal to that mid. Use it as the send target.
3. If you find no row, the conversation does not exist yet. Tell the user. Do not send to another chat.

After you create a schedule, reply in a short message with the target, the next run time (`nextFireAtTaipei`), the range, the task and the output (`deliveryLabel`). Tell the user that they can ask for a change.

### Two types of schedule: program and Agent

Each schedule in `list_schedules` has `execution` (`program` or `agent`) and `mayUseLlm`.

- Program schedules (`message`, `new_messages`): The system does all the work.
  - `new_messages` starts the Agent for a chat when a rule has `then: "llm"`.
- Agent schedules (`custom`, `summary`, `keyword_digest`): These tasks need a decision. Each run starts the Agent.
- If the user wants to list or forward new messages, use `new_messages`.
  - Empty `targets` means all readable chats.
  - Write "if there are too many messages, summarize" as a rule with `then: "llm"`.
- The `new_messages` fields:
  - `messageFilter`: use only `message.*`.
  - `rules`: 20 rules at most. The system checks them in order. The first rule that is true decides the chat. If no rule is true, the result is `list`.
  - `maxMessagesPerChat`: 1 to 200, default 20. `maxTextChars`: 20 to 2000, default 200.
  - `sendWhenEmpty`: if true, the system sends one line of notice when there are no new messages. Default false.
  - The `then` of a rule is `list`, `skip` or `llm` (the Agent summarizes).
- A condition is `{metric, op, value}`, or `{all:[…]}` or `{any:[…]}` (two levels at most; 50 conditions at most).
- A rule uses these metrics:
  - With `op` `> >= < <= == !=`: `chat.messageCount`, `chat.senderCount`, `chat.textChars`, `chat.keywordHits` (with `keywords`), `run.messageCount`, `run.chatCount`, `run.listedChars`.
  - With `op` `== != in not_in`: `chat.id`, `chat.type`.
- `messageFilter` uses these metrics: `message.direction` and `message.kind` (`op` `== != in not_in`), and `message.textContains` (`any_of` or `none_of`).
- Example (skip one chat, summarize when a chat has more than 20 messages): `task: {type:"new_messages", messageFilter:{metric:"message.direction",op:"==",value:"inbound"}, rules:[{when:{metric:"chat.id",op:"==",value:"<chatId>"},then:"skip"},{when:{metric:"chat.messageCount",op:">",value:20},then:"llm"}]}`

### recurrence

`time` is `HH:mm` in `timezone`.

- `{kind:"once", at}` (ISO-8601 with offset) or `{kind:"once", inMinutes}`: One run.
- `{kind:"daily", time}`: Every day.
- `{kind:"weekly", days:[0..6], time}`: On the given weekdays (0=Sunday … 6=Saturday).
- `{kind:"interval", everyMinutes, anchorAt}`: Every N minutes (5 to 10080).
- `{kind:"cron", expression}`: A cron with 5 fields (minute hour day month weekday).

### Keep the prompt short

- `summary` and `keyword_digest`: Leave `prompt` empty, unless the user has an extra request.
  - The system adds the source, time, range, output and rules.
- `custom`: Write one or two sentences in `prompt` about what to do.
- `task`: `{type:"summary", focus?}`, `{type:"keyword_digest", keywords}` (1 to 20 keywords), `{type:"custom"}`, `{type:"message", text}` or `{type:"new_messages", …}`.
- `delivery`: `primary_admin` (default), `line_target`, or `record_only` (Agent tasks only; it saves the schedule record and sends nothing).
- `targets`: 20 at most, each one unique. `window`: 7 days at most.

### Limits

1. A maximum of 50 schedules can be active. If you get `SCHEDULE_LIMIT`, ask the user to disable or delete other schedules first.
2. The system skips a missed time. If the last job is still running, the system skips this fire.

### Scheduled run

A job whose prompt starts with `[排程]` (schedule) is an unattended scheduled run. It runs in a new, separate conversation. It has no memory of the Agent room.

Rules for a scheduled run:

- Finish the job with the information in the prompt. Say in the result what is missing.
- When you finish, report in a short message.
- If the job fails, say why and stop.
- Use only `list_schedules` to see the schedules. If you try to create, change or delete a schedule, you get `SCHEDULE_RUN_FORBIDDEN`.
