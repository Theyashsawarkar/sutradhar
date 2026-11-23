// The page's main content as Markdown, for reading articles, docs, results.

import { isVisible, renderedChildren } from './dom.ts';

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'button', 'select', 'input', 'textarea', 'nav', 'footer', 'aside']);

export function pageMarkdown(maxChars = 100000, all = false): { markdown: string; truncated: boolean } {
  const root = all ? document.body : pickRoot();
  const out: string[] = [];
  const inline = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').replace(/\s+/g, ' ');
    if (!(n instanceof Element) || SKIP.has(n.localName) || !isVisible(n)) return '';
    const inner = () => renderedChildren(n).map(inline).join('');
    switch (n.localName) {
      case 'a': {
        const t = inner().trim();
        const href = (n as HTMLAnchorElement).href;
        return t ? (href && !href.startsWith('javascript:') ? `[${t}](${href})` : t) : '';
      }
      case 'strong': case 'b': { const t = inner().trim(); return t ? `**${t}**` : ''; }
      case 'em': case 'i': { const t = inner().trim(); return t ? `*${t}*` : ''; }
      case 'code': return '`' + (n.textContent ?? '') + '`';
      case 'img': { const alt = n.getAttribute('alt'); return alt ? `![${alt}](${(n as HTMLImageElement).src})` : ''; }
      case 'br': return '\n';
      default: return inner();
    }
  };
  const block = (n: Node, prefix = '') => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t) out.push(prefix + t);
      return;
    }
    if (!(n instanceof Element) || SKIP.has(n.localName) || !isVisible(n)) return;
    const tag = n.localName;
    if (/^h[1-6]$/.test(tag)) { out.push('', '#'.repeat(+tag[1]) + ' ' + inline(n).trim(), ''); return; }
    if (tag === 'p' || tag === 'blockquote' || tag === 'figcaption' || tag === 'dt' || tag === 'dd') {
      const t = inline(n).replace(/ +/g, ' ').trim();
      if (t) out.push('', (tag === 'blockquote' ? '> ' : prefix) + t, '');
      return;
    }
    if (tag === 'pre') { out.push('', '```', n.textContent ?? '', '```', ''); return; }
    if (tag === 'ul' || tag === 'ol') {
      let i = 1;
      for (const li of Array.from(n.children)) {
        if (li.localName !== 'li' || !isVisible(li)) continue;
        const bullet = tag === 'ol' ? `${i++}. ` : '- ';
        const t = Array.from(li.childNodes).filter((c) => !(c instanceof Element && (c.localName === 'ul' || c.localName === 'ol'))).map(inline).join('').replace(/\s+/g, ' ').trim();
        if (t) out.push(prefix + bullet + t);
        for (const sub of Array.from(li.children)) if (sub.localName === 'ul' || sub.localName === 'ol') block(sub, prefix + '  ');
      }
      out.push('');
      return;
    }
    if (tag === 'table') {
      const rows = Array.from((n as HTMLTableElement).rows).slice(0, 200);
      if (!rows.length) return;
      out.push('');
      rows.forEach((r, i) => {
        out.push('| ' + Array.from(r.cells).map((c) => inline(c).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()).join(' | ') + ' |');
        if (i === 0) out.push('|' + Array.from(r.cells).map(() => ' --- ').join('|') + '|');
      });
      out.push('');
      return;
    }
    if (tag === 'img') { const t = inline(n); if (t) out.push(t); return; }
    // Generic container: inline runs become paragraphs.
    let run = '';
    const flush = () => { const t = run.replace(/\s+/g, ' ').trim(); if (t) out.push(prefix + t); run = ''; };
    for (const c of renderedChildren(n)) {
      const isBlock = c instanceof Element && isBlockish(c);
      if (isBlock) { flush(); block(c, prefix); } else run += inline(c);
    }
    flush();
  };
  block(root);
  let md = `# ${document.title}\n${location.href}\n\n` + out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = md.length > maxChars;
  if (truncated) md = md.slice(0, maxChars) + '\n\n[…cut; ask for more with a larger maxChars]';
  return { markdown: md, truncated };
}

function isBlockish(el: Element) {
  if (/^(p|div|section|article|main|header|ul|ol|li|table|pre|blockquote|h[1-6]|figure|figcaption|dl|dt|dd|form|fieldset|details|summary|hr)$/.test(el.localName)) return true;
  const d = getComputedStyle(el).display;
  return d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item' || d === 'table';
}

function pickRoot(): Element {
  const main = document.querySelector('main, [role=main], article');
  if (main && (main.textContent ?? '').trim().length > 200) return main;
  return document.body;
}
