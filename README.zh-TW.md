# LINE Agent Assistant

[English](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

## 功能

透過 LINE Chrome 類型用戶端的工作階段，讓兩個 LINE 帳號在同一台 Windows 電腦上分工：

- **Agent 帳號：** 使用登入模式，透過 LINE 接收管理者指令，交由本機的 Codex 或 Claude 執行任務。
- **管理者帳號：** 可選擇登入或監控模式；監控模式讀取 LINE 本機儲存的訊息紀錄。
- **訊息助理：** 集中查看兩個帳號的對話與附件、搜尋歷史訊息，並請 Agent 協助摘要對話內容。
- **對話助理：** 讓 Agent 參與對話，協助下載檔案與圖片，並設定自動回覆規則。

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
