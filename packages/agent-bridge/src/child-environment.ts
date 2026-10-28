const ALLOWED = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA',
  'CODEX_HOME',
  'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROGRAMDATA', 'COMMONPROGRAMFILES', 'OS', 'PROCESSOR_ARCHITECTURE',
]);
const OVERRIDE = /^(?:OPENAI|ANTHROPIC|CODEX|CLAUDE|AZURE_OPENAI|AWS|GOOGLE|GEMINI|VERTEX|BEDROCK)(?:_|$)/i;

export function buildChildEnvironment(source: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = {};
  const isolatedOverrideNames: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (ALLOWED.has(name.toUpperCase())) env[name.toUpperCase()] = value;
    else if (OVERRIDE.test(name)) isolatedOverrideNames.push(name);
  }
  return {env, isolatedOverrideNames: isolatedOverrideNames.sort()};
}

/** Names the child environment already owns (system variables and provider credentials/overrides); extension env may not reuse them. */
export function isReservedEnvironmentName(name:string):boolean {
  return ALLOWED.has(name.toUpperCase()) || OVERRIDE.test(name) || /^LINEJS_/i.test(name) || /^MCP_/i.test(name);
}
