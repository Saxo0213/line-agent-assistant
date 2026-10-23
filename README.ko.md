# LINE Agent Assistant

[English](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

## 기능

LINE 대화를 관리하고 로컬에 설치된 Codex 또는 Claude 명령줄 Agent와 함께 사용할 수 있는 Windows 데스크톱 앱입니다. 대화 및 첨부 파일 보기, Agent 작업 제어, 계정 모니터링, 선택형 로컬 MCP 대화 데이터 접근 기능을 제공합니다.

## 설치

이 저장소는 소스 코드를 제공합니다. Windows x64와 지원되는 Node.js 버전을 준비하고 [소스에서 빌드하기](docs/BUILDING.md)에 안내된 사전 요구 사항을 충족하세요. 그런 다음 다음 명령을 실행합니다.

```powershell
npm ci
npm run build
npm run start --workspace @line-agent/desktop
```

## 라이선스

MIT License로 배포됩니다. 자세한 내용은 [LICENSE](LICENSE)를 참조하세요.

## 비공식 프로젝트 안내

이 프로젝트는 독립적인 비공식 프로젝트입니다. LINE 또는 그 계열사와 제휴 관계가 없으며, 이들의 승인이나 후원을 받지 않습니다.
