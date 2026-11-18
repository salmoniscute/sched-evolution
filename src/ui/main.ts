// 前端：模擬頁（時間軸 + 相對 GPS 的 lag 曲線 + 指標表）、學習路線（src/ui/learn.ts）、原始碼頁（src/ui/source.ts）。
import { Simulator } from '../core/engine.ts';
import { summarize, type Summary } from '../core/metrics.ts';
import { NSEC_PER_MSEC as MS, NSEC_PER_SEC as SEC, NSEC_PER_USEC as US } from '../core/types.ts';
import { GpsShadow, simulateGps, type ShadowSample, type ShadowTaskState } from '../ref/gps.ts';
import { RunRecorder } from '../ref/recorder.ts';
import { scenarios, type Exercise, type Scenario } from '../scenarios.ts';
import { changedFlags, defaultFlags, variants, type Flags, type SchedVariant } from '../variants.ts';
import { installCodeChips } from './code-chips.ts';
import { renderMathIn } from './math.ts';
import { glossaryHtml, installTooltips, term } from './glossary.ts';
import { latestAtOrBefore, latestForPid, renderDecision, type InspectCtx } from './inspect.ts';
import { mountLearn, showChapter } from './learn.ts';
import { mountSourcePage } from './source.ts';
import { mountStartWidgets } from './start.ts';
import { startTour, stopTour, tourDone, type TourStep } from './tour.ts';

const DURATION = 2 * SEC;
/** 程式的顏色跟著 task 走（第 i 個 task 固定用第 i 個顏色），深淺色各一組，定義在 style.css */
const taskColor = (i: number) => `var(--series-${(i % 4) + 1})`;
const taskColorValue = (i: number) => css(`--series-${(i % 4) + 1}`);

/** 每個排程器目前的開關；預設全開（kernel 預設值） */
const flagState = new Map<string, Flags>(variants.map((v) => [v.id, defaultFlags(v)]));

interface RunData {
  def: SchedVariant;
  flags: Flags;
  /** 被關掉的開關 */
  changed: string[];
  /** 標題；改過開關時會註明 */
  label: string;
  summary: Summary;
  /** 改過開關時：同一個排程器用預設值跑的結果，給表格對照 */
  base: Summary | null;
  rec: RunRecorder;
  shadow: GpsShadow;
  names: string[];
}

function simulate(sc: Scenario): { runs: RunData[]; gpsShare: number[] } {
  const gps = simulateGps(sc.tasks, { duration: DURATION });
  const gpsShare = gps.tasks.map((t) => t.runtime / DURATION);
  const runs = variants.map((def) => {
    const flags = flagState.get(def.id)!;
    const changed = changedFlags(def, flags);
    const rec = new RunRecorder();
    const shadow = new GpsShadow({ record: true });
    const sim = new Simulator(def.make(flags), def.tasks(sc.tasks, flags), { duration: DURATION, observers: [rec, shadow] });
    const summary = summarize(sim.run());
    const dflt = defaultFlags(def);
    const base = changed.length ? summarize(new Simulator(def.make(dflt), def.tasks(sc.tasks, dflt), { duration: DURATION }).run()) : null;
    const label = changed.length ? `${def.title}（改過開關）` : def.title;
    return { def, flags, changed, label, summary, base, rec, shadow, names: sc.tasks.map((t) => t.name) };
  });
  return { runs, gpsShare };
}

// ---------------------------------------------------------------------------
// 畫圖

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function setupCanvas(canvas: HTMLCanvasElement, height: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

const LEFT = 64; // 左側標籤寬度
const ROW = 18;

interface View {
  t0: number;
  t1: number;
  cursor: number | null;
}

function fmtTime(ns: number): string {
  if (Math.abs(ns) >= 100 * MS) return `${(ns / MS).toFixed(0)}ms`;
  if (Math.abs(ns) >= MS) return `${(ns / MS).toFixed(1)}ms`;
  return `${(ns / US).toFixed(0)}µs`;
}

function drawTimeline(canvas: HTMLCanvasElement, run: RunData, view: View, selT: number | null): void {
  const n = run.names.length;
  const h = n * ROW + 22;
  const ctx = setupCanvas(canvas, h);
  const w = canvas.clientWidth - LEFT;
  const x = (t: number) => LEFT + ((t - view.t0) / (view.t1 - view.t0)) * w;

  ctx.font = '12px -apple-system, sans-serif';
  ctx.textBaseline = 'middle';
  run.names.forEach((name, i) => {
    ctx.fillStyle = css('--muted');
    ctx.fillText(name, 0, i * ROW + ROW / 2);
  });

  // 可執行（淡色）
  for (const s of run.rec.runnable) {
    if (s.t1 < view.t0 || s.t0 > view.t1) continue;
    ctx.fillStyle = taskColorValue(s.pid - 1);
    ctx.globalAlpha = 0.18;
    const x0 = Math.max(LEFT, x(s.t0));
    ctx.fillRect(x0, (s.pid - 1) * ROW + 3, Math.max(1, Math.min(x(s.t1), LEFT + w) - x0), ROW - 6);
  }
  // 在 CPU 上（實心）
  ctx.globalAlpha = 1;
  for (const s of run.rec.segments) {
    if (s.pid === null || s.t1 < view.t0 || s.t0 > view.t1) continue;
    ctx.fillStyle = taskColorValue(s.pid - 1);
    const x0 = Math.max(LEFT, x(s.t0));
    ctx.fillRect(x0, (s.pid - 1) * ROW + 3, Math.max(1, Math.min(x(s.t1), LEFT + w) - x0), ROW - 6);
  }

  drawTimeAxis(ctx, view, n * ROW, w);
  drawSelection(ctx, view, x, 0, n * ROW, selT, true);
  drawCursor(ctx, view, x, 0, n * ROW);
}

/** 目前檢視的決策：實線，時間軸上方加一個小三角形 */
function drawSelection(
  ctx: CanvasRenderingContext2D,
  view: View,
  x: (t: number) => number,
  y0: number,
  y1: number,
  selT: number | null,
  head: boolean,
): void {
  if (selT === null || selT < view.t0 || selT > view.t1) return;
  const px = Math.round(x(selT)) + 0.5;
  ctx.strokeStyle = ctx.fillStyle = css('--sel');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px, y0);
  ctx.lineTo(px, y1);
  ctx.stroke();
  ctx.lineWidth = 1;
  if (!head) return;
  ctx.beginPath();
  ctx.moveTo(px - 4, y0);
  ctx.lineTo(px + 4, y0);
  ctx.lineTo(px, y0 + 5);
  ctx.fill();
}

function drawTimeAxis(ctx: CanvasRenderingContext2D, view: View, y: number, w: number): void {
  const span = view.t1 - view.t0;
  const steps = [10 * US, 50 * US, 100 * US, 500 * US, MS, 2 * MS, 5 * MS, 10 * MS, 20 * MS, 50 * MS, 100 * MS, 200 * MS, 500 * MS];
  // 刻度數量跟著寬度走，窄螢幕上標籤才不會疊在一起
  const maxTicks = Math.max(2, Math.min(10, Math.floor(w / 70)));
  const step = steps.find((s) => span / s <= maxTicks) ?? SEC;
  ctx.strokeStyle = css('--grid');
  ctx.fillStyle = css('--muted');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let t = Math.ceil(view.t0 / step) * step; t <= view.t1; t += step) {
    const px = LEFT + ((t - view.t0) / span) * w;
    ctx.beginPath();
    ctx.moveTo(px, y);
    ctx.lineTo(px, y + 4);
    ctx.stroke();
    // 兩端的標籤往內收，避免被裁掉
    const half = ctx.measureText(fmtTime(t)).width / 2;
    ctx.fillText(fmtTime(t), Math.min(Math.max(px, LEFT + half), LEFT + w - half), y + 6);
  }
  ctx.textAlign = 'left';
}

function drawCursor(ctx: CanvasRenderingContext2D, view: View, x: (t: number) => number, y0: number, y1: number): void {
  if (view.cursor === null) return;
  ctx.strokeStyle = css('--cursor');
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(x(view.cursor), y0);
  ctx.lineTo(x(view.cursor), y1);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** 二分搜尋：第一個 t ≥ target 的樣本 */
function lowerBound(samples: ShadowSample[], target: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 視窗內的 lag 樣本（含前後各一個，讓線接得上） */
function lagPoints(run: RunData, view: View): ShadowSample[] {
  const samples = run.shadow.samples;
  const i0 = Math.max(0, lowerBound(samples, view.t0) - 1);
  const i1 = Math.min(samples.length, lowerBound(samples, view.t1) + 1);
  const pts = samples.slice(i0, i1);
  if (i0 === 0) pts.unshift({ t: 0, V: 0, lag: run.names.map(() => 0) });
  return pts;
}

/** 視窗內 |lag| 的最大值，決定縱軸刻度 */
function lagMax(run: RunData, view: View): number {
  let max = 1 * US;
  for (const s of lagPoints(run, view)) for (const l of s.lag) max = Math.max(max, Math.abs(l));
  return max;
}

function drawLag(canvas: HTMLCanvasElement, run: RunData, view: View, max: number, selT: number | null): string {
  const H = 140;
  const ctx = setupCanvas(canvas, H);
  const w = canvas.clientWidth - LEFT;
  const x = (t: number) => LEFT + ((t - view.t0) / (view.t1 - view.t0)) * w;
  const samples = run.shadow.samples;
  const pts = lagPoints(run, view);
  const y = (v: number) => H / 2 - (v / max) * (H / 2 - 8);

  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillStyle = css('--muted');
  ctx.textBaseline = 'middle';
  ctx.fillText(`+${fmtTime(max)}`, 0, y(max));
  ctx.fillText('0', 0, y(0));
  ctx.fillText(`−${fmtTime(max)}`, 0, y(-max));
  ctx.strokeStyle = css('--zero');
  ctx.beginPath();
  ctx.moveTo(LEFT, y(0));
  ctx.lineTo(LEFT + w, y(0));
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.rect(LEFT, 0, w, H);
  ctx.clip();
  run.names.forEach((_, k) => {
    ctx.strokeStyle = taskColorValue(k);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    pts.forEach((s, j) => {
      const v = s.lag[k] ?? 0;
      if (j === 0) ctx.moveTo(x(s.t), y(v));
      else ctx.lineTo(x(s.t), y(v));
    });
    ctx.stroke();
  });
  ctx.restore();
  drawSelection(ctx, view, x, 0, H, selT, false);
  drawCursor(ctx, view, x, 0, H);

  // 游標處的數值
  if (view.cursor === null) return '';
  const j = lowerBound(samples, view.cursor);
  const a = samples[j - 1] ?? { t: 0, lag: run.names.map(() => 0) };
  const b = samples[j];
  const at = (k: number) => {
    const la = a.lag[k] ?? 0;
    if (!b) return la;
    const lb = b.lag[k] ?? 0;
    return la + ((lb - la) * (view.cursor! - a.t)) / (b.t - a.t || 1);
  };
  return `t = ${fmtTime(view.cursor)}　` + run.names.map((nm, k) => `${nm}: ${fmtTime(at(k))}`).join('　');
}

// ---------------------------------------------------------------------------
// 表格

const tipSpan = (label: string, name: string, def: string) => `<span class="term" tabindex="0" data-term="${name}" data-tip="${def}">${label}</span>`;
const CPU_SHARE = tipSpan('CPU 比例', 'CPU 比例', '2 秒內這個程式實際在 CPU 上的時間 ÷ 2 秒。');
const GPS_SHARE = tipSpan(
  'GPS 比例',
  'GPS 比例',
  '同一組程式丟給理想的 GPS 跑 2 秒，這個程式拿到的比例，也就是公平的份。會睡覺的程式睡著時不算份，所以不等於 權重 ÷ 總權重。',
);

function metricsTable(run: RunData, gpsShare: number[]): string {
  const st = run.shadow.states;
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const lat = (x: number) => (Number.isNaN(x) ? '—' : fmtTime(x));
  // 改過開關時，在數字後面附上預設值的結果
  const was = (now: string, base: string | undefined) => (base !== undefined && base !== now ? `${now}<span class="was">預設 ${base}</span>` : now);
  const rows = run.summary.tasks
    .map((t, i) => {
      const s: ShadowTaskState | undefined = st[i];
      const b = run.base?.tasks[i];
      const color = taskColor(i);
      return `<tr>
        <td><span class="swatch" style="background:${color}"></span>${t.name}</td>
        <td>${t.nice}</td>
        <td>${was(pct(t.share), b && pct(b.share))}</td>
        <td>${pct(gpsShare[i]!)}</td>
        <td>${t.wakeups ? was(lat(t.wakeupLatencyAvg), b && lat(b.wakeupLatencyAvg)) : '—'}</td>
        <td>${t.wakeups ? was(lat(t.wakeupLatencyP99), b && lat(b.wakeupLatencyP99)) : '—'}</td>
        <td>${s ? `${fmtTime(s.lagMin)} … ${fmtTime(s.lagMax)}` : '—'}</td>
        <td>${t.nvcsw} / ${t.nivcsw}</td>
      </tr>`;
    })
    .join('');
  return `<table>
    <thead><tr><th>程式</th><th>${term('nice')}</th><th>${CPU_SHARE}</th><th>${GPS_SHARE}</th><th>${term('喚醒延遲')} 平均</th><th>${term('p99')}</th><th>相對 ${term('GPS')} 的 ${term('lag')} 範圍</th><th>${term('主動 / 被搶')}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="note">2 秒內 context switch ${was(`${run.summary.nr_switches} 次`, run.base ? `${run.base.nr_switches} 次` : undefined)}</p>`;
}

function scenarioCard(sc: Scenario): string {
  const roles = sc.tasks
    .map((t, i) => {
      const color = taskColor(i);
      const r = sc.roles[i];
      return `<tr>
        <td><span class="swatch" style="background:${color}"></span>${t.name}</td>
        <td>${r?.what ?? ''}</td>
        <td>${r?.needs ?? ''}</td>
      </tr>`;
    })
    .join('');
  const list = (xs: string[]) => `<ul>${xs.map((x) => `<li>${x}</li>`).join('')}</ul>`;
  const names = sc.tasks.map((t, i) => `<span class="swatch" style="background:${taskColor(i)}"></span>${t.name}`).join('　');
  return `<summary><b>${sc.title}</b>　${names}<span class="more">情境說明</span></summary>
    <p class="story">${sc.story}</p>
    <table class="roles"><thead><tr><th>程式</th><th>在做什麼</th><th>它要的是</th></tr></thead><tbody>${roles}</tbody></table>
    <h3>看哪裡</h3>${list(sc.lookFor)}`;
}

// ---------------------------------------------------------------------------
// 動手試：先猜，再照題目改開關看結果。答案的數字現算，不寫死。

function exerciseCard(sc: Scenario): string {
  if (!sc.exercises.length) return '';
  const items = sc.exercises
    .map((x, i) => {
      const v = x.variant ? variants.find((d) => d.id === x.variant) : undefined;
      const action = v
        ? `<button type="button" class="apply" data-ex="${i}">照這樣設定：${v.title} 關掉 ${x.off!.join('、')}</button>`
        : x.width
          ? `<button type="button" class="apply" data-ex="${i}">照這樣設定：寬度 ${x.width}ms、lag 圖共用刻度</button>`
          : '';
      return `<li>
        <p class="q">${x.question}</p>
        <div class="ex-actions">${action}</div>
        <details class="ans" data-ex="${i}"><summary>猜好了，看答案</summary><div class="ans-body"></div></details>
      </li>`;
    })
    .join('');
  return `<summary><b>動手試：先猜，再看</b><span class="more">${sc.exercises.length} 題</span></summary>
    <p class="lead">先猜，再按「照這樣設定」看圖怎麼變，最後才打開答案。做完一題按排程器上的「恢復預設」。</p>
    <ol class="ex-list">${items}</ol>`;
}

function quickRun(sc: Scenario, v: SchedVariant, flags: Flags) {
  const shadow = new GpsShadow({ record: false });
  const summary = summarize(new Simulator(v.make(flags), v.tasks(sc.tasks, flags), { duration: DURATION, observers: [shadow] }).run());
  return { summary, states: shadow.states };
}

function exerciseAnswer(sc: Scenario, x: Exercise): string {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
  const lagRange = (st: ShadowTaskState | undefined) => (st ? `${fmtTime(st.lagMin)} … ${fmtTime(st.lagMax)}` : '—');
  const name = sc.tasks[x.task]!.name;
  const sleeper = sc.tasks[x.task]!.pattern.some((b) => b.sleep > 0);
  let table: string;
  if (x.variant) {
    const v = variants.find((d) => d.id === x.variant)!;
    const a = quickRun(sc, v, defaultFlags(v));
    const b = quickRun(sc, v, { ...defaultFlags(v), ...Object.fromEntries(x.off!.map((k) => [k, false])) });
    const gps = simulateGps(sc.tasks, { duration: DURATION }).tasks[x.task]!.runtime / DURATION;
    const ta = a.summary.tasks[x.task]!;
    const tb = b.summary.tasks[x.task]!;
    const rows: [string, string, string][] = [];
    if (sleeper) {
      rows.push([`${name} 平均喚醒延遲`, fmtTime(ta.wakeupLatencyAvg), fmtTime(tb.wakeupLatencyAvg)]);
      rows.push([`${name} 最久等了`, fmtTime(ta.wakeupLatencyMax), fmtTime(tb.wakeupLatencyMax)]);
    }
    rows.push([`${name} CPU 比例（公平的份 ${pct(gps)}）`, pct(ta.share), pct(tb.share)]);
    rows.push([`${name} 相對 GPS 的 lag 範圍`, lagRange(a.states[x.task]), lagRange(b.states[x.task])]);
    rows.push(['context switch 次數', String(a.summary.nr_switches), String(b.summary.nr_switches)]);
    table = `<table class="ans-table"><thead><tr><th>${v.title}</th><th>預設</th><th>關掉 ${x.off!.join('、')}</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('')}</tbody></table>`;
  } else {
    const rows = variants.map((v) => {
      const r = quickRun(sc, v, defaultFlags(v));
      return `<tr><td>${v.title}</td>${sc.tasks.map((_, i) => `<td>${lagRange(r.states[i])}</td>`).join('')}</tr>`;
    });
    table = `<table class="ans-table"><thead><tr><th>相對 GPS 的 lag 範圍（2 秒內）</th>${sc.tasks.map((t) => `<th>${t.name}</th>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody></table>`;
  }
  return `${table}<p>${x.answer}</p>`;
}

function wireExercises(sc: Scenario, box: HTMLElement): void {
  for (const btn of box.querySelectorAll<HTMLButtonElement>('button.apply')) {
    btn.addEventListener('click', () => {
      const x = sc.exercises[Number(btn.dataset.ex)]!;
      if (x.variant) {
        const v = variants.find((d) => d.id === x.variant)!;
        flagState.set(v.id, { ...defaultFlags(v), ...Object.fromEntries(x.off!.map((k) => [k, false])) });
        rebuild();
        const i = variants.indexOf(v);
        panels.children[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        if (x.width) widthSel.value = String(x.width);
        sharedLag.checked = true;
        updateView();
        panels.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  }
  for (const d of box.querySelectorAll<HTMLDetailsElement>('details.ans')) {
    d.addEventListener('toggle', () => {
      const body = d.querySelector<HTMLElement>('.ans-body')!;
      if (d.open && !body.innerHTML) body.innerHTML = exerciseAnswer(sc, sc.exercises[Number(d.dataset.ex)]!);
    });
  }
}

// ---------------------------------------------------------------------------
// 結果：兩張比較圖（延遲、公平），數字直接取自模擬

function fmtPt(x: number): string {
  const v = x * 100;
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} 個百分點`;
}

function latencyChart(sc: Scenario, runs: RunData[]): string {
  // 延遲敏感的程式：會睡覺、會被喚醒的那些
  const idx = sc.tasks.map((t, i) => (t.pattern.some((b) => b.sleep > 0) ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return '';
  const rows: string[] = [];
  let max = 50 * US;
  for (const r of runs) for (const i of idx) max = Math.max(max, r.summary.tasks[i]!.wakeupLatencyP99, r.summary.tasks[i]!.wakeupLatencyAvg);
  max *= 1.35; // 右邊留空間放數字
  const lowP99 = runs.some((r) => idx.some((i) => r.summary.tasks[i]!.wakeupLatencyP99 < r.summary.tasks[i]!.wakeupLatencyAvg));
  const p99Note = lowP99
    ? '<p class="note">有些 p99 比平均還小：絕大多數喚醒都不用等，只有少數幾次等很久。這幾次把平均拉高，但不到 1%，所以 p99 還落在不用等的那一群。</p>'
    : '';
  for (const i of idx) {
    for (const r of runs) {
      const t = r.summary.tasks[i]!;
      const avg = (t.wakeupLatencyAvg / max) * 100;
      const p99 = (t.wakeupLatencyP99 / max) * 100;
      const label = `平均 ${fmtTime(t.wakeupLatencyAvg)}，p99 ${fmtTime(t.wakeupLatencyP99)}，最慢 ${fmtTime(t.wakeupLatencyMax)}`;
      rows.push(`<div class="viz-row" title="${r.label}：${t.name} ${label}">
        <div class="lbl">${r.label}</div>
        <div class="track">
          <div class="bar pos" style="left:0;width:max(${avg}%,2px);background:${taskColor(i)}"></div>
          <div class="p99" style="left:calc(${p99}% - 1px)"></div>
          <div class="val" style="left:calc(${Math.max(avg, p99)}% + 8px)">${label}</div>
        </div>
      </div>`);
    }
  }
  const names = idx.map((i) => `<span><span class="swatch" style="background:${taskColor(i)}"></span>${sc.tasks[i]!.name} 的平均喚醒延遲</span>`).join('');
  return `<div class="viz">
    <div class="viz-title">延遲：醒來後等多久才輪到它</div>
    <div class="viz-sub">越短越好。這是 ${idx.map((i) => sc.tasks[i]!.name).join('、')} 在乎的。</div>
    <div class="viz-legend">${names}<span><span class="swatch" style="background:var(--fg);width:2px"></span>p99：把每次的等待排序，第 99% 的那一次</span></div>
    ${rows.join('')}${p99Note}
  </div>`;
}

function fairnessChart(sc: Scenario, runs: RunData[], gpsShare: number[]): string {
  let max = 0.005;
  for (const r of runs) r.summary.tasks.forEach((t, i) => (max = Math.max(max, Math.abs(t.share - gpsShare[i]!))));
  max *= 2.6; // 兩側留空間放數字
  const groups = runs.map((r) => {
    const rows = r.summary.tasks.map((t, i) => {
      const d = t.share - gpsShare[i]!;
      const w = (Math.abs(d) / max) * 100;
      const pos = d >= 0;
      const bar = pos
        ? `<div class="bar pos" style="left:50%;width:max(${w}%,1px);background:${taskColor(i)}"></div>
           <div class="val" style="left:calc(50% + ${w}% + 6px)">${fmtPt(d)}</div>`
        : `<div class="bar neg" style="left:calc(50% - ${w}%);width:max(${w}%,1px);background:${taskColor(i)}"></div>
           <div class="val" style="right:calc(50% + ${w}% + 6px)">${fmtPt(d)}</div>`;
      return `<div class="viz-row" title="${r.label}：${t.name} 實際 ${(t.share * 100).toFixed(2)}%，公平的份 ${(gpsShare[i]! * 100).toFixed(2)}%">
        <div class="lbl sub">${t.name}</div>
        <div class="track"><div class="zero" style="left:50%"></div>${bar}</div>
      </div>`;
    });
    return `<div class="viz-group"><div class="viz-row"><div class="lbl">${r.label}</div><div></div></div>${rows.join('')}</div>`;
  });
  const legend = sc.tasks.map((t, i) => `<span><span class="swatch" style="background:${taskColor(i)}"></span>${t.name}</span>`).join('');
  return `<div class="viz">
    <div class="viz-title">公平：實際拿到的 CPU 比例減掉公平的份（GPS）</div>
    <div class="viz-sub">越接近中線越公平。往右是多拿，往左是少拿；某個程式多拿的，一定是從別的程式那裡拿走的。這是 ${sc.tasks
      .filter((t) => !t.pattern.some((b) => b.sleep > 0))
      .map((t) => t.name)
      .join('、')} 在乎的。</div>
    <div class="viz-legend">${legend}</div>
    ${groups.join('')}
  </div>`;
}

function resultsSection(sc: Scenario): string {
  const changed = data.runs.filter((r) => r.changed.length);
  const warn = changed.length
    ? `<p class="warn">${changed.map((r) => `${r.def.title} 關掉了 ${r.changed.join('、')}`).join('；')}。圖是改過之後的結果，「怎麼解讀」的文字寫的是預設值的結果。</p>`
    : '';
  return `<h2>結果</h2>
    <p class="lead">把兩種需求分開來比，數字是 2 秒模擬的總計。</p>${warn}
    ${latencyChart(sc, data.runs)}
    ${fairnessChart(sc, data.runs, data.gpsShare)}
    <details class="takeaway"><summary>怎麼解讀<span class="more">建議先做完上面的「動手試」再打開</span></summary>
    <ul>${sc.takeaway.map((x) => `<li>${x}</li>`).join('')}</ul></details>`;
}

// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scenarioSel = $<HTMLSelectElement>('scenario');
const widthSel = $<HTMLSelectElement>('width');
const startInput = $<HTMLInputElement>('start');
const startOut = $<HTMLOutputElement>('startOut');
const panels = $('panels');

for (const sc of scenarios) scenarioSel.add(new Option(sc.title, sc.id));
scenarioSel.value = 'latency';

const sharedLag = $<HTMLInputElement>('sharedLag');

let data: ReturnType<typeof simulate>;
const view: View = { t0: 0, t1: 0, cursor: null };

interface Chart {
  timeline: HTMLCanvasElement;
  lag: HTMLCanvasElement;
  readout: HTMLElement;
  insp: { title: HTMLElement; body: HTMLElement; prev: HTMLButtonElement; next: HTMLButtonElement };
  ctx: InspectCtx;
  run: RunData;
  /** 目前檢視的決策在 run.rec.events 裡的位置；-1 表示沒有 */
  selIdx: number;
}
let charts: Chart[] = [];
/** 目前檢視的時刻。每個排程器各自顯示這個時刻之前最近的一次決策。 */
let sel: number | null = null;

const INSPECT_HINT = '點時間軸上任何一處（例如某個程式的淺色段），看那一刻排程器為什麼這樣決定';

/** 排程器的開關列 */
function featureBar(run: RunData): HTMLElement {
  const box = document.createElement('div');
  box.className = 'feats';
  const desc = document.createElement('p');
  desc.className = 'feat-desc';
  // 平常不佔版面；只有關掉的開關才在下面寫出關掉的效果。每個開關做什麼放在滑鼠提示裡。
  const off = run.def.features.filter((f) => run.changed.includes(f.key));
  desc.innerHTML = off.map((f) => `<span><code>${f.key}</code> 關掉：${f.off}</span>`).join('');
  desc.hidden = !off.length;
  const row = document.createElement('div');
  row.className = 'feat-row';
  for (const f of run.def.features) {
    const label = document.createElement('label');
    label.className = run.flags[f.key] ? '' : 'off';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = run.flags[f.key] ?? true;
    input.addEventListener('change', () => {
      flagState.set(run.def.id, { ...run.flags, [f.key]: input.checked });
      rebuild();
    });
    const name = document.createElement('span');
    name.className = 'term';
    name.tabIndex = 0;
    name.dataset.term = `${f.key}（sched_feat）`;
    name.dataset.tip = `開著：${f.on}　關掉：${f.off}`;
    name.textContent = f.key;
    label.append(input, name);
    row.append(label);
  }
  if (run.changed.length) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = '恢復預設';
    reset.addEventListener('click', () => {
      flagState.set(run.def.id, defaultFlags(run.def));
      rebuild();
    });
    row.append(reset);
  }
  box.append(row, desc);
  return box;
}

/** 決策檢視的「排程器實際比了什麼」要不要展開；跟著使用者上次的選擇 */
let detailOpen = false;
let builtFor = '';

function rebuild(): void {
  const sc = scenarios.find((s) => s.id === scenarioSel.value)!;
  $('scenarioCard').innerHTML = scenarioCard(sc);
  // 換情境才重畫題目，否則按了「照這樣設定」之後，已經打開的答案會被收起來
  if (builtFor !== sc.id) {
    const ex = $('exercises');
    ex.innerHTML = exerciseCard(sc);
    ex.hidden = !sc.exercises.length;
    wireExercises(sc, ex);
    builtFor = sc.id;
  }
  data = simulate(sc);
  $('results').innerHTML = resultsSection(sc);
  panels.innerHTML = '';
  charts = data.runs.map((run) => {
    const el = document.createElement('section');
    el.className = 'panel';
    el.innerHTML = `<h2>${run.def.title}${run.changed.length ? `<span class="badge">關掉了 ${run.changed.join('、')}</span>` : ''}</h2>
      <p class="note">${run.def.note}</p>
      <div class="feat-slot"></div>
      <canvas class="timeline"></canvas>
      <div class="insp">
        <div class="insp-bar">
          <button type="button" class="prev" aria-label="上一個決策">◀</button>
          <span class="insp-title"></span>
          <button type="button" class="next" aria-label="下一個決策">▶</button>
        </div>
        <div class="insp-body"></div>
      </div>
      <div class="chart-label">相對 GPS 的 lag（應得 − 實得）</div>
      <canvas class="lag"></canvas>
      <div class="chart-label readout">&nbsp;</div>
      <div class="metrics">${metricsTable(run, data.gpsShare)}</div>`;
    el.querySelector('.feat-slot')!.replaceWith(featureBar(run));
    panels.append(el);
    const c: Chart = {
      timeline: el.querySelector<HTMLCanvasElement>('canvas.timeline')!,
      lag: el.querySelector<HTMLCanvasElement>('canvas.lag')!,
      readout: el.querySelector<HTMLElement>('.readout')!,
      insp: {
        title: el.querySelector<HTMLElement>('.insp-title')!,
        body: el.querySelector<HTMLElement>('.insp-body')!,
        prev: el.querySelector<HTMLButtonElement>('.insp .prev')!,
        next: el.querySelector<HTMLButtonElement>('.insp .next')!,
      },
      ctx: { family: run.def.family, names: run.names, color: taskColor, flags: run.flags, events: run.rec.events },
      run,
      selIdx: -1,
    };
    const timeAt = (canvas: HTMLCanvasElement, e: MouseEvent): number | null => {
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left - LEFT;
      return px < 0 ? null : view.t0 + (px / (r.width - LEFT)) * (view.t1 - view.t0);
    };
    for (const canvas of [c.timeline, c.lag]) {
      canvas.addEventListener('mousemove', (e) => {
        view.cursor = timeAt(canvas, e);
        draw();
      });
      canvas.addEventListener('mouseleave', () => {
        view.cursor = null;
        draw();
      });
      canvas.addEventListener('click', (e) => {
        const t = timeAt(canvas, e);
        if (t === null) return;
        // 點在時間軸某個程式那一列：找和它有關的最近一次決策
        const row = canvas === c.timeline ? Math.floor((e.clientY - canvas.getBoundingClientRect().top) / ROW) : -1;
        const events = c.run.rec.events;
        const idx = row >= 0 && row < c.run.names.length ? latestForPid(events, t, row + 1) : latestAtOrBefore(events, t);
        if (idx >= 0) select(events[idx]!.t, c, idx);
      });
    }
    const step = (d: number) => {
      const events = c.run.rec.events;
      const idx = Math.max(0, Math.min(events.length - 1, c.selIdx + d));
      if (events[idx]) select(events[idx]!.t, c, idx);
    };
    // toggle 不會冒泡，用 capture 接；三個排程器的展開狀態一起變
    c.insp.body.addEventListener(
      'toggle',
      (e) => {
        const d = e.target as HTMLDetailsElement;
        if (!d.classList.contains('insp-detail') || d.open === detailOpen) return;
        detailOpen = d.open;
        for (const o of charts) o.insp.body.querySelector<HTMLDetailsElement>('.insp-detail')?.toggleAttribute('open', detailOpen);
      },
      true,
    );
    c.insp.prev.addEventListener('click', () => step(-1));
    c.insp.next.addEventListener('click', () => step(1));
    return c;
  });
  updateView();
  // 第一次進來先選一個例子：視窗裡第一個程式第一次醒來的那一刻，讓決策檢視一開始就有內容
  if (sel === null && charts[0]) {
    const ev = charts[0].run.rec.events;
    const first = ev.findIndex((e) => e.t >= view.t0 && e.causePid === 1 && e.cause === 'wakeup');
    const idx = first >= 0 ? first : latestAtOrBefore(ev, view.t0 + (view.t1 - view.t0) / 2);
    if (idx >= 0) return select(ev[idx]!.t, charts[0], idx);
  }
  select(sel);
}

/**
 * 檢視時刻 t 的決策。from / idx 指定某個排程器要看的那一個事件，
 * 其他排程器顯示各自在 t 之前最近的一次。
 */
function select(t: number | null, from?: Chart, idx?: number): void {
  sel = t;
  for (const c of charts) {
    c.selIdx = t === null ? -1 : c === from && idx !== undefined ? idx : latestAtOrBefore(c.run.rec.events, t);
    const events = c.run.rec.events;
    c.insp.prev.disabled = c.selIdx <= 0;
    c.insp.next.disabled = c.selIdx < 0 || c.selIdx >= events.length - 1;
    if (c.selIdx < 0) {
      c.insp.title.textContent = INSPECT_HINT;
      c.insp.body.innerHTML = '';
      continue;
    }
    const d = renderDecision(c.ctx, c.selIdx, detailOpen);
    c.insp.title.textContent = `${d.title}　（第 ${c.selIdx + 1} / ${events.length} 個決策）`;
    c.insp.body.innerHTML = d.html;
  }
  // 選到畫面外的時刻就把視窗移過去
  if (t !== null && (t < view.t0 || t > view.t1)) {
    startInput.value = String(Math.max(0, Math.round((t - (view.t1 - view.t0) / 2) / MS)));
    updateView();
  } else draw();
}

function updateView(): void {
  const width = Number(widthSel.value) * MS;
  const maxStart = Math.max(0, DURATION - width);
  startInput.max = String(maxStart / MS);
  startInput.disabled = maxStart === 0;
  const start = Math.min(Number(startInput.value) * MS, maxStart);
  view.t0 = start;
  view.t1 = start + width;
  startOut.value = `${fmtTime(view.t0)} – ${fmtTime(view.t1)}`;
  draw();
}

function draw(): void {
  // 共用刻度：三張 lag 圖用同一個縱軸，振幅才能直接比
  const maxes = charts.map((c) => lagMax(c.run, view));
  const shared = Math.max(...maxes, 1 * US);
  charts.forEach((c, i) => {
    const selT = c.selIdx >= 0 ? c.run.rec.events[c.selIdx]!.t : null;
    drawTimeline(c.timeline, c.run, view, selT);
    c.readout.textContent = drawLag(c.lag, c.run, view, sharedLag.checked ? shared : maxes[i]!, selT) || ' ';
  });
}

// ---- 導覽：取代原本整段的「怎麼看這一頁」，一次只講一個區塊
function tourSteps(): TourStep[] {
  const sc = scenarios.find((s) => s.id === scenarioSel.value)!;
  const first = sc.tasks[0]!.name;
  const panel = (i: number) => panels.children[i] as HTMLElement | undefined;
  const q = (i: number, sel: string) => panel(i)?.querySelector<HTMLElement>(sel) ?? null;
  return [
    {
      target: () => q(0, 'canvas.timeline'),
      title: '時間軸',
      body: `每一列是一個程式。深色在用 CPU，淺色想跑但在排隊，空白在睡覺。紫色線是目前選中的那一刻：${first} 剛醒來。`,
    },
    {
      target: () => q(0, '.insp'),
      title: '為什麼這樣決定',
      body: '這裡用一句話說明那一刻排程器怎麼選。點時間軸任何地方就換成那一刻，點在淺色段可以看它為什麼沒搶到 CPU。◀ ▶ 逐個決策前進。',
    },
    {
      target: () => panel(1) ?? null,
      title: '三欄並排',
      body: `三欄跑的是同一組程式，只有排程器不同。比比看同一個 ${first} 在三欄各排隊多久。`,
    },
    {
      target: () => q(0, 'canvas.lag'),
      title: 'lag 圖',
      body: '線往上表示排程器欠這個程式，往下表示它多拿了。鋸齒是輪流跑造成的，要看的是有沒有一路往下或往上。定義在學習路線第 3 章。',
    },
    {
      target: () => q(0, '.feats'),
      title: '開關',
      body: '這一版 kernel 的 sched_feat，預設全開。滑鼠移到名稱上看它做什麼；關掉一個，下面的表格會附上預設值對照。',
    },
    {
      target: () => (exercisesBox.hidden ? null : exercisesBox),
      title: '動手試',
      body: '不知道從哪裡開始，就從這裡：每題先猜，再按按鈕套用設定，看圖怎麼變。',
    },
  ];
}
const exercisesBox = $('exercises');
$('tourBtn').addEventListener('click', () => startTour(tourSteps()));

// ---- 分頁（#/intro、#/learn/<章>、#/sim、#/source）
/** 舊網址：#/start 是舊首頁，#/basics、#/concepts 併進學習路線 */
const OLD_ROUTES: Record<string, string> = { start: 'intro', basics: 'learn/problem', concepts: 'learn/lag' };
function route(): void {
  let path = location.hash.replace(/^#\//, '') || 'intro';
  if (OLD_ROUTES[path]) {
    path = OLD_ROUTES[path]!;
    history.replaceState(null, '', `#/${path}`);
  }
  const [page, sub] = path.split('/') as [string, string | undefined];
  if (page === 'learn') {
    const ch = showChapter(sub);
    if (ch !== sub) history.replaceState(null, '', `#/learn/${ch}`);
  } else document.title = '排程器演進模擬';
  for (const el of document.querySelectorAll<HTMLElement>('.page')) el.hidden = el.id !== `page-${page}`;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('nav a')) a.classList.toggle('active', a.dataset.page === page);
  for (const el of document.querySelectorAll<HTMLElement>('[data-for]')) el.hidden = el.dataset.for !== page;
  if (page === 'sim') draw(); // 隱藏時 canvas 寬度是 0，顯示後要重畫
  if (page === 'source') mountSourcePage(document.getElementById('page-source')!);
  window.scrollTo(0, 0);
  if (page !== 'sim') stopTour();
  else if (!tourDone()) requestAnimationFrame(() => startTour(tourSteps()));
}
window.addEventListener('hashchange', route);

// 導覽列高度會隨頁面（模擬頁多一列控制項）和視窗寬度改變；原始碼頁的步驟列要貼在它下面
const topbar = document.querySelector<HTMLElement>('.topbar')!;
new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`)).observe(topbar);
$('glossary').innerHTML = glossaryHtml();
mountStartWidgets();
mountLearn();
installTooltips();
renderMathIn();
installCodeChips();
scenarioSel.addEventListener('change', rebuild);
widthSel.addEventListener('change', updateView);
sharedLag.addEventListener('change', draw);
startInput.addEventListener('input', updateView);
window.addEventListener('resize', draw);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
rebuild();
route();
