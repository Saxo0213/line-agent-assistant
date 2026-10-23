# Building from source

## Requirements

- Windows x64.
- Node.js 22.23.4 or later in the 22.x line, 24.22.1 or later in the 24.x line, or 26.12.1 or later in the 26.x line. Other major lines may not pass the repository prerequisite check.
- The Windows .NET Framework x64 compiler at `%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`.
- The Windows x64 SQLite3MultipleCiphers 2.5.1 release (SQLite 3.53.4), named `sqlite3mc-2.5.1-sqlite-3.53.4-win64.zip`. Extract `dll\sqlite3mc_x64.dll` to `.references\runtime-cache\sqlite3mc-2.5.1\dll\sqlite3mc_x64.dll` at the repository root. The build verifies that the file is 2,442,576 bytes and has SHA-256 `5030decc6d914539e3b9b7e28aa4f6de1e7161dac6fd4b21eb02e6754d9b175e`.

The official LINE desktop client is needed only for the feature that imports and monitors its local conversation history. Codex CLI and Claude Code CLI are optional; install and authenticate whichever provider you want to use.

## Build and run

From the repository root:

```powershell
npm ci
npm run build
npm run start --workspace @line-agent/desktop
```

To build a Windows installer, run `npm run package`. Build outputs are generated locally and are not included in source control.
