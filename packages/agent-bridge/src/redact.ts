/** Redact complete diagnostics, never individual chunks that may split a token. */
export function redactSensitive(value:string):string {
  return value
    .replace(/(authorization\s*["']?\s*[:=]\s*["']?)(?:bearer|basic)\s+[^\s"',;]+/gi,'$1[REDACTED]')
    // Start at an identifier boundary, so a long nonmatching word is scanned
    // once rather than retrying the greedy prefix at each character. Keep the
    // generic suffixes inside the prefix branch for LINE_TOKEN/client_credential.
    .replace(/(["']?\b[A-Z0-9_]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|secret|password|token|certificate|credential)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,'$1[REDACTED]')
    .replace(/\bli_job_[A-Za-z0-9_-]{20,}/g,'[REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}/g,'[REDACTED]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,'[REDACTED]')
    .replace(/(\b(?:postgres(?:ql)?|https?):\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[REDACTED]@')
    .replace(/\b[A-Z]:[\\/][^\r\n"<>]*/gi,'[REDACTED]')
    .replace(/\/[^\s"']*\/(?:\.codex|\.claude)(?:\/[^\s"']*)?/g,'[REDACTED]');
}
