# LINE Agent Assistant

[English](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

## Features

Using LINE Chrome-type client sessions, the app lets two LINE accounts serve different roles on the same Windows computer:

- **Agent account:** Signs in to LINE, receives instructions from the administrator, and runs tasks through a locally installed Codex or Claude agent.
- **Administrator account:** Supports sign-in or monitoring mode. Monitoring reads message records stored locally by LINE.
- **Message assistant:** Shows conversations and attachments from both accounts in one place, searches message history, and lets the administrator ask the Agent to summarize conversations.
- **Conversation assistant:** Lets the Agent participate in conversations, help download files and images, and set up automatic reply rules.

## Installation

This repository provides source code. To build and run it, use Windows x64, install a supported Node.js version, and follow the prerequisites in [Building from source](docs/BUILDING.md). Then run:

```powershell
npm ci
npm run build
npm run start --workspace @line-agent/desktop
```

## License

Released under the MIT License. See [LICENSE](LICENSE).

## Non-affiliation

This is an independent, unofficial project. It is not affiliated with, endorsed by, or sponsored by LINE or any of its affiliated companies.
