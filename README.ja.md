# LINE Agent Assistant

[English](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

## 機能

Windows デスクトップアプリで LINE の会話を扱い、ローカルにインストールした Codex または Claude のコマンドライン Agent と連携できます。会話と添付ファイルの表示、Agent タスクの操作、アカウント監視、任意のローカル MCP による会話データへのアクセスを備えています。

## インストール

このリポジトリにはソースコードが含まれています。Windows x64 と対応する Node.js を用意し、[ソースからのビルド](docs/BUILDING.md)に記載された要件を満たしてください。その後、次を実行します。

```powershell
npm ci
npm run build
npm run start --workspace @line-agent/desktop
```

## ライセンス

MIT License のもとで公開されています。詳しくは [LICENSE](LICENSE) をご覧ください。

## 非公式プロジェクトについて

本プロジェクトは独立した非公式プロジェクトです。LINE およびその関連会社とは提携しておらず、承認や支援も受けていません。
