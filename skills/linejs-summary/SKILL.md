---
name: linejs-summary
description: Turn LINE chat records into a summary. Use when the user asks for a summary, a digest of key points, what a chat said in a period, or when a scheduled job has a summary task.
---

# LINE chat summary

Make the summary in three passes with this file.

## Read

- Read the full time range and all pages.
- When the range is more than 7 days or 500 messages: write one partial summary for each 3 days. Then merge the partial summaries.
- Leave out these messages: a single sticker, an emoji, 「好」, 「收到」, 「哈哈」, a repeated forward, an unsent message.

## Pass 1: topic frame (no output)

| Item | Rule |
|---|---|
| Record for each topic | Time span, participants, a one-sentence statement, anchors |
| Anchor | Message ID + speaker + a piece of the original words. Copy them from the original message. |
| New topic | The gap is more than 30 minutes, the participants change, or the content jumps |
| Count as a topic | 2 or more people take part, or the content has substance |
| Who replies to whom | When a message has a reply quote: use the quote chain. Record different speakers separately. Split into two topics when you are not sure. |
| Record also | A message that has @Primary Admin, a question to the Primary Admin that has no answer, an unsolved question |

## Pass 2: write the summary

- Go back to the anchors of each topic. Write in full from the original text.
- Write the topics first. Then write 【概覽】 from the topics.
- When a section has no content: leave out the whole section. When 【需要你處理】 has no content: write 「無」.

| Section | Content |
|---|---|
| 【範圍】 | Chat, period, message count, speaker count |
| 【概覽】 | 1–2 sentences. The most important topic first. |
| 【需要你處理】 | A message with @you, a question to you that has no answer, a matter that waits for your decision |
| 【話題名稱】 | One section for each topic, 3–6 sections. Name the heading with the content of the topic. |
| 【待解決】 | Question・asker・status (已解決／部分解決／未解決)・solution |
| 【檔案與連結】 | Sharer・file name or article title・full URL |

Writing rules:

- Merge a discussion of many people into one section.
- When a person appears for the first time: write the speaker name.
- For a sentence where the exact words matter: quote the original words with 「」. Paraphrase all other content.
- When opinions differ: write who each side is and what each side says.
- Keep person names, product names, URLs and article titles in the original text.
- Date: write it only when there is a deadline or the time point is important. Use Taiwan time.
- LINE output: keep the total to 15 lines or less. When it is longer: keep only the most important topics.
- Many chats: write one summary for each chat. Use the table above for each one.
- When a chat has no messages in the period: write only one line 「<聊天室>：此時段無訊息」.

Example (LINE):

```
【範圍】產品開發群・11/27–11/28・142 則・6 人
【概覽】新版上線日期定在 12/5；報價單格式還在討論。
【需要你處理】
・小美問：測試機何時寄出？（未回）
・阿明等你決定：是否延後 12/5 上線
【上線時程】阿明提議 12/5 上線，小美擔心測試不足，建議延一週；最後暫定 12/5，週三再確認。
【報價單格式】小華貼了新版範本，阿明要求加稅額欄位，小華說「明天改好」。
【待解決】
・測試機寄送・小美・未解決・無方案
【檔案與連結】
・小華・報價單範本v3.xlsx
```

## Pass 3: check

- Compare with the frame: each topic has a place in the summary.
- For each 「」 quote and each "a person said": go back to the original message. Confirm the original words and the speaker.
- When you cannot find the original words: change them to the original text or delete them. When the speaker is wrong: correct the name.
- Write only content that is in the records.

## Save

- When the user asks to save the summary: write it to `notes\YYYY-MM-DD-<主題>.md` in the work folder. Tell the user where you saved the file.
