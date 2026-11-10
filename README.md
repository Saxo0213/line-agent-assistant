# LINE Agent Assistant

[English](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

[![Latest release](https://img.shields.io/github/v/release/Saxo0213/line-agent-assistant)](https://github.com/Saxo0213/line-agent-assistant/releases/latest) [![Downloads](https://img.shields.io/github/downloads/Saxo0213/line-agent-assistant/total)](https://github.com/Saxo0213/line-agent-assistant/releases) ![Platform: Windows x64](https://img.shields.io/badge/platform-Windows%20x64-0078D6) [![License: MIT](https://img.shields.io/github/license/Saxo0213/line-agent-assistant)](LICENSE)

**Put Claude or Codex to work on your LINE chats.** A Windows desktop app that lets an AI agent take instructions over LINE, search and summarize your chat history, and give Claude Desktop and Codex access to LINE through a local MCP bridge.

## Features

<table>
<tr>
<td width="60%" valign="top">
<p>Using LINE Chrome-type client sessions, the app lets two LINE accounts serve different roles on the same Windows computer:</p>
<ul>
<li><strong>Agent account:</strong> Signs in to LINE, receives instructions from the administrator, and runs tasks through a locally installed Codex or Claude agent.</li>
<li><strong>Administrator account:</strong> Supports sign-in or monitoring mode. Monitoring reads message records stored locally by LINE.</li>
<li><strong>Message assistant:</strong> Shows conversations and attachments from both accounts in one place, searches message history, and lets the administrator ask the Agent to summarize conversations.</li>
<li><strong>Conversation assistant:</strong> Lets the Agent participate in conversations, help download files and images, and set up automatic reply rules.</li>
<li><strong>MCP bridge:</strong> Lets Claude Desktop and Codex list conversations, read Notes and Albums, and send or schedule messages within the account permissions you set, through an endpoint that listens only on this computer (127.0.0.1).</li>
</ul>
</td>
<td width="40%" valign="top"><img src="docs/images/agent-line-conversation.png" alt="Example LINE conversation with the Agent responding to a user instruction" width="320"></td>
</tr>
</table>

v1.0.323 lets Claude Desktop wait for LINE sends through the external MCP bridge, starts forwarded messages with the sender name, fills group and sender names in new-message schedules from other accounts, and keeps the Agent status icons of consecutive messages from overwriting each other. Install through the app's **Check for updates**. See the [v1.0.319 → v1.0.323 release notes](docs/releases/v1.0.323.md) for the complete changes.

## Installation

> [!WARNING]
> Use a dedicated LINE account for the Agent, not your personal primary account. This app connects through an unofficial LINE protocol, so it can stop working after LINE changes, device verification, or account-policy enforcement. The local MCP endpoint has no token: any program on this computer can read stored LINE messages through it, so do not use the app on a computer shared with people you do not trust.

### Windows installer

Open the [latest release](https://github.com/Saxo0213/line-agent-assistant/releases/latest), download the installer whose filename ends in `Setup-x64.exe` under **Assets**, and run it.

### Build from source

To build and run the source code, use Windows x64, install a supported Node.js version, and follow the prerequisites in [Building from source](docs/BUILDING.md). Then run:

```powershell
npm ci
npm run build
npm run start --workspace @line-agent/desktop
```

## Referenced open-source projects

- [OkLine](https://github.com/NiceDayZc/OkLine) ([documentation](https://nicedayzc.github.io/OkLine/#start-here), [MIT License](https://github.com/NiceDayZc/OkLine/blob/main/LICENSE)): Used as an implementation reference when comparing LINE Chrome client login, logout, token refresh, and server response handling. It is not a runtime dependency.
- [LINEJS / `@evex/linejs`](https://github.com/evex-dev/linejs) ([documentation](https://linejs.evex.land), [MIT License](https://github.com/evex-dev/linejs/blob/main/LICENSE)): The pinned JavaScript LINE client library used by this application for LINE sessions, authentication, protocol requests, and credential storage.

Copyright notices and license terms are maintained in each project's repository.

## License

Released under the MIT License. See [LICENSE](LICENSE).

## Non-affiliation

This is an independent, unofficial project. It is not affiliated with, endorsed by, or sponsored by LINE or any of its affiliated companies.
