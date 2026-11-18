// 從 kernel 原始碼抽出片段。只做文字處理，不碰檔案系統（讀檔在 scripts/extract-snippets.ts）。
//
// 片段的界定方式：
//   fn       函式名稱。依 kernel coding style 找定義：函式名稱在行首（回傳型別在上一行）或
//            「型別 名稱(」在行首，函式本體的 { 和 } 都在第 0 欄。
//   comment  區塊註解中某一行的字串，取出整個 /* ... */。
// marks 是「要高亮的行」：用一段字串指定，必須在片段中剛好出現在一行，換版本時才不會默默對錯行。

export interface SnippetSpec {
  /** 例如 'v2.6.24/place_entity' */
  id: string;
  tag: string;
  /** kernel 樹中的路徑，例如 'kernel/sched_fair.c' */
  file: string;
  fn?: string;
  comment?: string;
  /** 同名定義有多個時（#ifdef 兩種版本）取第幾個，從 0 起算 */
  nth?: number;
  /** 一併取出函式正上方的區塊註解 */
  leadingComment?: boolean;
  marks?: Record<string, string>;
}

export interface Snippet {
  id: string;
  tag: string;
  file: string;
  /** 函式名稱或註解的標題 */
  title: string;
  /** 1-based，含 */
  start: number;
  end: number;
  lines: string[];
  /** mark id → 1-based 行號（檔案中的絕對行號） */
  marks: Record<string, number>;
  url: string;
}

/** Elixir 的版本名稱：2.6.x 以後是 v2.6.24，2.4 是 2.4.0（沒有 v） */
export function elixirVersion(tag: string): string {
  return /^v2\.4\./.test(tag) ? tag.slice(1) : tag;
}

export function elixirUrl(tag: string, file: string, start: number, end?: number): string {
  const range = end && end !== start ? `${start}-L${end}` : `${start}`;
  return `https://elixir.bootlin.com/linux/${elixirVersion(tag)}/source/${file}#L${range}`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 回傳函式定義的 [start, end]（0-based，含） */
function findFunction(lines: string[], fn: string, nth: number | undefined): [number, number] {
  const sig = new RegExp(`^(?:[A-Za-z_][\\w\\s*]*[\\s*])?${escapeRe(fn)}\\(`);
  const defs: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!sig.test(lines[i]!)) continue;
    // 往下找本體的 {，途中遇到 ; 表示是宣告不是定義
    let j = i;
    while (j < lines.length && lines[j] !== '{' && !lines[j]!.trimEnd().endsWith(';')) j++;
    if (lines[j] !== '{') continue;
    let k = j + 1;
    while (k < lines.length && !lines[k]!.startsWith('}')) k++;
    if (k === lines.length) throw new Error(`${fn}: 找不到函式結尾`);
    // 回傳型別在上一行（kernel 慣例：static void\nfoo(...)）
    let start = i;
    const prev = lines[i - 1];
    if (lines[i]!.startsWith(fn) && prev !== undefined && /^[A-Za-z_]/.test(prev) && !/[;{}]\s*$/.test(prev)) {
      start = i - 1;
    }
    defs.push([start, k]);
  }
  if (nth === undefined && defs.length > 1) {
    // 多半是 #ifdef 的另一版，要求明確指定
    throw new Error(`${fn}: 有 ${defs.length} 個定義（${defs.map((x) => x[0] + 1).join(', ')} 行），請指定 nth`);
  }
  const d = defs[nth ?? 0];
  if (!d) throw new Error(`${fn}: 找到 ${defs.length} 個定義，要第 ${nth ?? 0} 個`);
  return d;
}

/** 找出包含第 i 行的區塊註解 [start, end] */
function enclosingComment(lines: string[], i: number): [number, number] {
  let s = i;
  while (s >= 0 && !lines[s]!.includes('/*')) s--;
  let e = i;
  while (e < lines.length && !lines[e]!.includes('*/')) e++;
  if (s < 0 || e === lines.length) throw new Error(`第 ${i + 1} 行不在區塊註解裡`);
  return [s, e];
}

function uniqueLine(lines: string[], needle: string, what: string): number {
  const hits: number[] = [];
  lines.forEach((l, i) => l.includes(needle) && hits.push(i));
  if (hits.length !== 1) throw new Error(`${what}：「${needle}」出現 ${hits.length} 次，必須剛好一次`);
  return hits[0]!;
}

export function extractSnippet(spec: SnippetSpec, source: string): Snippet {
  const lines = source.split('\n');
  let range: [number, number];
  let title: string;

  if (spec.fn) {
    range = findFunction(lines, spec.fn, spec.nth);
    title = `${spec.fn}()`;
    if (spec.leadingComment && lines[range[0] - 1]?.trim() === '*/') {
      range = [enclosingComment(lines, range[0] - 1)[0], range[1]];
    }
  } else if (spec.comment) {
    range = enclosingComment(lines, uniqueLine(lines, spec.comment, spec.id));
    title = spec.comment.replace(/^\s*\*\s*/, '').trim();
  } else {
    throw new Error(`${spec.id}: 要指定 fn 或 comment`);
  }

  const body = lines.slice(range[0], range[1] + 1);
  const marks: Record<string, number> = {};
  for (const [k, needle] of Object.entries(spec.marks ?? {})) {
    marks[k] = range[0] + 1 + uniqueLine(body, needle, `${spec.id} mark ${k}`);
  }
  const start = range[0] + 1;
  const end = range[1] + 1;
  return {
    id: spec.id,
    tag: spec.tag,
    file: spec.file,
    title,
    start,
    end,
    lines: body,
    marks,
    url: elixirUrl(spec.tag, spec.file, start, end),
  };
}
