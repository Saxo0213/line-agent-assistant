# LINE Agent Assistant

[English](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

[![Latest release](https://img.shields.io/github/v/release/Saxo0213/line-agent-assistant)](https://github.com/Saxo0213/line-agent-assistant/releases/latest) [![Downloads](https://img.shields.io/github/downloads/Saxo0213/line-agent-assistant/total)](https://github.com/Saxo0213/line-agent-assistant/releases) ![Platform: Windows x64](https://img.shields.io/badge/platform-Windows%20x64-0078D6) [![License: MIT](https://img.shields.io/github/license/Saxo0213/line-agent-assistant)](LICENSE)

**Claude나 Codex에게 LINE 대화를 맡기세요.** AI 에이전트가 LINE으로 지시를 받고, 대화 기록을 검색·요약하며, 로컬 MCP bridge를 통해 Claude Desktop과 Codex에서 LINE을 사용할 수 있게 해 주는 Windows 데스크톱 앱입니다.

## 기능

<table>
<tr>
<td width="60%" valign="top">
<p>LINE Chrome 유형 클라이언트 세션을 사용하여 한 대의 Windows 컴퓨터에서 두 LINE 계정이 역할을 나누어 수행합니다.</p>
<ul>
<li><strong>Agent 계정:</strong> LINE에 로그인해 관리자의 지시를 받고, 로컬에 설치된 Codex 또는 Claude로 작업을 수행합니다.</li>
<li><strong>관리자 계정:</strong> 로그인 모드와 모니터링 모드 중에서 선택할 수 있습니다. 모니터링 모드에서는 LINE이 로컬에 저장한 메시지 기록을 읽습니다.</li>
<li><strong>메시지 도우미:</strong> 두 계정의 대화와 첨부 파일을 한곳에서 확인하고, 과거 메시지를 검색하며, Agent에게 대화 요약을 요청할 수 있습니다.</li>
<li><strong>대화 도우미:</strong> Agent가 대화에 참여해 파일과 이미지 다운로드를 돕고 자동 응답 규칙을 설정할 수 있습니다.</li>
<li><strong>MCP bridge:</strong> Claude Desktop과 Codex에서 대화 목록 조회, 노트와 앨범 읽기, 설정한 계정 권한 범위 내의 메시지 전송과 예약을 할 수 있습니다. 엔드포인트는 이 컴퓨터(127.0.0.1)에서만 수신합니다.</li>
</ul>
</td>
<td width="40%" valign="top"><img src="docs/images/agent-line-conversation.png" alt="LINE 대화에서 Agent가 사용자 지시에 응답하는 예시" width="320"></td>
</tr>
</table>

v1.0.323에서는 Claude Desktop이 외부 MCP bridge를 통한 LINE 전송을 끝까지 기다리고, 전달 메시지에 발신자 이름이 붙으며, 새 메시지 예약이 다른 계정에서 그룹 이름과 발신자 이름을 채우고, 연속 메시지의 Agent 상태 아이콘이 서로 덮어쓰지 않습니다. 앱의 '업데이트 확인'으로 설치할 수 있습니다. 자세한 내용은 [v1.0.319 → v1.0.323 릴리스 노트](docs/releases/v1.0.323.md)를 참조하세요.

## 설치

> [!WARNING]
> Agent에는 개인 주 계정이 아닌 전용 LINE 계정을 사용하세요. 이 앱은 비공식 LINE 프로토콜로 연결되므로 LINE 측 변경, 기기 인증, 계정 정책 적용으로 인해 사용할 수 없게 될 수 있습니다. 로컬 MCP 엔드포인트에는 토큰 인증이 없어 이 컴퓨터의 모든 프로그램이 저장된 LINE 메시지를 읽을 수 있으므로, 신뢰할 수 없는 사람과 함께 쓰는 컴퓨터에서는 사용하지 마세요.

### Windows 설치 파일

[최신 릴리스](https://github.com/Saxo0213/line-agent-assistant/releases/latest)를 열고 **Assets**에서 파일 이름이 `Setup-x64.exe`로 끝나는 설치 파일을 다운로드한 다음 실행하세요.

### 소스에서 빌드

Windows x64와 지원되는 Node.js 버전을 준비하고 [소스에서 빌드하기](docs/BUILDING.md)에 안내된 사전 요구 사항을 충족하세요. 그런 다음 다음 명령을 실행합니다.

```powershell
npm ci
npm run build
npm run start --workspace @line-agent/desktop
```

## 참고한 오픈 소스 프로젝트

- [OkLine](https://github.com/NiceDayZc/OkLine) ([문서](https://nicedayzc.github.io/OkLine/#start-here), [MIT License](https://github.com/NiceDayZc/OkLine/blob/main/LICENSE)): LINE Chrome 클라이언트의 로그인, 로그아웃, 토큰 갱신 및 서버 응답 처리를 비교·확인하는 구현 참고 자료로 사용했습니다. 런타임 의존성은 아닙니다.
- [LINEJS / `@evex/linejs`](https://github.com/evex-dev/linejs) ([문서](https://linejs.evex.land), [MIT License](https://github.com/evex-dev/linejs/blob/main/LICENSE)): 이 앱이 버전을 고정해 사용하는 JavaScript LINE 클라이언트 라이브러리로, LINE 세션, 인증, 프로토콜 요청 및 인증 정보 저장을 제공합니다.

저작권 고지와 라이선스 조건은 각 프로젝트 저장소를 확인하세요.

## 라이선스

MIT License로 배포됩니다. 자세한 내용은 [LICENSE](LICENSE)를 참조하세요.

## 비공식 프로젝트 안내

이 프로젝트는 독립적인 비공식 프로젝트입니다. LINE 또는 그 계열사와 제휴 관계가 없으며, 이들의 승인이나 후원을 받지 않습니다.
