export interface DiffOp {
  tag: ' ' | '-' | '+';
  line: string;
}

/**
 * The line-by-line alignment of two texts: kept, removed and added lines in
 * order. Descriptions are short, so the O(n·m) LCS table is fine.
 */
export function diffOps(before: string, after: string): DiffOp[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const width = b.length + 1;
  // Flat (a.length+1) × (b.length+1) table; cell(i, j) is the LCS length of a[i..] and b[j..].
  const table = new Uint32Array((a.length + 1) * width);
  const cell = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? cell(i + 1, j + 1) + 1 : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && right !== undefined && left === right) {
      ops.push({ tag: ' ', line: left });
      i++;
      j++;
    } else if (right !== undefined && (left === undefined || cell(i, j + 1) >= cell(i + 1, j))) {
      ops.push({ tag: '+', line: right });
      j++;
    } else if (left !== undefined) {
      ops.push({ tag: '-', line: left });
      i++;
    }
  }
  return ops;
}

/**
 * Line diff between two texts, printed as `-`/`+` lines with two lines of
 * context around each change.
 */
export function lineDiff(before: string, after: string, context = 2): string {
  const ops = diffOps(before, after);
  const changed = ops.map((op) => op.tag !== ' ');
  const out: string[] = [];
  let skipped = false;
  ops.forEach((op, index) => {
    const near = changed.slice(Math.max(0, index - context), index + context + 1).some(Boolean);
    if (near) {
      out.push(`${op.tag} ${op.line}`);
      skipped = false;
    } else if (!skipped) {
      out.push('  …');
      skipped = true;
    }
  });
  return out.join('\n');
}
