// 原始碼頁：睡醒的程式放在哪裡。
// 逐步執行的部分用模擬器的 trace（rq.trace）驅動，程式碼片段來自 src/source/snippets.json（由腳本抽出）。

import { Simulator } from '../core/engine.ts';
import { NSEC_PER_MSEC as MS, type TaskSpec, type TraceEvent } from '../core/types.ts';
import type { SnippetFile } from '../source/build.ts';
import type { Snippet } from '../source/extract.ts';
import snippetData from '../source/snippets.json';
import { CfsV2_6_24 } from '../sched/cfs-v2.6.24.ts';
import { EevdfV6_6 } from '../sched/eevdf-v6.6.ts';

const snippets = (snippetData as SnippetFile).snippets;
const snip = (id: string): Snippet => {
  const s = snippets[id];
  if (!s) throw new Error(`沒有片段 ${id}`);
  return s;
};

// ---------------------------------------------------------------------------
// 情境：兩個 compile 佔著 CPU，editor 短睡兩次、長睡一次，循環。
// 時間不對齊 1ms tick，避免人造的平手。

const EDITOR_PID = 3;
const tasks: TaskSpec[] = [
  { name: 'compile-1', nice: 0, pattern: [{ run: Infinity, sleep: 0 }] },
  { name: 'compile-2', nice: 0, pattern: [{ run: Infinity, sleep: 0 }] },
  {
    name: 'editor',
    nice: 0,
    arrival: 30.3 * MS,
    pattern: [
      { run: 1.3 * MS, sleep: 4.7 * MS },
      { run: 1.3 * MS, sleep: 4.7 * MS },
      { run: 1.3 * MS, sleep: 97.3 * MS },
    ],
  },
];

type D = Record<string, number | string | boolean | null>;
interface Ev {
  t: number;
  d: D;
}
interface Cycle {
  sleep: Ev;
  wake: Ev;
}

/** 從 trace 取出 editor 每一次「睡著 → 醒來」 */
function cycles(events: TraceEvent[], sleepFn: string): Cycle[] {
  const out: Cycle[] = [];
  let pending: Ev | null = null;
  for (const e of events) {
    if (e.pid !== EDITOR_PID) continue;
    if (e.fn === sleepFn && (sleepFn !== 'dequeue_entity' || e.data?.sleep)) pending = { t: e.t, d: e.data ?? {} };
    else if (e.fn === 'place_entity' && pending && !e.data?.initial) {
      out.push({ sleep: pending, wake: { t: e.t, d: e.data ?? {} } });
      pending = null;
    }
  }
  return out;
}

function runTraces(): { cfs: Cycle[]; eevdf: Cycle[] } {
  const cfg = { duration: 330 * MS, trace: true };
  const cfs = new Simulator(new CfsV2_6_24(), tasks, cfg).run();
  const eevdf = new Simulator(new EevdfV6_6(), tasks, cfg).run();
  return { cfs: cycles(cfs.trace.events, 'dequeue_entity'), eevdf: cycles(eevdf.trace.events, 'update_entity_lag') };
}

// ---------------------------------------------------------------------------
// 格式

const num = (d: D, k: string): number => {
  const v = d[k];
  if (typeof v !== 'number') throw new Error(`trace 缺少 ${k}`);
  return v;
};
const ms = (ns: number, digits = 3) => `${(ns / MS).toFixed(digits).replace('-', '−')} ms`;
const sms = (ns: number, digits = 3) => (ns > 0 ? '+' : ns < 0 ? '−' : '±') + `${Math.abs(ns / MS).toFixed(digits)} ms`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
}

// ---------------------------------------------------------------------------
// 程式碼區塊

/** 每行切成程式與註解兩種片段（只處理 /* *\/ 與 //，這些片段裡沒有含註解符號的字串） */
function tokenize(lines: string[]): { text: string; comment: boolean }[][] {
  let inBlock = false;
  return lines.map((line) => {
    const parts: { text: string; comment: boolean }[] = [];
    let rest = line;
    while (rest.length) {
      if (inBlock) {
        const e = rest.indexOf('*/');
        if (e < 0) {
          parts.push({ text: rest, comment: true });
          rest = '';
        } else {
          parts.push({ text: rest.slice(0, e + 2), comment: true });
          rest = rest.slice(e + 2);
          inBlock = false;
        }
      } else {
        const b = rest.indexOf('/*');
        const l = rest.indexOf('//');
        if (l >= 0 && (b < 0 || l < b)) {
          if (l > 0) parts.push({ text: rest.slice(0, l), comment: false });
          parts.push({ text: rest.slice(l), comment: true });
          rest = '';
        } else if (b >= 0) {
          if (b > 0) parts.push({ text: rest.slice(0, b), comment: false });
          rest = rest.slice(b);
          inBlock = true;
          const e = rest.indexOf('*/', 2);
          if (e >= 0) {
            parts.push({ text: rest.slice(0, e + 2), comment: true });
            rest = rest.slice(e + 2);
            inBlock = false;
          } else {
            parts.push({ text: rest, comment: true });
            rest = '';
          }
        } else {
          parts.push({ text: rest, comment: false });
          rest = '';
        }
      }
    }
    return parts;
  });
}

interface Highlight {
  /** 這一行的註記；空字串表示只高亮 */
  note: string;
  /** 'run' = 這一步執行到的行，'key' = 決定結果的那一行 */
  kind?: 'run' | 'key' | 'skip';
}

interface CodeOpts {
  /** mark id → 註記 */
  marks: Record<string, Highlight>;
  /** 只顯示高亮行前後幾行，其餘摺起來（點一下展開）；不給就全部顯示 */
  context?: number;
  /** 標題列額外文字 */
  caption?: string;
}

function codeBlock(sn: Snippet, opts: CodeOpts): HTMLElement {
  const box = h('figure', 'code');
  const head = h('figcaption');
  head.innerHTML =
    `<span class="fn">${esc(sn.title)}</span>` +
    `<span class="where">${esc(sn.tag)} · ${esc(sn.file)}:${sn.start}–${sn.end}</span>` +
    (opts.caption ? `<span class="cap">${esc(opts.caption)}</span>` : '') +
    `<a href="${sn.url}" target="_blank" rel="noopener">Elixir ↗</a>`;
  box.append(head);

  const byLine = new Map<number, Highlight>();
  for (const [k, hl] of Object.entries(opts.marks)) {
    const line = sn.marks[k];
    if (line === undefined) throw new Error(`${sn.id} 沒有 mark ${k}`);
    byLine.set(line, hl);
  }

  const toks = tokenize(sn.lines);
  const visible = sn.lines.map((_, i) => {
    if (opts.context === undefined || byLine.size === 0) return true;
    const ln = sn.start + i;
    if (i === 0 || i === sn.lines.length - 1) return true; // 函式的頭尾
    for (const m of byLine.keys()) if (Math.abs(m - ln) <= opts.context) return true;
    return false;
  });
  // 太短的摺疊沒有意義，直接顯示
  for (let i = 0; i < visible.length; ) {
    if (visible[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < visible.length && !visible[j]) j++;
    if (j - i < 4) for (let k = i; k < j; k++) visible[k] = true;
    i = j;
  }

  const pre = h('div', 'lines');
  let i = 0;
  while (i < sn.lines.length) {
    if (!visible[i]) {
      const from = i;
      while (i < sn.lines.length && !visible[i]) i++;
      const hidden: HTMLElement[] = [];
      for (let j = from; j < i; j++) hidden.push(lineEl(sn, j, toks[j]!, undefined));
      const fold = h('button', 'fold', `⋯ 展開 ${i - from} 行（${sn.start + from}–${sn.start + i - 1}）`);
      fold.type = 'button';
      fold.addEventListener('click', () => fold.replaceWith(...hidden));
      pre.append(fold);
      continue;
    }
    pre.append(lineEl(sn, i, toks[i]!, byLine.get(sn.start + i)));
    i++;
  }
  box.append(pre);
  return box;
}

/** 一行程式碼；有註記時，註記放在下一列，縮排和程式碼對齊（kernel 一行接近 80 欄，放行尾會被切掉） */
function lineEl(sn: Snippet, i: number, parts: { text: string; comment: boolean }[], hl: Highlight | undefined): HTMLElement {
  const row = h('div', 'ln' + (hl ? ` hl ${hl.kind ?? 'run'}` : ''));
  const code = codeRow(sn, i, parts, row);
  if (!hl?.note) return code;
  const wrap = h('div', 'lnwrap');
  const noteRow = h('div', row.className + ' noterow');
  noteRow.append(h('span', 'no', ''));
  const indent = /^\s*/.exec(sn.lines[i]!)![0];
  const src = h('span', 'src');
  src.textContent = indent;
  src.append(h('span', 'note', '↳ ' + esc(hl.note)));
  noteRow.append(src);
  wrap.append(code, noteRow);
  return wrap;
}

function codeRow(sn: Snippet, i: number, parts: { text: string; comment: boolean }[], row: HTMLElement): HTMLElement {
  row.append(h('span', 'no', String(sn.start + i)));
  const src = h('span', 'src');
  for (const p of parts) {
    const span = h('span', p.comment ? 'cmt' : '');
    span.textContent = p.text;
    src.append(span);
  }
  if (!parts.length) src.textContent = ' ';
  row.append(src);
  return row;
}

// ---------------------------------------------------------------------------
// 數線：以參考點（CFS 是 min_vruntime，EEVDF 是 V）為 0，標出 editor 的位置

interface Pt {
  x: number;
  label: string;
  kind: 'old' | 'cand' | 'new' | 'dl';
}

function numberLine(ref: string, pts: Pt[]): HTMLElement {
  const W = 520;
  const H = 74;
  const pad = 36;
  const span = Math.max(1 * MS, ...pts.map((p) => Math.abs(p.x))) * 1.15;
  const X = (v: number) => pad + ((v + span) / (2 * span)) * (W - 2 * pad);

  // 位置相同的點合併標籤
  const merged: Pt[] = [];
  for (const p of pts) {
    const same = merged.find((m) => Math.abs(m.x - p.x) < span * 0.01);
    if (same) same.label += '＝' + p.label;
    else merged.push({ ...p });
  }
  merged.sort((a, b) => a.x - b.x);

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="editor 相對 ${esc(ref)} 的位置">`;
  svg += `<line class="axis" x1="${pad}" x2="${W - pad}" y1="40" y2="40"/>`;
  for (const v of [-span / 1.15, 0, span / 1.15]) {
    svg += `<line class="tick" x1="${X(v)}" x2="${X(v)}" y1="36" y2="44"/>`;
    svg += `<text class="tlabel" x="${X(v)}" y="60" text-anchor="middle">${v === 0 ? esc(ref) : sms(v, 2)}</text>`;
  }
  svg += `<text class="dir" x="${pad}" y="72" text-anchor="start">← 先跑</text>`;
  svg += `<text class="dir" x="${W - pad}" y="72" text-anchor="end">後跑 →</text>`;
  merged.forEach((p, i) => {
    const y = i % 2 ? 14 : 26;
    svg += `<circle class="pt ${p.kind}" cx="${X(p.x)}" cy="40" r="5"/>`;
    svg += `<text class="plabel ${p.kind}" x="${X(p.x)}" y="${y}" text-anchor="middle">${esc(p.label)}</text>`;
  });
  svg += '</svg>';
  return h('div', 'numline', svg);
}

// ---------------------------------------------------------------------------
// 每一步的內容

interface StepView {
  caption: string;
  line: HTMLElement;
  code: HTMLElement;
}

const LATENCY = 20 * MS; // v2.6.24 sysctl_sched_latency（單核）

function cfsStep(c: Cycle, phase: 'sleep' | 'wake'): StepView {
  const { sleep, wake } = c;
  if (phase === 'sleep') {
    const v = num(sleep.d, 'vruntime');
    const min = num(sleep.d, 'min_vruntime');
    return {
      caption:
        `t = ${ms(sleep.t)}，editor 睡著。dequeue_entity() 只把它從紅黑樹拿掉、從負載扣掉，vruntime 停在 ${ms(v)}，` +
        `沒有另外記下任何和公平有關的量（sleep_start 只在開了 CONFIG_SCHEDSTATS 時記，給統計用）。` +
        `這時 min_vruntime 是 ${ms(min)}，editor 在它${v < min ? '前面' : '後面'} ${ms(Math.abs(v - min))}。` +
        `接下來 compile 繼續跑，min_vruntime 往前走，editor 的 vruntime 不動。`,
      line: numberLine('min_vruntime', [{ x: v - min, label: 'editor', kind: 'old' }]),
      code: codeBlock(snip('v2.6.24/dequeue_entity'), {
        context: 3,
        marks: {
          update_curr: { note: `editor 的 vruntime 記到 ${ms(v)}` },
          sleep_start: { note: '只有 schedstats', kind: 'skip' },
          account: { note: '拿掉權重，vruntime 原封不動' },
        },
      }),
    };
  }
  const old = num(wake.d, 'old_vruntime');
  const min = num(wake.d, 'min_vruntime');
  const cand = num(wake.d, 'candidate');
  const v = num(wake.d, 'vruntime');
  const kept = wake.d.kept_old === true;
  const slept = wake.t - sleep.t;
  const moved = min - num(sleep.d, 'min_vruntime');
  const tail = kept
    ? `editor 原本的 vruntime 比候選位置還大，max_vruntime() 取原值，補償完全沒有用上。` +
      `它從 min_vruntime ${sms(v - min)} 的位置起跑：睡前就落在這附近，短睡期間 min_vruntime 只走了 ${ms(moved)}。`
    : `如果照原值放回去，editor 的 vruntime 會比 min_vruntime 小 ${ms(min - old)}，醒來後要一直跑到追上別人為止，等於把睡覺期間沒用的時間一次領回。` +
      `max_vruntime() 把它拉到候選位置 min_vruntime − 20ms。不管睡了多久，它拿到的都是這 20ms；睡前欠它或它多拿的部分全部不算了。`;
  return {
    caption:
      `t = ${ms(wake.t)}，editor 醒來，睡了 ${ms(slept, 1)}，這段時間 min_vruntime 前進了 ${ms(moved)}。` +
      `place_entity() 先算候選位置 min_vruntime − sched_latency = ${ms(cand)}，再和原本的 vruntime ${ms(old)} 取大的。` +
      tail,
    line: numberLine('min_vruntime', [
      { x: old - min, label: '原本', kind: 'old' },
      { x: cand - min, label: '候選', kind: 'cand' },
      { x: v - min, label: '放置', kind: 'new' },
    ]),
    code: codeBlock(snip('v2.6.24/place_entity'), {
      context: 2,
      marks: {
        base: { note: `= ${ms(min)}` },
        debit_if: { note: '喚醒時 initial = 0，不走', kind: 'skip' },
        wake_if: { note: '' },
        sleeper: { note: `− ${ms(LATENCY, 0)} → ${ms(cand)}` },
        clamp: { note: `max(${ms(old)}, ${ms(cand)}) → ${kept ? '原本' : '候選'}`, kind: 'key' },
        assign: { note: `= ${ms(v)}` },
      },
    }),
  };
}

function eevdfStep(c: Cycle, phase: 'sleep' | 'wake'): StepView {
  const { sleep, wake } = c;
  const vlag = num(sleep.d, 'vlag');
  if (phase === 'sleep') {
    const V = num(sleep.d, 'V');
    const v = num(sleep.d, 'vruntime');
    const lag = num(sleep.d, 'lag');
    const limit = num(sleep.d, 'limit');
    const clipped = lag !== vlag;
    return {
      caption:
        `t = ${ms(sleep.t)}，editor 睡著。dequeue_entity() 先呼叫 update_entity_lag()，把 V − vruntime = ${sms(lag)} 存進 vlag。` +
        `正的表示排程器還欠它（以虛擬時間計），負的表示它多拿了。上限是 ±calc_delta_fair(max(2 × slice, TICK)) = ±${ms(limit, 1)}，` +
        (clipped ? `這次超過上限，被截成 ${sms(vlag)}。` : '這次沒有被截。') +
        `之後 V 繼續走，vruntime 的絕對值不再有用，醒來時只看 vlag。`,
      line: numberLine('V', [{ x: v - V, label: 'editor', kind: 'old' }]),
      code: codeBlock(snip('v6.6/update_entity_lag'), {
        context: 2,
        marks: {
          lag: { note: `${ms(V)} − ${ms(v)} = ${sms(lag)}` },
          limit: { note: `±${ms(limit, 1)}` },
          clamp: { note: `vlag = ${sms(vlag)}`, kind: clipped ? 'key' : 'run' },
        },
      }),
    };
  }
  const V = num(wake.d, 'V');
  const lag = num(wake.d, 'lag');
  const W = num(wake.d, 'W');
  const w = num(wake.d, 'weight');
  const v = num(wake.d, 'vruntime');
  const dl = num(wake.d, 'deadline');
  const vslice = num(wake.d, 'vslice');
  return {
    caption:
      `t = ${ms(wake.t)}，editor 醒來，睡了 ${ms(wake.t - sleep.t, 1)}。place_entity() 以現在的 V = ${ms(V)} 為基準，` +
      `把 vlag ${sms(vlag)} 放大 (W + w) / W = (${W} + ${w}) / ${W} 倍成 ${sms(lag)}，再放到 V − lag。` +
      `要放大是因為 V 是加權平均，editor 一加入就會把 V 往自己這邊拉，不先放大的話，放好之後的 lag 會縮水（推導在程式碼註解裡，可以展開看）。` +
      `deadline 是 vruntime 再加一個 slice（0.75ms）換成的虛擬時間 ${ms(vslice)}。` +
      `睡了多久不影響結果，同樣的 vlag 睡 4.7ms 或 97.3ms 會放在同一個相對位置。`,
    line: numberLine('V', [
      { x: v - V, label: '放置', kind: 'new' },
      { x: dl - V, label: 'deadline', kind: 'dl' },
    ]),
    code: codeBlock(snip('v6.6/place_entity'), {
      context: 1,
      marks: {
        V: { note: `V = ${ms(V)}` },
        lag_if: { note: '' },
        vlag: { note: `= ${sms(vlag)}` },
        load: { note: `W = ${W}` },
        inflate: { note: `× (${W} + ${w})` },
        div: { note: `÷ ${W} → ${sms(lag)}`, kind: 'key' },
        assign: { note: `= ${ms(v)}` },
        initial: { note: '喚醒不是 ENQUEUE_INITIAL，不走', kind: 'skip' },
        deadline: { note: `= ${ms(dl)}` },
      },
    }),
  };
}

// ---------------------------------------------------------------------------

function stepper(root: HTMLElement): void {
  const { cfs, eevdf } = runTraces();
  const n = Math.min(cfs.length, eevdf.length);
  const total = 2 * n;
  let step = 0;

  const card = h('article', 'card explain');
  card.innerHTML = `
    <h2>逐步執行：editor 睡著、醒來</h2>
    <p>兩個 compile 一直佔著 CPU。editor 在 30.3ms 出現，每次跑 1.3ms 就去睡，先睡兩次 4.7ms，再睡一次 97.3ms，然後重複。短睡和長睡交錯，是為了讓 CFS 兩種結果都出現：一種是保留原本的 vruntime，一種是被拉到補償的位置。所有時間都刻意不對齊 1ms 的 tick。</p>
    <p class="desc">每一步左右各顯示一個 kernel 函式。底色標出這一步執行到的行，行尾是模擬器算出的實際數值；橘色是決定結果的那一行，灰色斜體是這一步沒有走到的分支。數線以 CFS 的 min_vruntime、EEVDF 的 V 為 0，越左邊越早被選到。</p>`;
  const bar = h('div', 'stepbar');
  const prev = h('button', '', '◀ 上一步');
  const next = h('button', '', '下一步 ▶');
  prev.type = next.type = 'button';
  const label = h('span', 'steplabel');
  bar.append(prev, label, next);
  card.append(bar);

  const cols = h('div', 'srccols');
  const left = h('section', 'srccol');
  const right = h('section', 'srccol');
  cols.append(left, right);
  card.append(cols);

  // 摘要表：每次喚醒的結果
  const table = h('table', 'wake-table');
  table.innerHTML =
    '<thead><tr><th>#</th><th>睡了</th><th>CFS 睡前<br>v − min_vruntime</th><th>CFS 醒來<br>v − min_vruntime</th><th>CFS 補償</th>' +
    '<th>EEVDF 睡前<br>vlag</th><th>EEVDF 醒來<br>v − V</th></tr></thead>';
  const tb = h('tbody');
  for (let k = 0; k < n; k++) {
    const c = cfs[k]!;
    const e = eevdf[k]!;
    const tr = h('tr');
    const cBefore = num(c.sleep.d, 'vruntime') - num(c.sleep.d, 'min_vruntime');
    const cAfter = num(c.wake.d, 'vruntime') - num(c.wake.d, 'min_vruntime');
    tr.innerHTML =
      `<td>${k + 1}</td><td>${ms(c.wake.t - c.sleep.t, 1)}</td><td>${sms(cBefore)}</td><td>${sms(cAfter)}</td>` +
      `<td>${c.wake.d.kept_old ? '沒用上' : '拉到 −20ms'}</td>` +
      `<td>${sms(num(e.sleep.d, 'vlag'))}</td><td>${sms(num(e.wake.d, 'vruntime') - num(e.wake.d, 'V'))}</td>`;
    tr.addEventListener('click', () => go(2 * k + 1));
    tb.append(tr);
  }
  table.append(tb);
  const sum = h('div', 'wake-summary');
  sum.append(
    h('h3', '', '每次喚醒的結果（點一列跳到那一步）'),
    table,
    h(
      'p',
      '',
      'CFS 那兩欄看得出補償只和「睡多久、這段時間 min_vruntime 走多遠」有關：短睡醒來和睡前差不多，長睡一律變成 −20ms，不管睡前是落後還是超前。' +
        '第一次長睡之後，editor 每次只跑 1.3ms，追不回這 20ms，之後連短睡醒來也被 max_vruntime() 拉回 −20ms，等於一直貼著補償的上限，' +
        '每次醒來都排在兩個 compile 前面。這就是模擬頁裡 CFS 的 editor lag 一路往下的原因。' +
        'EEVDF 醒來的位置只由睡前的 vlag 決定，乘上 1.5 倍（兩個 compile 加上自己，(2048 + 1024) / 2048）再反號。' +
        '睡前多拿了（vlag 為負），醒來就排在 V 後面，要先還；睡多久都一樣。',
    ),
  );
  card.append(sum);
  root.append(card);

  function render(): void {
    const k = Math.floor(step / 2);
    const phase = step % 2 ? 'wake' : 'sleep';
    label.textContent = `第 ${step + 1} / ${total} 步：第 ${k + 1} 次${phase === 'sleep' ? '睡著' : '醒來'}`;
    prev.disabled = step === 0;
    next.disabled = step === total - 1;
    for (const [col, title, view] of [
      [left, 'CFS v2.6.24', cfsStep(cfs[k]!, phase)],
      [right, 'EEVDF v6.6', eevdfStep(eevdf[k]!, phase)],
    ] as const) {
      const scroll = col.querySelector('.lines')?.scrollTop ?? 0;
      col.replaceChildren(h('h3', 'coltitle', title), h('p', 'caption', esc(view.caption)), view.line, view.code);
      // 同一個函式就維持捲動位置
      const lines = col.querySelector<HTMLElement>('.lines');
      if (lines) lines.scrollTop = scroll;
    }
    for (const [i, tr] of [...tb.children].entries()) tr.classList.toggle('current', i === k);
  }
  function go(s: number): void {
    step = Math.max(0, Math.min(total - 1, s));
    render();
  }
  prev.addEventListener('click', () => go(step - 1));
  next.addEventListener('click', () => go(step + 1));
  card.tabIndex = 0;
  card.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') go(step + 1);
    else if (e.key === 'ArrowLeft') go(step - 1);
    else return;
    e.preventDefault();
  });
  render();
}

// ---------------------------------------------------------------------------
// 靜態對照：v6.5、migration

function v65Card(root: HTMLElement): void {
  const card = h('article', 'card explain');
  card.innerHTML = `
    <h2>中間的版本：v6.5 的補償</h2>
    <p>v2.6.24 之後補償的算法改過幾次。下面是 EEVDF 合併前最後一版 CFS（v6.5）的 <code>place_entity()</code>。模擬器沒有實作 v6.5，這裡只對照程式碼。和 v2.6.24 比，有三個地方不同。</p>
    <h3>補償減半</h3>
    <p><code>thresh</code> 先取 <code>sysctl_sched_latency</code>，開了 <code>GENTLE_FAIR_SLEEPERS</code> 再右移一位。註解寫的理由是「讓睡眠者的效果溫和一點」。這個 feature 從 v2.6.32 開始有，預設開；同一版 latency 預設值也從 20ms 改成 5ms。到了 v6.5，latency 是 6ms 乘上 1 + ilog2(CPU 數)，CPU 最多算 8 顆，所以單核是 6ms、8 核以上是 24ms，減半後實際補償 3ms 到 12ms。v2.6.24 單核補 20ms，比現在多很多。</p>
    <h3>SCHED_IDLE 只補 min_granularity</h3>
    <p><code>se_is_idle()</code> 的程式（SCHED_IDLE）補償改用 <code>sysctl_sched_min_granularity</code>，醒來的優勢更小。</p>
    <h3>睡太久就不看舊值</h3>
    <p><code>max_vruntime(se->vruntime, vruntime)</code> 是用 <code>(s64)(a − b)</code> 比大小。min_vruntime 可以走得比真實時間快很多，最極端是一直在跑的是權重最低的程式。睡得夠久，舊的 vruntime 和現在的 min_vruntime 差距會超過 s64 能表示的範圍，比較結果整個反過來，程式會被留在原本的舊位置，等於拿到極大的補償。v6.3 加入 <code>entity_is_long_sleeper()</code>：睡超過 2<sup>63</sup> / NICE_0_LOAD ns（約 104 天）就直接放到候選位置，不跟舊值比。註解說最大的加速倍率是 NICE_0_LOAD / MIN_SHARES，用 NICE_0_LOAD 當除數是多留了餘裕，也涵蓋 migration 時兩顆 CPU 時鐘的誤差。</p>
    <p>沒有變的部分是基準點還是 min_vruntime、還是用 <code>max_vruntime()</code> 防止倒退。所以 v2.6.24 的問題 v6.5 一樣有：補償和睡前的公平狀態無關，只是一段固定的時間。</p>`;
  const grid = h('div', 'srccols');
  grid.append(
    codeBlock(snip('v6.5/place_entity'), {
      context: 2,
      marks: {
        base: { note: '基準還是 min_vruntime' },
        thresh: { note: '單核 6ms' },
        gentle: { note: '減半 → 3ms', kind: 'key' },
        sleeper: { note: '' },
        long_sleeper: { note: 'v6.3 加入' },
        clamp: { note: '和 v2.6.24 一樣取大的' },
      },
    }),
    codeBlock(snip('v6.5/entity_is_long_sleeper'), {
      marks: { limit: { note: '≈ 104 天', kind: 'key' } },
    }),
  );
  card.append(grid);
  root.append(card);
}

function migrationCard(root: HTMLElement): void {
  const card = h('article', 'card explain');
  card.innerHTML = `
    <h2>migration：vruntime 為什麼要先減再加</h2>
    <p class="desc">模擬器是單核，沒有 migration，這一段只對照程式碼，沒有逐步執行。</p>
    <p>每顆 CPU 有自己的 cfs_rq，各自的 min_vruntime 從開機起各走各的，數值之間沒有關係。CFS 的 vruntime 是絕對值，搬到另一顆 CPU 時如果原封不動，目的地的 min_vruntime 可能大很多，也可能小很多。目的地的比較小，程式會排到最後面，等很久；目的地的比較大，程式會排到最前面，一直跑到追上別人為止。</p>
    <p>v6.5 的做法是離開時減掉舊 CPU 的 min_vruntime，變成相對位置，到了新 CPU 再加上新 CPU 的 min_vruntime。有兩條路：</p>
    <ul>
      <li>還在 runqueue 上的程式被搬走（load balance）：<code>dequeue_entity()</code> 的 flags 沒有 <code>DEQUEUE_SLEEP</code>，減掉；
        <code>enqueue_entity()</code> 的 flags 沒有 <code>ENQUEUE_WAKEUP</code>，<code>renorm</code> 為真，加回來。</li>
      <li>睡著的程式在另一顆 CPU 被喚醒：它睡下去時走的是 <code>DEQUEUE_SLEEP</code>，vruntime 留著絕對值，所以要在 <code>migrate_task_rq_fair()</code> 裡補減（這時狀態是 <code>TASK_WAKING</code>）；到了新 CPU，<code>ENQUEUE_MIGRATED</code> 讓 <code>renorm</code> 為真，加回來後再走 <code>place_entity()</code> 的補償。</li>
    </ul>
    <p>第二條路有個小缺點，<code>MIGRATION</code> 註解自己也寫了：遠端喚醒時沒有拿舊 CPU 的鎖，不能先對舊 CPU 做 <code>update_curr()</code>，減掉的 min_vruntime 不是最新的（所以要用 <code>u64_u32_load()</code> 讀，32 位元機器上才不會讀到撕裂的值）。</p>
    <p>v6.6 的 <code>migrate_task_rq_fair()</code> 不再碰 vruntime，<code>dequeue_entity()</code> 也沒有減 min_vruntime 那一行。原因是 EEVDF 本來就存著一個相對量：每次 dequeue 都呼叫 <code>update_entity_lag()</code>，把 V − vruntime 存進 vlag；每次 enqueue（不只是喚醒）都呼叫 <code>place_entity()</code>，用目的地的 V 減回去。vlag 是相對於 V 的量，在哪顆 CPU 放回去都一樣，不用另外正規化。min_vruntime 在 v6.6 還在，但只當 <code>avg_vruntime</code> 的基準點，讓加權和的乘法不會溢位，已經不拿來決定程式放在哪裡。</p>`;

  const grid = h('div', 'srccols');
  grid.append(
    codeBlock(snip('v6.5/migrate_task_rq_fair'), {
      context: 3,
      marks: {
        waking: { note: '睡著的程式被遠端喚醒' },
        normalize: { note: '減掉舊 CPU 的 min_vruntime', kind: 'key' },
      },
    }),
    codeBlock(snip('v6.6/migrate_task_rq_fair'), { marks: {}, caption: '已經沒有 vruntime 的處理' }),
  );
  card.append(grid);

  const more = h('details', 'more-code');
  more.append(h('summary', '', 'v6.5 的 MIGRATION 註解，以及 dequeue / enqueue 兩端（v6.5 與 v6.6 對照）'));
  more.append(codeBlock(snip('v6.5/migration-comment'), { marks: {} }));
  const g1 = h('div', 'srccols');
  g1.append(
    codeBlock(snip('v6.5/dequeue_entity'), {
      context: 3,
      marks: {
        normalize_if: { note: '不是睡著（被搬走）' },
        normalize: { note: '變成相對位置', kind: 'key' },
      },
    }),
    codeBlock(snip('v6.6/dequeue_entity'), {
      context: 3,
      marks: { lag: { note: '每次 dequeue 都記 vlag', kind: 'key' } },
    }),
  );
  const g2 = h('div', 'srccols');
  g2.append(
    codeBlock(snip('v6.5/enqueue_entity'), {
      context: 2,
      marks: {
        renorm: { note: '被搬來的、或遠端喚醒的', kind: 'key' },
        renorm_curr: { note: '' },
        renorm_other: { note: '加上新 CPU 的 min_vruntime' },
        place: { note: '只有喚醒才補償' },
        migrated: { note: '' },
      },
    }),
    codeBlock(snip('v6.6/enqueue_entity'), {
      context: 2,
      marks: { migrated: { note: '' } },
      caption: '兩處 place_entity() 都不看 flags，每次 enqueue 都放置',
    }),
  );
  more.append(g1, g2);
  card.append(more);
  root.append(card);
}

let mounted = false;

/** 第一次切到原始碼頁時才建立（模擬 + DOM） */
export function mountSourcePage(root: HTMLElement): void {
  if (mounted) return;
  mounted = true;
  root.replaceChildren();
  const intro = h('article', 'card explain');
  intro.innerHTML = `
    <h2>睡醒的程式放在哪裡</h2>
    <p>程式睡醒回到 runqueue 時，排程器要決定它的 vruntime 從哪裡算起。這個決定同時影響延遲和公平：放得前面，它醒來就能先跑，但用的是別人的時間；放得後面，編輯器按一個鍵要等前面的人跑完。CFS 用「睡過就補一段」來處理，EEVDF 改成「記住睡前的 lag，醒來放回去」。這一頁用同一個情境把兩邊的程式碼逐步對起來，再看中間的 v6.5 和 migration 那段，最後會發現 EEVDF 拿掉補償之後，migration 的正規化也一起不需要了。</p>
    <p class="desc">程式碼片段由 <code>scripts/extract-snippets.ts</code> 從 <code>kernel-src/</code> 抽出，行號是原檔的行號，標題列連到 Elixir。lag 的定義與 GPS 的推導在學習路線<a href="#/learn/lag">第 3 章</a>。</p>`;
  root.append(intro);
  stepper(root);
  v65Card(root);
  migrationCard(root);
}
