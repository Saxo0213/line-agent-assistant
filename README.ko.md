# LINE Agent Assistant

[English](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

## 기능

LINE Chrome 유형 클라이언트 세션을 사용하여 한 대의 Windows 컴퓨터에서 두 LINE 계정이 역할을 나누어 수행합니다.

- **Agent 계정:** LINE에 로그인해 관리자의 지시를 받고, 로컬에 설치된 Codex 또는 Claude로 작업을 수행합니다.
- **관리자 계정:** 로그인 모드와 모니터링 모드 중에서 선택할 수 있습니다. 모니터링 모드에서는 LINE이 로컬에 저장한 메시지 기록을 읽습니다.
- **메시지 도우미:** 두 계정의 대화와 첨부 파일을 한곳에서 확인하고, 과거 메시지를 검색하며, Agent에게 대화 요약을 요청할 수 있습니다.
- **대화 도우미:** Agent가 대화에 참여해 파일과 이미지 다운로드를 돕고 자동 응답 규칙을 설정할 수 있습니다.

## 설치

### Windows 설치 파일

[최신 릴리스](https://github.com/Saxo0213/line-agent-assistant/releases/latest)를 열고 **Assets**에서 파일 이름이 `Setup-x64.exe`로 끝나는 설치 파일을 다운로드한 다음 실행하세요.

### 소스에서 빌드

Windows x64와 지원되는 Node.js 버전을 준비하고 [소스에서 빌드하기](docs/BUILDING.md)에 안내된 사전 요구 사항을 충족하세요. 그런 다음 다음 명령을 실행합니다.

```powershell
npm ci
npm run build
npm run start --workspace @line-agent/desktop
```

## 라이선스

MIT License로 배포됩니다. 자세한 내용은 [LICENSE](LICENSE)를 참조하세요.

## 비공식 프로젝트 안내

이 프로젝트는 독립적인 비공식 프로젝트입니다. LINE 또는 그 계열사와 제휴 관계가 없으며, 이들의 승인이나 후원을 받지 않습니다.
