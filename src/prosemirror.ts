/**
 * Renders the ProseMirror documents Linear keeps as description snapshots
 * (`documentContentHistory`) back into the markdown the description field
 * holds, so two versions can be compared line by line. Node types this does
 * not know still contribute their text, and are named in `unknown` so a
 * rendering gap is visible instead of silent.
 */

export interface PmNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: PmNode[];
}

export interface Rendered {
  markdown: string;
  /** Node and mark types rendered as plain text because this file does not know them. */
  unknown: string[];
}

// Matches the markdown Linear serialises into `description`: `*` bullets, `[X]` ticks, escaped
// brackets, `<>`-wrapped link targets. A version rendered here then differs from the live
// description only where the content does.
const KNOWN_MARKS = new Set(['attribution', 'code', 'strong', 'bold', 'em', 'italic', 'strike', 'link', 'underline']);

export function renderMarkdown(doc: PmNode): Rendered {
  const unknown = new Set<string>();

  function inline(nodes: PmNode[] | undefined, raw = false): string {
    return (nodes ?? [])
      .map((node) => {
        if (node.type === 'hard_break') return '\n';
        if (node.type === 'issueMention') {
          const label = node.attrs?.['label'];
          const href = node.attrs?.['href'];
          if (typeof label === 'string' && typeof href === 'string') return `[${label}](${href})`;
        }
        if (node.type !== 'text') {
          if (node.type !== 'mention' && node.type !== 'emoji') unknown.add(node.type);
          return node.text ?? inline(node.content, raw);
        }
        let text = node.text ?? '';
        const marks = new Set((node.marks ?? []).map((mark) => mark.type));
        for (const mark of marks) if (!KNOWN_MARKS.has(mark)) unknown.add(`mark:${mark}`);
        // Linear escapes brackets and tildes in plain text so they cannot open a link or a strikethrough.
        if (marks.has('code')) text = `\`${text}\``;
        else if (!raw) text = text.replace(/[[\]~]/g, (char) => `\\${char}`);
        if (marks.has('strong') || marks.has('bold')) text = `**${text}**`;
        if (marks.has('em') || marks.has('italic')) text = `*${text}*`;
        if (marks.has('strike')) text = `~~${text}~~`;
        const link = node.marks?.find((mark) => mark.type === 'link')?.attrs?.['href'];
        if (typeof link === 'string') text = `[${text}](<${link}>)`;
        return text;
      })
      .join('');
  }

  // Each block renders to lines; a list item's own blocks are indented under its marker.
  function block(node: PmNode): string[] {
    switch (node.type) {
      case 'paragraph':
        return inline(node.content).split('\n');
      case 'heading': {
        const level = typeof node.attrs?.['level'] === 'number' ? node.attrs['level'] : 1;
        return [`${'#'.repeat(level)} ${inline(node.content)}`];
      }
      case 'bullet_list':
      case 'todo_list':
      case 'ordered_list':
        return (node.content ?? []).flatMap((item, index) => {
          const marker =
            node.type === 'ordered_list'
              ? `${String(index + 1)}.`
              : item.type === 'todo_item'
                ? `- [${item.attrs?.['done'] === true ? 'X' : ' '}]`
                : '*';
          const [first = '', ...rest] = (item.content ?? []).flatMap(block);
          return [`${marker} ${first}`, ...rest.map((line) => (line === '' ? '' : `  ${line}`))];
        });
      case 'code_block':
        return ['```' + (typeof node.attrs?.['language'] === 'string' ? node.attrs['language'] : ''), ...inline(node.content, true).split('\n'), '```'];
      case 'blockquote':
        return blocks(node.content).map((line) => `> ${line}`);
      case 'table':
        return (node.content ?? []).flatMap((row, index) => {
          const cells = (row.content ?? []).map((cell) => blocks(cell.content).join(' '));
          const line = `| ${cells.join(' | ')} |`;
          return index === 0 ? [line, `| ${cells.map(() => '--').join(' | ')} |`] : [line];
        });
      case 'horizontal_rule':
        return ['---'];
      default:
        unknown.add(node.type);
        return blocks(node.content);
    }
  }

  // Top-level blocks are separated by a blank line, as Linear's markdown export does; list items are not.
  function blocks(nodes: PmNode[] | undefined): string[] {
    const out: string[] = [];
    for (const node of nodes ?? []) {
      if (out.length > 0) out.push('');
      out.push(...block(node));
    }
    return out;
  }

  return { markdown: blocks(doc.content).join('\n'), unknown: [...unknown].sort() };
}
