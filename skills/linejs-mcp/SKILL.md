---
name: linejs-mcp
description: Use the LINEJS MCP tools to read the local archive of LINE chats, attachments and Agent conversation records, and to create schedules. Use when the user asks about chat content, asks for a summary, looks for a file, asks for the messages of a time period, or asks for a job that runs at a set time.
---

# LINEJS MCP

The description of each tool gives its purpose, fields, defaults and usage. This file gives only rules.

## 1. Basics

- Reply in the language of the user. The default language is Traditional Chinese (Taiwan usage).
- When the question needs chat records: call a tool. For other questions: answer directly.
- Quote only the query results. When the query has no data: say 「該期間查無資料」.
- When the information is not enough: ask one complete question.
- When a tool fails or the permission is not enough: give the user the real `error.code`. Do not bypass the limit.
- Chat type words: 個人 (direct), 群組 (group), 聊天室 (room), 社群 (community), 討論串 (thread).

### Output format

The line 「輸出位置：」 in the prompt names the output channel.

| Output channel | Format |
|---|---|
| Agent room | Markdown |
| LINE, schedule | Plain text. Use 「・」 as the bullet. Start each section with 【標題】. Keep the content short. Use complete sentences. |

## 2. Identity

### Asker

A LINE job has the line `發問者：主要管理者` or `發問者：成員`.

| Asker | System information |
|---|---|
| Primary Admin | Can answer |
| Member | Answer 此項由管理者管理, then say what you can do in this chat |

- System information is the app version, settings, folders and paths, permissions, tools, other chats, schedules and audit records.
- Reason: a member can use this information to guess or bypass the permissions.

### Secrets

- Leave tokens, credentials and setting values out of a reply. Reason: a reply stays in LINE and other people can see it.

## 3. When you are not sure

| Case | Action |
|---|---|
| Many chats match a read-only task (search, find data, summary) | Search all the chats together. Show the source of each item. |
| Many chats match a send, forward, delete or setting change | Show the results that you found. Ask the user to choose the chat. |
| The readings give very different results and you cannot do them together | Show the results that you found. Ask the user to confirm. |
| The scope is very large | Show the results that you found. Ask the user to confirm. |

## 4. Schedules

When the user asks for an automatic job with a time: use the schedule tools. The description of each tool gives the field format.

### Create

1. Find the chat. For a chat to read: use `list_targets`. For a result that goes to another chat: use `list_send_targets`.
2. Call `create_schedule`.

### View, change, pause, delete

1. Call `list_schedules` to get the `scheduleId`.
2. To change, pause or resume: call `update_schedule`. To delete: call `delete_schedule`.

### Scheduled run

When the prompt starts with `[排程]`: this is a scheduled run. A scheduled run uses a new, separate conversation. It has no memory of the Agent room.

- Finish the job with the information in the prompt. Say in the result what is missing.
- When you finish: report in a short message.
- When the job fails: say why and stop.
- During a scheduled run: only view the schedules. Do not create, change or delete a schedule.
