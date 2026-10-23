# LINE Agent Assistant

[English](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

## 功能

這是一款 Windows 桌面應用程式，可用於處理 LINE 對話，並搭配本機安裝的 Codex 或 Claude 命令列 Agent。功能包含對話與附件檢視、Agent 工作控制、帳號監控，以及選用的本機 MCP 對話資料存取。

## 安裝

本儲存庫提供原始碼。請使用 Windows x64、安裝支援的 Node.js 版本，並依照[從原始碼建置](docs/BUILDING.md)準備必要項目。接著執行：

```powershell
npm ci
npm run build
npm run start --workspace @line-agent/desktop
```

## 授權

本專案採用 MIT License，詳見 [LICENSE](LICENSE)。

## 非官方聲明

本專案為獨立、非官方專案，與 LINE 或其任何關係企業均無隸屬、背書或贊助關係。
