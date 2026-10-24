# LINE Agent Assistant

[English](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

## 機能

<table>
<tr>
<td width="60%" valign="top">
<p>LINE の Chrome 型クライアントのセッションを利用し、同じ Windows PC 上で 2 つの LINE アカウントに役割を分担させます。</p>
<ul>
<li><strong>Agent アカウント：</strong> LINE にログインして管理者から指示を受け取り、ローカルにインストールされた Codex または Claude でタスクを実行します。</li>
<li><strong>管理者アカウント：</strong> ログインモードと監視モードを選べます。監視モードでは、LINE がローカルに保存したメッセージの記録を読み取ります。</li>
<li><strong>メッセージアシスタント：</strong> 両アカウントの会話と添付ファイルをまとめて確認し、過去のメッセージを検索できます。管理者は Agent に会話の要約も依頼できます。</li>
<li><strong>会話アシスタント：</strong> Agent を会話に参加させ、ファイルや画像のダウンロードを支援させたり、自動返信ルールを設定したりできます。</li>
</ul>
</td>
<td width="40%" valign="top"><img src="docs/images/agent-line-conversation.png" alt="LINE の会話で Agent がユーザーの指示に応答する例" width="320"></td>
</tr>
</table>

v1.0.254 では、アルバムのカバー表示を追加し、読み込みに失敗してもアカウントの接続を維持し、コミュニティとグループの通知の表示を修正しました。[v1.0.254 のリリースノート](docs/releases/v1.0.254.md)をご覧ください。

## インストール

### Windows インストーラー

[最新のリリース](https://github.com/Saxo0213/line-agent-assistant/releases/latest)を開き、**Assets** からファイル名が `Setup-x64.exe` で終わるインストーラーをダウンロードして実行してください。

### ソースからのビルド

Windows x64 と対応する Node.js を用意し、[ソースからのビルド](docs/BUILDING.md)に記載された要件を満たしてください。その後、次を実行します。

```powershell
npm ci
npm run build
npm run start --workspace @line-agent/desktop
```

## ライセンス

MIT License のもとで公開されています。詳しくは [LICENSE](LICENSE) をご覧ください。

## 非公式プロジェクトについて

本プロジェクトは独立した非公式プロジェクトです。LINE およびその関連会社とは提携しておらず、承認や支援も受けていません。
