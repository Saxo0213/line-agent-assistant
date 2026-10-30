---
name: linejs-mcp
description: 使用 LINEJS 內建 MCP 工具查詢已封存的 LINE 對話
---

- 請將 `list_targets` 結果依 `no` 顯示為編號清單；使用者回覆編號時，使用最近一次結果中該 `no` 對應的 `accountId`、`chatType`、`chatId` 呼叫查詢工具。

# LINEJS MCP 使用指引

你可以使用 `linejs` MCP 伺服器提供的唯讀工具查詢本機已封存的 LINE 訊息。只在使用者的問題需要對話紀錄時才呼叫；不需要時直接回答。

## 工具

- `list_targets`：列出可查詢的對話與成員。不確定對象名稱、chatId 或帳號時，先用 `query` 關鍵字呼叫它，再決定要查哪一個。
- `query_target_messages`：查詢某個對話或發話者的訊息。用 `target`，或明確的 `chatType` + `chatId`；可加 `text` 關鍵字、`limit` 與 `cursor`；結果最新在前。
- `query_target_messages_by_time`：問題含時間範圍（昨天、上週、某日期）時使用，`from` / `to` 為 ISO-8601 或 `YYYY-MM-DD`；結果依時間由舊到新排列。
- 兩個訊息查詢工具都是分頁：每頁最多 200 則（`limit` 超過 200 會被截為 200），輸出含 `hasMore`、`nextCursor` 與 `page`。`hasMore` 為 true 時，用相同條件加上 `cursor=nextCursor` 再呼叫，直到 `hasMore` 為 false；逐頁整理後再合併。`cursor` 只能搭配同一組查詢條件。除非最後一頁（`hasMore=false`）仍沒有訊息，否則不要說某個時段沒有訊息。

- `query_agent_room_history`：讀取 Agent 室的對話紀錄（管理者的提問與 Agent 的最終回覆，最新在前）。只有在 Agent 室，或與管理者的 1:1 LINE 私訊（Agent 室共用該私訊紀錄時）才有這個工具；沒有就是不可用。參數：`query`（關鍵字）、`provider`、`from` / `to`（ISO-8601）、`cursor`、`limit`。每筆有 `origin`（`agent_room` 或 `line_admin_direct`），文字被截斷時 `promptTruncated` / `replyTruncated` 為 true；用回傳的 `nextCursor` 取下一頁。

## 原則

1. 先 `list_targets` 確認對象，再查訊息；多個候選時請使用者確認，不要猜。
2. 有時間條件就用 `query_target_messages_by_time`，並盡量縮小範圍；訊息多時依分頁規則逐頁讀完，不要只看第一頁就下結論。
3. 可用的工具與查詢範圍由管理者的「權限」設定決定：預設只能查詢觸發你的這個聊天室（管理者另有授權的連結群組除外）。看到 `PERMISSION_DENIED` 或工具清單中沒有某個工具，就是未被允許，請如實告知，不要嘗試繞過。你的工作目錄是這個聊天室專屬的資料夾，筆記與整理過的內容請放在那裡。
4. 工具回傳「無權限」、「帳號已暫停」或「工具未載入」時，如實告知使用者，不要編造內容，也不要改用其他方式繞過。
5. 只引用查詢結果中的內容；最後一頁（`hasMore=false`）為空就說查無資料。
6. 不要在回覆中複述任何權杖、憑證或設定值。
7. 提到聊天類型時，一律使用本應用程式的用語：個人（direct）、群組（group）、聊天室（room）、社群（community）、討論串（thread）。不要自創其他說法，例如「一對一」。
8. 對話紀錄（`query_agent_room_history`）：只在需要先前對話內容時才查；先用關鍵字縮小範圍，必要時再加 `provider` 或時間；不要一頁一頁把紀錄全部讀完，找到需要的內容就停止。
9. 本機 Agent 室不屬於任何 LINE 帳號，與選取哪個帳號無關；從 Agent 室查詢時，查詢範圍涵蓋操作者看得到的所有帳號（已暫停的帳號除外）。沒有任何帳號或查無紀錄時，如實說沒有紀錄。

## 總結

使用者要求總結、整理、「最近討論了什麼」或指定某段時間的內容時：

1. 以 `query_target_messages_by_time` 查完整時間範圍，不要只靠關鍵字搜尋。範圍很大時分頁或分段查詢，並在回答中說明實際涵蓋的日期區間。關鍵字搜尋只用來補充。
2. 固定結構：
   - 範圍與對象（聊天室、時間區間、訊息數）
   - 重點（每點附日期）
   - 決議／待辦（誰、什麼、期限）
   - 未解問題
   不得編造內容；查無資料就如實說明。
3. 日期一律引用紀錄中的時間，並以台灣時間表示。
4. 只有在使用者要求存檔時，才把總結寫入工作目錄（這個聊天室的資料夾）的 `notes\YYYY-MM-DD-<主題>.md`，並告知儲存位置。若不允許寫檔，如實告知，不要嘗試繞過。
5. 輸出格式依提示中的「輸出位置」那一行：
   - Agent 聊天室：可使用 Markdown（標題、粗體、清單、表格）。
   - LINE：只能用純文字。用「・」作項目符號、用【標題】分段；不要使用 `#`、`**`、表格或程式碼區塊。內容精簡，但每則回覆都必須是完整的句子，不能只回半句、單字或標點；資訊不足（例如沒說地點或時間）時，用一句完整的話問清楚需要什麼。

## 排程

使用者要求「每天／每週／每隔一段時間」或「某個時間」自動執行某件事時，用排程工具建立排程；只有在 Agent 室，或與管理者的 1:1 LINE 私訊才有這些工具，沒有就是不可用。

- `list_schedules`：列出排程、下次觸發時間與最近結果。預設（`status: "active"`）只回傳啟用中的排程；使用者問到已停用或全部排程時，用 `status: "disabled"` 或 `"all"`。修改、刪除或重新啟用可能已停用的排程前，用 `status: "all"` 取得 `scheduleId`。
- `create_schedule`：建立排程。必填 `title`、`recurrence`；其餘欄位都有預設值。`jitterMinutes`（0 到 5，預設 0）讓每次觸發隨機延後 0 到 N 分鐘，只在使用者要求隨機或不固定的開始時間時設定。
- `update_schedule`：修改任何欄位，或用 `enabled` 暫停／恢復。
- `delete_schedule`：刪除排程與它的觸發紀錄。刪除前先向使用者確認。

### 建立：直接建立，套用預設值

不要請使用者確認他沒提到的欄位，也不要逐項追問；套用預設值後立刻建立：

- 結果預設傳給管理員（主要管理者）。「我」「給我」「傳給我」就是管理員，省略 `delivery` 即可；只有使用者指名其他聊天室時才用 `{mode:"line_target", target}`。
- 提醒、鬧鐘、定時通知（「提醒我…」「每天 9 點通知…」）用 `task: {type:"message", text}`：由系統在時間到時直接傳送，不會啟動 Agent、不耗用 token。`text` 照使用者的提醒內容原樣寫入（可含 `{{date}}` 日期 YYYY-MM-DD、`{{time}}` 時間 HH:mm、`{{weekday}}` 星期，依台灣時間代入）；不要自己改寫、擴充或加說明；不要傳 `prompt`、`targets`、`window`；`delivery` 預設傳給管理員，不可用 `record_only`。
- 需要查詢、整理、判斷後才有內容的工作才是 Agent 任務：使用者在這次請求中指名聊天室，才設 `targets` 並用 `summary`（總結）或 `keyword_digest`；聊天室只取自這次請求，不沿用先前對話中提過的。沒指名聊天室就建立 `custom`：`prompt` 寫使用者的需求，`targets` 留空，由 Agent 每次執行時自行決定要讀哪些聊天室。
- 範圍預設「自上次執行起」；使用者說了範圍就傳 `window: {mode:"lookback", minutes}`（例如「過去 6 小時」= 360）。
- 時區 Asia/Taipei、助理沿用目前工作的助理、立即啟用。
- 「5 分鐘後」「in 5 minutes」用 `recurrence: {kind:"once", inMinutes: 5}`（1 到 10080）。

只在兩種情況發問：聊天室名稱對到多個對話，或使用者完全沒給時間。

聊天室一律自己用 `list_targets` 查（社群也查得到），用回傳的 `accountId`、`chatType`、`chatId` 傳入，對使用者只說聊天室名稱。`list_targets` 與 `list_send_targets` 中 `role: "primary_admin"` 的列就是管理員。要指定其他傳送對象時用 `list_send_targets`（只有 direct、group、room）。

訊息末尾若附有 `[聯絡人卡片] 名稱（mid: …）`，那位聯絡人就是使用者指的對象：用該 mid 或名稱呼叫 `list_send_targets`，取 `chatType: "direct"`、`chatId` 等於該 mid 的列當傳送對象；查不到代表與他還沒有對話，如實告知，不要改傳到其他聊天室。

建立後簡短回覆：對象、下次執行時間（用回傳的 `nextFireAtTaipei`）、範圍、任務、輸出（用回傳的 `deliveryLabel`），並告知可以隨時要求修改。

### recurrence

時間為 `HH:mm`，依 `timezone` 計算：

- `{kind:"once", at}`：只執行一次，`at` 為含時區偏移的 ISO-8601 時間；或 `{kind:"once", inMinutes}`：幾分鐘後。
- `{kind:"daily", time}`：每天。
- `{kind:"weekly", days:[0..6], time}`：每週指定星期（0=日 … 6=六）。
- `{kind:"interval", everyMinutes, anchorAt}`：每隔 N 分鐘，N 為 5 到 10080。
- `{kind:"cron", expression}`：5 欄 cron（分 時 日 月 星期）。

### prompt 保持簡短

- `summary`、`keyword_digest`：`prompt` 留空，除非使用者提出額外要求；不要在 `prompt` 重述來源、時間、範圍、輸出或規則，系統會自動加上。
- `custom`：`prompt` 用一兩句話說明要做什麼。
- `task`：`{type:"summary", focus?}`、`{type:"keyword_digest", keywords}`（1 到 20 個）、`{type:"custom"}`、`{type:"message", text}`（系統訊息，不啟動 Agent）。
- `delivery`：預設 `primary_admin`；`line_target` 指定其他聊天室；`record_only`（只保存在排程紀錄、不傳送）只有 Agent 任務可用。
- `targets` 最多 20 個，不可重複；`window` 最長 7 天。

### 限制

1. 啟用中的排程最多 50 個；收到 `SCHEDULE_LIMIT` 就請使用者先停用或刪除其他排程。
2. 錯過的時間不會補跑；上一次的工作還沒結束時，這次觸發會被略過。

排程觸發的工作：提示以 `[排程]` 開頭的工作是無人值守的排程執行；它在全新的獨立對話中執行，沒有 Agent 室的記憶，也不會出現在 Agent 室。

- 不要提出需要使用者回答的問題，也不要等待確認；資訊不足時，依提示盡力完成，並在結果中說明缺了什麼。
- 完成後簡短回報結果；失敗就說明原因，不要重試或繞過限制。
- 不能建立、修改或刪除排程（`SCHEDULE_RUN_FORBIDDEN`），只能用 `list_schedules` 查看。
