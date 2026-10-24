import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_RENDERER_CSP } from './security.js';
import { transformRendererHtml } from '../renderer/dev-html.js';

describe('production main protocol registration', () => {
  it('allows capability images through both renderer CSP policies without broadening other sources', async () => {
    const source = await readFile(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
    const html = await readFile(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
    const metaPolicy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
    expect(metaPolicy).toBeDefined();
    const expectedDirectives = [
      "default-src 'self'", "script-src 'self'", "style-src 'self'",
      "img-src 'self' data: line-media:", "font-src 'self'", "connect-src 'self'",
      "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'",
    ];
    expect(PRODUCTION_RENDERER_CSP.split(';').map((directive) => directive.trim())).toEqual(expectedDirectives);
    expect(metaPolicy!.split(';').map((directive) => directive.trim())).toEqual(expectedDirectives);
    expect(source).toContain('rendererContentSecurityPolicy(app.isPackaged, rendererUrl)');
  });

  it('removes the strict CSP meta only from Vite-served HTML', async () => {
    const html = await readFile(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');
    const devHtml = transformRendererHtml(html, 'serve');
    expect(devHtml).not.toMatch(/http-equiv="Content-Security-Policy"/);
    expect(devHtml).toContain('/src/renderer/main.tsx');
    expect(transformRendererHtml(html, 'build')).toBe(html);
  });

  it('registers the isolated preview scheme with least privilege before Electron becomes ready', async () => {
    const source = await readFile(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
    const registration = source.indexOf('protocol.registerSchemesAsPrivileged');
    const ready = source.indexOf('app.whenReady()');
    expect(registration).toBeGreaterThanOrEqual(0);
    expect(registration).toBeLessThan(ready);
    // line-preview and line-media share one least-privilege definition (972ef0a), declared before the registration.
    const definition = source.indexOf('const privilegedScheme');
    expect(definition).toBeGreaterThanOrEqual(0);
    expect(definition).toBeLessThan(registration);
    const registered = source.slice(registration, source.indexOf(';', registration));
    expect(registered).toMatch(/scheme:\s*['"]line-preview['"],\s*\.\.\.privilegedScheme/);
    expect(registered).toMatch(/scheme:\s*['"]line-media['"],\s*\.\.\.privilegedScheme/);
    const privileges = source.slice(definition, registration);
    expect(privileges).toMatch(/standard:\s*true/);
    expect(privileges).toMatch(/secure:\s*true/);
    expect(privileges).toMatch(/supportFetchAPI:\s*true/);
    expect(privileges).toMatch(/stream:\s*true/);
    expect(privileges).toMatch(/bypassCSP:\s*false/);
    expect(privileges).toMatch(/allowServiceWorkers:\s*false/);
    expect(privileges).toMatch(/allowExtensions:\s*false/);
  });

  it('holds a single-instance lock and focuses the existing window on a second launch', async () => {
    const source = await readFile(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
    const lock = source.indexOf('app.requestSingleInstanceLock()');
    const ready = source.indexOf('app.whenReady()');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(ready);
    expect(source).toMatch(/if\s*\(!hasSingleInstanceLock\)\s*\{\s*if\s*\(firstRunSetupOnly\)\s*app\.exit\(0\);\s*else\s*app\.quit\(\)/);
    expect(source).toMatch(/app\.on\(['"]second-instance['"]/);
    expect(source).toMatch(/second_instance_received/);
    expect(source).toMatch(/routeSecondInstance\(commandLine\.slice\(1\)/);
    expect(source).toMatch(/second_instance_\$\{classification\}/);
    expect(source).toMatch(/window\.isMinimized\(\)/);
    expect(source).toMatch(/window\.restore\(\)/);
    expect(source).toMatch(/window\.show\(\)/);
    expect(source).toMatch(/window\.focus\(\)/);
  });

  it('uses a certain post-drain process exit instead of Electron window close handlers', async () => {
    const source = await readFile(fileURLToPath(new URL('./main.ts', import.meta.url)), 'utf8');
    expect(source).toMatch(/exit:\s*\(\)\s*=>\s*\{\s*windowGeometryPersistence\?\.flush\(\);\s*tray\?\.destroy\(\);\s*fileTypeIcons\.disable\(\);\s*app\.exit\(0\);\s*\}/);
    expect(source).toMatch(/closeServices:\s*\(\)\s*=>\s*shutdownServices\(/);
    expect(source).toContain("from './desktop-lifecycle.js'");
    expect(source).toMatch(/restartApplication:\s*\(\)\s*=>\s*setupSession\s*\?\s*setupSession\.succeeded\(\)\s*:\s*lifecycle\.request\('restart'\)/);
  });
});
