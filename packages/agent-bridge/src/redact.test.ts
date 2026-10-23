import {describe,expect,it} from 'vitest';
import {redactSensitive} from './redact.js';
import {performance} from 'node:perf_hooks';

describe('untrusted CLI diagnostic redaction',()=>{
  it.each([
    ['Authorization: Bearer secret-bearer-value','secret-bearer-value'],
    ['authorization=Basic dXNlcjpwYXNzd29yZA==','dXNlcjpwYXNzd29yZA=='],
    ['OPENAI_API_KEY=sk-secret-key-12345','sk-secret-key-12345'],
    ['ANTHROPIC_API_KEY: sk-ant-api03-abcdef123456','sk-ant-api03-abcdef123456'],
    ['{"access_token":"oauth-sensitive-value","refreshToken":"refresh-sensitive-value"}','oauth-sensitive-value'],
    ['{"authToken":"LINE-sensitive-value","certificate":"certificate-sensitive-value"}','LINE-sensitive-value'],
    ['token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signatureabcd','eyJhbGciOiJIUzI1NiJ9'],
    ['postgresql://user:db-password@localhost/database','db-password'],
    ['Unable to read C:\\Users\\Private Person\\.codex\\auth.json','Private Person'],
    ['Unable to read /Users/private/.claude/.credentials.json','/Users/private'],
  ])('removes credential forms from %s',(input,secret)=>{
    const output=redactSensitive(input);
    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED]');
  });
  it('removes every JSON credential value while preserving useful non-secret errors',()=>{
    const output=redactSensitive('Error E17 {"access_token":"first-secret","refresh_token":"second-secret","apiKey":"third-secret","password":"fourth-secret"}');
    expect(output).toContain('Error E17');
    expect(output).not.toMatch(/first-secret|second-secret|third-secret|fourth-secret/);
    expect(redactSensitive('Rate limit exceeded. Retry later.')).toBe('Rate limit exceeded. Retry later.');
  });
  it('handles a maximum-size unseparated diagnostic without blocking Main for seconds',()=>{
    // The bridge accepts at most 64 KiB of stderr. This catches restarting the
    // greedy credential-name search at every character of a nonmatching word.
    const input='A'.repeat(64*1024);
    const started=performance.now();
    const output=redactSensitive(input);
    const elapsed=performance.now()-started;
    expect(output).toBe(input);
    // Deliberately loose: a bounded scan takes milliseconds, the regression ~3s.
    expect(elapsed).toBeLessThan(1500);
  });
  it('preserves prefixed credentials and complete diagnostics assembled across chunks',()=>{
    const input=['Authorization: Be','arer bearer-secret\nLINE_T','OKEN=line-secret\n{"refreshTo','ken":"refresh-secret","client_credential":"credential-secret"}\nE17'].join('');
    const output=redactSensitive(input);
    expect(output).not.toMatch(/bearer-secret|line-secret|refresh-secret|credential-secret/);
    expect(output).toContain('E17');
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(4);
  });
});
