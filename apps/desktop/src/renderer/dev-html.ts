/** Vite's development preamble and CSS HMR need a document without the production CSP meta. */
export function transformRendererHtml(html: string, command: 'serve' | 'build'): string {
  if (command !== 'serve') return html;
  return html.replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']Content-Security-Policy["'])[^>]*>/i, '');
}
