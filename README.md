# LINE Agent Assistant

[English](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

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
</ul>
</td>
<td width="40%" valign="top"><img src="docs/images/agent-line-conversation.png" alt="Example LINE conversation with the Agent responding to a user instruction" width="320"></td>
</tr>
</table>

v1.0.310 adds program schedules: the app lists new messages by itself with composable rules and uses an LLM only where a rule selects it, plus MCP queries across all chats and a fix for date-only queries. See the [v1.0.310 release notes](docs/releases/v1.0.310.md). Earlier changes are listed in [v1.0.305](docs/releases/v1.0.305.md), [v1.0.303](docs/releases/v1.0.303.md), and [v1.0.302](docs/releases/v1.0.302.md).

## Installation

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
