# Agent CLI Bridge

Windows 10/11 x64, Main/background only. Construct `AgentCliBridge` with configured
`workspaceRoots`; Agent execution is enabled by default and can be disabled with
`enabled: false`.
The package is independent of LINE and database services.

- `getAuthStatus(provider)` uses only official CLI status commands and returns
  `installed`, observed login state, and isolated environment variable names. It
  accepts the CLI's supported authentication methods;
  no account email, credential values or auth file paths are returned.
- `openLogin(provider)` launches the official interactive login in its own visible
  Windows console; the promise resolves when the login command exits. `logout`
  uses the official command. Login times out after ten minutes.
- `health(provider)` reports executable name/kind, version and protocol confidence.
  Codex 0.144.5 and Claude 2.1.295 are fixture validated (`supported`). Newer releases
  in the same major line are `unverified` and allowed with a warning; older or new
  major versions are `incompatible`. Main should display the returned warning.
- `run(request)` streams session/text/terminal events; prompts go only to stdin.
  It verifies canonical workspace containment and CLI compatibility before launch,
  then starts the official CLI without a separate auth-status probe. A failed CLI
  run is reported as `AUTH_REQUIRED` only when its diagnostic identifies an
  authentication problem; other nonzero exits remain `CLI_EXIT`. Terminal success
  is held until process exit, so late nonzero exit cannot deliver a successful final
  response.
- Resume defaults to rejected. Main must inject `validateResumeSession(request)`
  that checks provider, source chat, active generation and session ID against its
  persisted state. Chat text must not supply this callback or trusted install roots.
- `cancel(jobId)` and `shutdown()` request termination of owned Jobs and wait at
  most five seconds. A cancellation error means termination was not confirmed;
  callers must not start a replacement job until this is handled. Early iterator
  disposal also cleans up its process.

## Build and smoke check

Run `npm install`, then `npm run build` from the repository root. Building and
testing requires Windows x64, Node 24 and the Windows .NET Framework x64 compiler
at `%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`. The build script
validates the absolute compiler location and uses `shell: false`; no PowerShell
or cmd process participates in runtime execution.

`native/JobHost.cs` builds to ignored `dist/native/JobHost.exe`. A desktop release
must package this generated executable as an unpacked resource; if moved from its
default relative location, inject `new NodeProcessRunner({hostFile})` from Main.
Do not commit generated binaries. A missing host fails the optional Agent status
or request safely.

After building, `node packages/agent-bridge/scripts/auth-smoke.mjs` performs only
CLI version and auth status checks. It never sends model prompts or reads credential
files. Live agent execution and interactive browser login remain manual acceptance
tests; the automated suite uses harmless local fixtures.

## Process and executable boundaries

Native binaries in canonical trusted installation roots take precedence over npm
shims. Defaults cover standard per-user npm/Claude/WinGet installs and the system
Node directory. Custom install directories must be explicitly trusted by Main.
Only the recognized npm shim template plus its matching official package manifest
and fixed entrypoint are accepted. Its entrypoint runs with a separately resolved
Node 24 `node.exe`; Electron's `process.execPath` is never used as Node.

The native host atomically assigns a suspended child to an unnamed Windows Job
Object at creation using `PROC_THREAD_ATTRIBUTE_JOB_LIST`, then resumes it. The
Job handle is non-inheritable and uses `KILL_ON_JOB_CLOSE`, without breakaway flags.
A per-job cancellation event terminates the Job and waits for zero active processes.
Host crash closes the Job; owning application exit is detected via a parent process
handle. A normal CLI exit also cleans any remaining descendants.

This is process ownership, not an OS sandbox. Claude uses the required restricted
mode, fixed cwd and Read/Glob/Grep allowlist; Codex uses workspace-write sandboxing.
Executable trust is based on canonical installation roots and known package layout,
not publisher-signature attestation. Normal same-user modification of trusted CLI
installs is outside the bridge's isolation boundary.
