// Reading agent-authored pages: titles, quick lint, and runtime injection.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { UI_DIR } from './common.mjs';

export const MAX_PAGE_BYTES = 10 * 1024 * 1024;
export const PRETENDARD_CSS = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css';

const decode = (text) => text
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

export function pageTitle(html, fallback) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  return (decode(title ?? '') || decode(h1 ?? '') || fallback).slice(0, 200);
}

export function kitEnabled(html) {
  const root = html.match(/<html\b[^>]*>/i)?.[0] ?? '';
  if (/data-gomin-kit\s*=\s*["']?off/i.test(root)) return false;
  return !/<meta[^>]+name=["']gomin-kit["'][^>]+content=["']?off/i.test(html);
}

// Cheap, render-free checks. They never block opening a page.
export function lint(html) {
  const warnings = [];
  if (!/<html[\s>]/i.test(html) && !/<body[\s>]/i.test(html) && !/<(main|section|h1|p|div)[\s>]/i.test(html)) {
    warnings.push('The file does not look like HTML.');
  }
  if (/<form\b/i.test(html) && !/\bname\s*=/i.test(html)) {
    warnings.push('The page has a <form> but no named controls; only controls with a name="" attribute are sent back.');
  }
  if (/<a\b[^>]*href=["']javascript:/i.test(html)) warnings.push('javascript: links are blocked in the sandbox.');
  if (/\bsrc=["']\/(?!\/)/i.test(html) || /\bhref=["']\/(?!\/)[^"']*\.css/i.test(html)) {
    warnings.push('Root-relative asset paths ("/x.png") do not resolve; use paths relative to the HTML file.');
  }
  return warnings;
}

let runtimeCache = null;
async function runtime() {
  if (!runtimeCache || process.env.GOMIN_DEV) {
    const [kit, bridge] = await Promise.all([
      fs.readFile(path.join(UI_DIR, 'kit.css'), 'utf8'),
      fs.readFile(path.join(UI_DIR, 'bridge.js'), 'utf8'),
    ]);
    runtimeCache = { kit, bridge };
  }
  return runtimeCache;
}

export async function kitCss() {
  return (await runtime()).kit;
}

// Adds the bridge (and, unless opted out, the style kit) without touching the file on disk.
// The kit lives in the lowest cascade layer, so any author CSS wins over it.
export async function injectRuntime(html) {
  const { kit, bridge } = await runtime();
  const parts = [];
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  if (kitEnabled(html)) {
    parts.push(`<link rel="stylesheet" href="${PRETENDARD_CSS}" data-gomin>`);
    parts.push(`<style data-gomin>@layer gomin-kit;\n@layer gomin-kit {\n${kit}\n}</style>`);
  }
  parts.push(`<script data-gomin>${bridge.replace(/<\/script/gi, '<\\/script')}</script>`);
  const block = parts.join('\n');

  let output = html;
  if (!/^\s*<!doctype/i.test(output)) output = `<!doctype html>\n${output}`;
  const head = output.match(/<head\b[^>]*>/i);
  if (head) return output.replace(head[0], `${head[0]}\n${block}`);
  const root = output.match(/<html\b[^>]*>/i);
  if (root) return output.replace(root[0], `${root[0]}\n<head>${block}</head>`);
  return output.replace(/^\s*<!doctype[^>]*>/i, (doctype) => `${doctype}\n<head>${block}</head>`);
}

// Standalone copy for sharing: kit inlined, no bridge, no server needed.
export async function exportStandalone(html) {
  if (!kitEnabled(html)) return html;
  const kit = await kitCss();
  const block = `<link rel="stylesheet" href="${PRETENDARD_CSS}">\n<style>@layer gomin-kit;\n@layer gomin-kit {\n${kit}\n}</style>`;
  const head = html.match(/<head\b[^>]*>/i);
  if (head) return html.replace(head[0], `${head[0]}\n${block}`);
  return `${block}\n${html}`;
}
