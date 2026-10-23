import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('styles the @mention chip with colour and weight only, in every renderer stylesheet', () => {
  const directory = dirname(fileURLToPath(import.meta.url));
  const rules: string[] = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.css'))) {
    const css = readFileSync(join(directory, file), 'utf8');
    for (const match of css.matchAll(/([^{}]*.message-mention[^{}]*){([^}]*)}/g)) rules.push(match[2]!);
  }
  expect(rules.length).toBeGreaterThan(0);
  for (const body of rules) expect(body).not.toMatch(/background|border-radius/);
});
