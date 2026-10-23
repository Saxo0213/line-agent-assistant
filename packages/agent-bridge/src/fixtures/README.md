# Offline protocol fixtures

These are synthetic, credential-free contract examples. They were not captured by
running a model prompt. Installed versions were checked only with `--version` and
official auth status commands on 2026-10-15.

- `codex-0.144.5.jsonl` follows the versioned
  [Codex exec event definitions](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/exec/src/exec_events.rs).
  Items contain cumulative agent-message text; the terminal event contains usage,
  not the final response text.
- `claude-2.1.295.jsonl` covers the init, partial stream, assistant and terminal
  result shapes described in the official
  [Claude streaming documentation](https://code.claude.com/docs/en/agent-sdk/streaming-output).
  Nonessential init and assistant metadata is abbreviated; the parser validates
  every field it consumes. Version confidence is surfaced through `health`.
- `auth-cli.cjs` reproduces the observed Codex stderr status and Claude subscription
  JSON without opening or reading credential files.
- The other helpers exercise stdin/argv/cwd/environment handling, detached process
  descendants, parent/host failure and a deliberately unresponsive cancellation
  helper. They make no service calls.
