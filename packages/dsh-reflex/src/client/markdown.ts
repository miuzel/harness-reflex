/**
 * Minimal Markdown reader for the in-panel user guide.
 *
 * The guide is authored as ordinary Markdown (`USER_GUIDE.md` and its English
 * twin) because that is what a reader wants to edit and what the repository
 * renders. A client bundle cannot pull a Markdown library from the platform —
 * `react` is the only seed word this plugin is allowed — so this module parses
 * the subset of Markdown the guide actually uses.
 *
 * Two properties matter more than coverage:
 *
 * - **Parsing and rendering are separate.** {@link parseMarkdown} returns plain
 *   data, so the syntax is unit-testable without a React runtime; the renderer
 *   only turns that data into elements.
 * - **Nothing is ever injected as HTML.** Emphasis, code and links become real
 *   elements with text children, so a document that embeds `<script>` renders it
 *   as literal text — the panel is a settings surface, not a browser.
 *
 * Supported: ATX headings, paragraphs with soft wrapping, bullet and ordered
 * lists, fenced code blocks, block quotes, GitHub-style tables, thematic
 * breaks, and inline code / bold / links.
 *
 * @module dsh-reflex/client/markdown
 */
import { createElement as h, type ReactNode } from 'react';

/** One block of parsed Markdown. */
export type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'rule' };

/** `#`…`######` heading. */
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
/** A thematic break: three or more of the same marker. */
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
/** One list item, ordered (`1.` / `1)`) or bulleted. */
const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;
/** A table delimiter row: only pipes, dashes, colons and spaces. */
const TABLE_DELIMITER = /^\|?[\s:|-]+\|[\s:|-]*$/;

/** Split one table row into trimmed cells. */
function tableCells(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** True when `line` opens a block whose body must not be merged into a paragraph. */
function startsBlock(line: string): boolean {
  return (
    line.trim().length === 0 ||
    line.trimStart().startsWith('```') ||
    line.trimStart().startsWith('|') ||
    line.trimStart().startsWith('>') ||
    HEADING.test(line.trim()) ||
    RULE.test(line.trim()) ||
    LIST_ITEM.test(line)
  );
}

/**
 * Parse the Markdown subset this plugin renders.
 * @param text - the Markdown document.
 * @returns blocks in document order.
 */
export function parseMarkdown(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] as string;
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      index += 1;
      continue;
    }

    if (line.trimStart().startsWith('```')) {
      const language = line.trimStart().slice(3).trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] as string).trimStart().startsWith('```')) {
        body.push(lines[index] as string);
        index += 1;
      }
      index += 1; // consume the closing fence (or run off the end)
      blocks.push({ kind: 'code', language, text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(trimmed);
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: (heading[1] as string).length, text: (heading[2] as string).trim() });
      index += 1;
      continue;
    }

    if (RULE.test(trimmed)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    if (line.trimStart().startsWith('|')) {
      const next = lines[index + 1];
      if (next !== undefined && TABLE_DELIMITER.test(next.trim())) {
        const headers = tableCells(trimmed);
        const rows: string[][] = [];
        index += 2;
        while (index < lines.length && (lines[index] as string).trimStart().startsWith('|')) {
          rows.push(tableCells((lines[index] as string).trim()));
          index += 1;
        }
        blocks.push({ kind: 'table', headers, rows });
        continue;
      }
    }

    if (line.trimStart().startsWith('>')) {
      const quoted: string[] = [];
      while (index < lines.length && (lines[index] as string).trimStart().startsWith('>')) {
        quoted.push((lines[index] as string).trimStart().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', text: quoted.join(' ').trim() });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      const ordered = item[2] !== undefined;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] as string;
        const match = LIST_ITEM.exec(current);
        if (match !== null) {
          items.push((match[3] as string).trim());
          index += 1;
          continue;
        }
        // An indented non-item line continues the item above it.
        if (items.length > 0 && /^\s+\S/.test(current) && !startsBlock(current)) {
          items[items.length - 1] = `${items[items.length - 1] as string} ${current.trim()}`;
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !startsBlock(lines[index] as string)) {
      paragraph.push((lines[index] as string).trim());
      index += 1;
    }
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
  }

  return blocks;
}

/** Inline spans the renderer understands. */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g;

/** Style kit of the rendered document; every value is a host design token. */
const S = {
  prose: { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '920px' },
  h1: { fontSize: '17px', fontWeight: 700, margin: '4px 0 0 0' },
  h2: {
    fontSize: '14px',
    fontWeight: 600,
    margin: '10px 0 0 0',
    paddingBottom: '4px',
    borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.1))'
  },
  h3: { fontSize: '13px', fontWeight: 600, margin: '6px 0 0 0' },
  h4: { fontSize: '12px', fontWeight: 600, margin: '4px 0 0 0' },
  paragraph: { margin: 0, fontSize: '12px', lineHeight: '1.65' },
  list: { margin: 0, paddingLeft: '18px', fontSize: '12px', lineHeight: '1.65', display: 'flex', flexDirection: 'column', gap: '3px' },
  quote: {
    margin: 0,
    padding: '6px 10px',
    borderLeft: '3px solid var(--dsw-alias-brand-primary, #4d6bfe)',
    background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,.03))',
    fontSize: '12px',
    lineHeight: '1.6'
  },
  pre: {
    margin: 0,
    padding: '10px 12px',
    overflowX: 'auto',
    background: 'var(--dsw-alias-bg-layer-3, rgba(0,0,0,.25))',
    border: '1px solid var(--dsw-alias-border-l3, rgba(255,255,255,.08))',
    borderRadius: '6px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '11px',
    lineHeight: '1.55',
    whiteSpace: 'pre'
  },
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '11px',
    padding: '0 4px',
    borderRadius: '4px',
    background: 'var(--dsw-alias-bg-layer-3, rgba(0,0,0,.25))'
  },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '11px' },
  th: {
    textAlign: 'left',
    padding: '4px 6px',
    fontWeight: 500,
    color: 'var(--dsw-alias-label-tertiary, #8a8a8a)',
    borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12))'
  },
  td: {
    padding: '4px 6px',
    verticalAlign: 'top',
    borderBottom: '1px solid var(--dsw-alias-border-l4, rgba(255,255,255,.06))'
  },
  rule: { border: 'none', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.1))', margin: '2px 0' },
  link: { color: 'var(--dsw-alias-brand-primary, #4d6bfe)', textDecoration: 'underline' }
} as const;

/**
 * Render the inline spans of one text run.
 *
 * The result is a list of strings and elements — never HTML — so embedded markup
 * is displayed, not executed.
 * @param text - one line (or paragraph) of Markdown-ish text.
 * @returns renderable children.
 */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(text); match !== null; match = INLINE.exec(text)) {
    if (match.index > cursor) out.push(text.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      out.push(h('code', { style: S.code }, token.slice(1, -1)));
    } else if (token.startsWith('**')) {
      out.push(h('strong', null, token.slice(2, -2)));
    } else {
      const label = token.slice(1, token.indexOf(']'));
      const href = token.slice(token.indexOf('](') + 2, -1);
      out.push(h('a', { href, target: '_blank', rel: 'noreferrer noopener', style: S.link }, label));
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

/** One parsed block as an element. */
function renderBlock(block: MarkdownBlock, key: number): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const tag = `h${String(Math.min(block.level, 4))}`;
      const style = (S as Record<string, unknown>)[tag] ?? S.h4;
      return h(tag, { key, style }, ...renderInline(block.text));
    }
    case 'paragraph':
      return h('p', { key, style: S.paragraph }, ...renderInline(block.text));
    case 'list':
      return h(
        block.ordered ? 'ol' : 'ul',
        { key, style: S.list },
        ...block.items.map((item, itemIndex) => h('li', { key: itemIndex }, ...renderInline(item)))
      );
    case 'code':
      return h('pre', { key, style: S.pre }, h('code', null, block.text));
    case 'quote':
      return h('blockquote', { key, style: S.quote }, ...renderInline(block.text));
    case 'table':
      return h(
        'div',
        { key, style: S.tableWrap },
        h(
          'table',
          { style: S.table },
          h('thead', null, h('tr', null, ...block.headers.map((cell, cellIndex) => h('th', { key: cellIndex, style: S.th }, ...renderInline(cell))))),
          h(
            'tbody',
            null,
            ...block.rows.map((row, rowIndex) =>
              h(
                'tr',
                { key: rowIndex },
                ...row.map((cell, cellIndex) => h('td', { key: cellIndex, style: S.td }, ...renderInline(cell)))
              )
            )
          )
        )
      );
    default:
      return h('hr', { key, style: S.rule });
  }
}

/**
 * Render a Markdown document as a read-only element tree.
 * @param text - the Markdown document.
 * @returns the rendered document.
 */
export function renderMarkdown(text: string): ReactNode {
  return h('div', { style: S.prose }, ...parseMarkdown(text).map((block, index) => renderBlock(block, index)));
}
