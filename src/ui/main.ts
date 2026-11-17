// 最小的前端：時間軸 + 相對 GPS 的 lag 曲線 + 指標表。原始碼對照與數學說明之後再加。
import { Simulator } from '../core/engine.ts';
import { summarize, type Summary } from '../core/metrics.ts';
import { NSEC_PER_MSEC as MS, NSEC_PER_SEC as SEC, NSEC_PER_USEC as US, type SchedClass } from '../core/types.ts';
import { GpsShadow, simulateGps, type ShadowSample, type ShadowTaskState } from '../ref/gps.ts';
import { RunRecorder } from '../ref/recorder.ts';
import { scenarios, type Scenario } from '../scenarios.ts';
import { CfsV2_6_24 } from '../sched/cfs-v2.6.24.ts';
import { EevdfV6_6 } from '../sched/eevdf-v6.6.ts';
import { EevdfV6_12 } from '../sched/eevdf-v6.12.ts';

const DURATION = 2 * SEC;
/** 程式的顏色跟著 task 走（第 i 個 task 固定用第 i 個顏色），深淺色各一組，定義在 style.css */
const taskColor = (i: number) => `var(--series-${(i % 4) + 1})`;
const taskColorValue = (i: number) => css(`--series-${(i % 4) + 1}`);

interface SchedDef {
  title: string;
  note: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  make: () => SchedClass<any>;
}

const scheds: SchedDef[] = [
  { title: 'CFS v2.6.24', note: 'vruntime 最小者先跑；喚醒時補償最多 sched_latency（20ms）。', make: () => new CfsV2_6_24() },
  { title: 'EEVDF v6.6', note: 'eligible（lag ≥ 0）中 deadline 最早者；slice 一律 0.75ms，忽略 task 的 slice 要求。', make: () => new EevdfV6_6() },
  {
    title: 'EEVDF v6.12（slice 選項）',
    note: '加上 custom_slice、PREEMPT_SHORT、DELAY_DEQUEUE。其餘沿用 v6.6（簡化）。',
    make: () => new EevdfV6_12(),
  },
];

interface RunData {
  def: SchedDef;
  summary: Summary;
  rec: RunRecorder;
  shadow: GpsShadow;
  names: string[];
}

function simulate(sc: Scenario): { runs: RunData[]; gpsShare: number[] } {
  const gps = simulateGps(sc.tasks, { duration: DURATION });
  const gpsShare = gps.tasks.map((t) => t.runtime / DURATION);
  const runs = scheds.map((def) => {
    const rec = new RunRecorder();
    const shadow = new GpsShadow({ record: true });
    const sim = new Simulator(def.make(), sc.tasks, { duration: DURATION, observers: [rec, shadow] });
    const summary = summarize(sim.run());
    return { def, summary, rec, shadow, names: sc.tasks.map((t) => t.name) };
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

function drawTimeline(canvas: HTMLCanvasElement, run: RunData, view: View): void {
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
  drawCursor(ctx, view, x, 0, n * ROW);
}

function drawTimeAxis(ctx: CanvasRenderingContext2D, view: View, y: number, w: number): void {
  const span = view.t1 - view.t0;
  const steps = [10 * US, 50 * US, 100 * US, 500 * US, MS, 2 * MS, 5 * MS, 10 * MS, 20 * MS, 50 * MS, 100 * MS, 200 * MS, 500 * MS];
  const step = steps.find((s) => span / s <= 10) ?? SEC;
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

function drawLag(canvas: HTMLCanvasElement, run: RunData, view: View): string {
  const H = 140;
  const ctx = setupCanvas(canvas, H);
  const w = canvas.clientWidth - LEFT;
  const x = (t: number) => LEFT + ((t - view.t0) / (view.t1 - view.t0)) * w;
  const samples = run.shadow.samples;

  // 視窗內（含前後各一個樣本，讓線接得上）
  const i0 = Math.max(0, lowerBound(samples, view.t0) - 1);
  const i1 = Math.min(samples.length, lowerBound(samples, view.t1) + 1);
  const pts = samples.slice(i0, i1);
  if (i0 === 0) pts.unshift({ t: 0, V: 0, lag: run.names.map(() => 0) });

  let max = 1 * US;
  for (const s of pts) for (const l of s.lag) max = Math.max(max, Math.abs(l));
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

function metricsTable(run: RunData, gpsShare: number[]): string {
  const st = run.shadow.states;
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const lat = (x: number) => (Number.isNaN(x) ? '—' : fmtTime(x));
  const rows = run.summary.tasks
    .map((t, i) => {
      const s: ShadowTaskState | undefined = st[i];
      const color = taskColor(i);
      return `<tr>
        <td><span class="swatch" style="background:${color}"></span>${t.name}</td>
        <td>${t.nice}</td>
        <td>${pct(t.share)}</td>
        <td>${pct(gpsShare[i]!)}</td>
        <td>${t.wakeups ? lat(t.wakeupLatencyAvg) : '—'}</td>
        <td>${t.wakeups ? lat(t.wakeupLatencyP99) : '—'}</td>
        <td>${s ? `${fmtTime(s.lagMin)} … ${fmtTime(s.lagMax)}` : '—'}</td>
        <td>${t.nvcsw} / ${t.nivcsw}</td>
      </tr>`;
    })
    .join('');
  return `<table>
    <thead><tr><th>task</th><th>nice</th><th>CPU 比例</th><th>GPS 比例</th><th>喚醒延遲 平均</th><th>p99</th><th>相對 GPS 的 lag 範圍</th><th>主動 / 被搶</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="note">2 秒內 context switch ${run.summary.nr_switches} 次</p>`;
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
  for (const i of idx) {
    for (const r of runs) {
      const t = r.summary.tasks[i]!;
      const avg = (t.wakeupLatencyAvg / max) * 100;
      const p99 = (t.wakeupLatencyP99 / max) * 100;
      const label = `平均 ${fmtTime(t.wakeupLatencyAvg)}，p99 ${fmtTime(t.wakeupLatencyP99)}，最慢 ${fmtTime(t.wakeupLatencyMax)}`;
      rows.push(`<div class="viz-row" title="${r.def.title}：${t.name} ${label}">
        <div class="lbl">${r.def.title}</div>
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
    ${rows.join('')}
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
      return `<div class="viz-row" title="${r.def.title}：${t.name} 實際 ${(t.share * 100).toFixed(2)}%，公平的份 ${(gpsShare[i]! * 100).toFixed(2)}%">
        <div class="lbl sub">${t.name}</div>
        <div class="track"><div class="zero" style="left:50%"></div>${bar}</div>
      </div>`;
    });
    return `<div class="viz-group"><div class="viz-row"><div class="lbl">${r.def.title}</div><div></div></div>${rows.join('')}</div>`;
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
  return `<h2>結果</h2>
    <p class="lead">把兩種需求分開來比，數字是 2 秒模擬的總計。</p>
    ${latencyChart(sc, data.runs)}
    ${fairnessChart(sc, data.runs, data.gpsShare)}
    <h3>怎麼解讀</h3>
    <ul>${sc.takeaway.map((x) => `<li>${x}</li>`).join('')}</ul>`;
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

let data: ReturnType<typeof simulate>;
const view: View = { t0: 0, t1: 0, cursor: null };
let charts: { timeline: HTMLCanvasElement; lag: HTMLCanvasElement; readout: HTMLElement; run: RunData }[] = [];

function rebuild(): void {
  const sc = scenarios.find((s) => s.id === scenarioSel.value)!;
  $('scenarioCard').innerHTML = scenarioCard(sc);
  data = simulate(sc);
  $('results').innerHTML = resultsSection(sc);
  panels.innerHTML = '';
  charts = data.runs.map((run) => {
    const el = document.createElement('section');
    el.className = 'panel';
    el.innerHTML = `<h2>${run.def.title}</h2><p class="note">${run.def.note}</p>
      <canvas class="timeline"></canvas>
      <div class="chart-label">相對 GPS 的 lag（應得 − 實得）</div>
      <canvas class="lag"></canvas>
      <div class="chart-label readout">&nbsp;</div>
      <div class="metrics">${metricsTable(run, data.gpsShare)}</div>`;
    panels.append(el);
    const c = {
      timeline: el.querySelector<HTMLCanvasElement>('canvas.timeline')!,
      lag: el.querySelector<HTMLCanvasElement>('canvas.lag')!,
      readout: el.querySelector<HTMLElement>('.readout')!,
      run,
    };
    for (const canvas of [c.timeline, c.lag]) {
      canvas.addEventListener('mousemove', (e) => {
        const r = canvas.getBoundingClientRect();
        const px = e.clientX - r.left - LEFT;
        const w = r.width - LEFT;
        view.cursor = px < 0 ? null : view.t0 + (px / w) * (view.t1 - view.t0);
        draw();
      });
      canvas.addEventListener('mouseleave', () => {
        view.cursor = null;
        draw();
      });
    }
    return c;
  });
  updateView();
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
  for (const c of charts) {
    drawTimeline(c.timeline, c.run, view);
    c.readout.textContent = drawLag(c.lag, c.run, view) || ' ';
  }
}

// ---- 分頁（#/sim、#/concepts、#/source）
function route(): void {
  const page = location.hash.replace(/^#\//, '') || 'sim';
  for (const el of document.querySelectorAll<HTMLElement>('.page')) el.hidden = el.id !== `page-${page}`;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('nav a')) a.classList.toggle('active', a.dataset.page === page);
  for (const el of document.querySelectorAll<HTMLElement>('[data-for]')) el.hidden = el.dataset.for !== page;
  if (page === 'sim') draw(); // 隱藏時 canvas 寬度是 0，顯示後要重畫
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

scenarioSel.addEventListener('change', rebuild);
widthSel.addEventListener('change', updateView);
startInput.addEventListener('input', updateView);
window.addEventListener('resize', draw);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', draw);
rebuild();
route();
