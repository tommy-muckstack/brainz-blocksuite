import type { Segment } from './segments';

// A stand-in for Brainz's native splitter, used by the browser preview and
// tests: frontmatter is metadata, blank lines are gaps, fenced code and lists
// stay whole. Concatenating the segments always gives back the input.

const fence = /^\s{0,3}(`{3,}|~{3,})/;
const listItem = /^\s*([-*+]|\d+[.)])\s/;

function kindOf(line: string): string {
  if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) return 'heading';
  if (fence.test(line)) return 'code';
  if (/^\s{0,3}>/.test(line)) return 'quote';
  if (listItem.test(line)) return 'list';
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return 'divider';
  if (/^\s*\|/.test(line)) return 'table';
  if (/^\s*</.test(line)) return 'html';
  if (/^\[\^[^\]]+\]:/.test(line)) return 'footnote';
  return 'paragraph';
}

export function splitMarkdown(source: string): Segment[] {
  const segments: Segment[] = [];
  const push = (kind: string, text: string) => { if (text) segments.push({ id: segments.length, kind, text }); };
  // Line starts and their text, newline excluded.
  const lines: { start: number; text: string }[] = [];
  for (let start = 0; start <= source.length;) {
    const end = source.indexOf('\n', start);
    const stop = end < 0 ? source.length : end;
    if (start === source.length && end < 0) break;
    lines.push({ start, text: source.slice(start, stop) });
    start = stop + 1;
  }
  let cursor = 0; let line = 0;
  const lineEnd = (index: number) => lines[index].start + lines[index].text.length;
  if (lines[0]?.text === '---') {
    const close = lines.findIndex((entry, index) => index > 0 && (entry.text === '---' || entry.text === '...'));
    if (close > 0) { push('metadata', source.slice(0, lineEnd(close))); cursor = lineEnd(close); line = close + 1; }
  }
  while (line < lines.length) {
    if (!lines[line].text.trim()) { line++; continue; }
    const startLine = line;
    const kind = kindOf(lines[line].text);
    if (kind === 'code') {
      const marker = fence.exec(lines[line].text)![1];
      line++;
      while (line < lines.length && !lines[line].text.trimStart().startsWith(marker)) line++;
      line = Math.min(line + 1, lines.length);
    } else if (kind === 'list') {
      line++;
      while (line < lines.length) {
        if (lines[line].text.trim()) { line++; continue; }
        let next = line; while (next < lines.length && !lines[next].text.trim()) next++;
        if (next < lines.length && (listItem.test(lines[next].text) || /^\s{2,}\S/.test(lines[next].text))) line = next;
        else break;
      }
    } else {
      line++;
      const singleLine = kind === 'heading' || kind === 'divider';
      while (!singleLine && line < lines.length && lines[line].text.trim() && !fence.test(lines[line].text)) line++;
    }
    push('gap', source.slice(cursor, lines[startLine].start));
    const end = lineEnd(line - 1);
    push(kind, source.slice(lines[startLine].start, end));
    cursor = end;
  }
  push('gap', source.slice(cursor));
  return segments;
}
