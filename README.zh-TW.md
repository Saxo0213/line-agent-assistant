# LINE Agent Assistant

[English](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

[![Latest release](https://img.shields.io/github/v/release/Saxo0213/line-agent-assistant)](https://github.com/Saxo0213/line-agent-assistant/releases/latest) [![Downloads](https://img.shields.io/github/downloads/Saxo0213/line-agent-assistant/total)](https://github.com/Saxo0213/line-agent-assistant/releases) ![Platform: Windows x64](https://img.shields.io/badge/platform-Windows%20x64-0078D6) [![License: MIT](https://img.shields.io/github/license/Saxo0213/line-agent-assistant)](LICENSE)

**讓 Claude 或 Codex 幫你處理 LINE 對話。** 這是一套 Windows 桌面程式：AI Agent 可以透過 LINE 接收指令、搜尋並摘要你的聊天紀錄，還能經由本機 MCP bridge 讓 Claude Desktop 與 Codex 直接使用 LINE。

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
<li><strong>MCP bridge：</strong> 讓 Claude Desktop 與 Codex 列出對話、讀取記事本與相簿，並在你設定的帳號權限內傳送或排程訊息；端點只在本機（127.0.0.1）監聽。</li>
</ul>
</td>
<td width="40%" valign="top"><img src="docs/images/agent-line-conversation.png" alt="Agent 在 LINE 對話中回應使用者指令的畫面" width="320"></td>
</tr>
</table>

v1.0.323 讓 Claude Desktop 可透過外部 MCP bridge 完整等候 LINE 傳送，訊息轉發會帶傳送者名稱，新訊息排程會從其他帳號補上群組與傳送者名稱，連續訊息的 Agent 狀態圖示也不再互相覆蓋。可透過 App「檢查更新」安裝。完整變更請見 [v1.0.319 → v1.0.323 版本說明](docs/releases/v1.0.323.md)。

## 安裝

> [!WARNING]
> 請為 Agent 準備專用的 LINE 帳號，不要使用你的個人主要帳號。本程式透過非官方的 LINE 協定連線，LINE 變更協定、要求裝置驗證或執行帳號政策時，都可能導致無法使用。本機 MCP 端點沒有 Token 驗證，這台電腦上的任何程式都能透過它讀取已儲存的 LINE 訊息，因此請勿在與不信任的人共用的電腦上使用。

### Windows 安裝檔

前往[最新版本](https://github.com/Saxo0213/line-agent-assistant/releases/latest)，在 **Assets** 下載檔名結尾為 `Setup-x64.exe` 的安裝檔，執行後依畫面指示安裝。

### 從原始碼建置

請使用 Windows x64、安裝支援的 Node.js 版本，並依照[從原始碼建置](docs/BUILDING.md)準備必要項目。接著執行：

```powershell
npm ci
npm run build
npm run start --workspace @line-agent/desktop
```

## 參考的開源專案

- [OkLine](https://github.com/NiceDayZc/OkLine)（[說明文件](https://nicedayzc.github.io/OkLine/#start-here)、[MIT License](https://github.com/NiceDayZc/OkLine/blob/main/LICENSE)）：用於比對 LINE Chrome 用戶端的登入、登出、Token 更新與伺服器回應處理方式；本程式不在執行階段依賴 OkLine。
- [LINEJS / `@evex/linejs`](https://github.com/evex-dev/linejs)（[說明文件](https://linejs.evex.land)、[MIT License](https://github.com/evex-dev/linejs/blob/main/LICENSE)）：本程式固定版本使用的 JavaScript LINE 用戶端函式庫，提供 LINE 工作階段、登入驗證、協定請求與憑證儲存功能。

著作權聲明與授權條款以各專案的 Repository 為準。

## 授權

本專案採用 MIT License，詳見 [LICENSE](LICENSE)。

## 非官方聲明

本專案為獨立、非官方專案，與 LINE 或其任何關係企業均無隸屬、背書或贊助關係。
