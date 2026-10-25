# LINE Agent Assistant

[English](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

## 功能

<table>
<tr>
<td width="60%" valign="top">
<p>透過 LINE Chrome 類型用戶端的工作階段，讓兩個 LINE 帳號在同一台 Windows 電腦上分工：</p>
<ul>
<li><strong>Agent 帳號：</strong> 使用登入模式，透過 LINE 接收管理者指令，交由本機的 Codex 或 Claude 執行任務。</li>
<li><strong>管理者帳號：</strong> 可選擇登入或監控模式；監控模式讀取 LINE 本機儲存的訊息紀錄。</li>
<li><strong>訊息助理：</strong> 集中查看兩個帳號的對話與附件、搜尋歷史訊息，並請 Agent 協助摘要對話內容。</li>
<li><strong>對話助理：</strong> 讓 Agent 參與對話，協助下載檔案與圖片，並設定自動回覆規則。</li>
</ul>
</td>
<td width="40%" valign="top"><img src="docs/images/agent-line-conversation.png" alt="Agent 在 LINE 對話中回應使用者指令的畫面" width="320"></td>
</tr>
</table>

v1.0.260 可更換 Agent LINE 帳號；舊帳號的聊天與附件仍留在舊帳號，新帳號使用獨立資料。新的系統錯誤會記錄經驗證的 IPC 動作名稱；歷史錯誤會清楚標示當時未記錄動作名稱。請參閱 [v1.0.260 版本說明](docs/releases/v1.0.260.md)。

## 安裝

### Windows 安裝檔

前往[最新版本](https://github.com/Saxo0213/line-agent-assistant/releases/latest)，在 **Assets** 下載檔名結尾為 `Setup-x64.exe` 的安裝檔，執行後依畫面指示安裝。

### 從原始碼建置

請使用 Windows x64、安裝支援的 Node.js 版本，並依照[從原始碼建置](docs/BUILDING.md)準備必要項目。接著執行：

```powershell
npm ci
npm run build
npm run start --workspace @line-agent/desktop
```

## 授權

本專案採用 MIT License，詳見 [LICENSE](LICENSE)。

## 非官方聲明

本專案為獨立、非官方專案，與 LINE 或其任何關係企業均無隸屬、背書或贊助關係。
