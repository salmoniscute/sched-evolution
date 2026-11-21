// 學習路線「v6.12：讓 task 說出自己的 slice」的互動小圖：情境 4 的 audio 一個週期內的 lag，
// 以及醒來時 do_preempt_short() 的條件。lag 曲線是玩具模型（三個 nice 0、穩定狀態），
// 下方的延遲與 CPU 比例則是用模擬核心現場跑情境 4 兩秒得到的。
import { Simulator } from '../core/engine.ts';
import { summarize } from '../core/metrics.ts';
import { NSEC_PER_SEC, NSEC_PER_USEC } from '../core/types.ts';
import { scenarios } from '../scenarios.ts';
import { variants, type Flags } from '../variants.ts';

const RUN = 0.31; // audio 每次跑多久（ms）
const SLEEP = 4.73; // 每次睡多久（ms）
const W = 3; // 三個 nice 0：audio、cc1、cc2，w_i / W = 1/3
const SHORT = 0.3;
const BASE = 0.75; // sysctl_sched_base_slice

type Key = 'custom_slice' | 'DELAY_DEQUEUE' | 'PREEMPT_SHORT';
const LABEL: Record<Key, string> = {
  custom_slice: 'audio 要求 0.3ms 的 slice（custom_slice）',
  DELAY_DEQUEUE: 'DELAY_DEQUEUE',
  PREEMPT_SHORT: 'PREEMPT_SHORT',
};

function sliceWidget(box: HTMLElement): void {
  const on: Record<Key, boolean> = { custom_slice: true, DELAY_DEQUEUE: false, PREEMPT_SHORT: true };
  const cache = new Map<string, { avg: number; p99: number; share: number; nr: number }>();

  box.innerHTML = `<div class="w-btns w-checks">${(Object.keys(LABEL) as Key[])
    .map((k) => `<label><input type="checkbox" data-k="${k}"> ${LABEL[k]}</label>`)
    .join('')}</div>
    <div class="w-svg"></div>
    <ul class="w-conds"></ul>
    <p class="w-out"></p>
    <p class="w-tally"></p>`;
  const svgBox = box.querySelector<HTMLElement>('.w-svg')!;
  const conds = box.querySelector<HTMLElement>('.w-conds')!;
  const out = box.querySelector<HTMLElement>('.w-out')!;
  const tally = box.querySelector<HTMLElement>('.w-tally')!;
  const inputs = [...box.querySelectorAll<HTMLInputElement>('input')];
  for (const inp of inputs)
    inp.addEventListener('change', () => {
      on[inp.dataset.k as Key] = inp.checked;
      render();
    });

  /** 用模擬核心跑情境 4（EEVDF v6.12），其他開關維持預設 */
  const measure = () => {
    const key = JSON.stringify(on);
    let m = cache.get(key);
    if (!m) {
      const def = variants.find((v) => v.id === 'eevdf-v6.12-slice')!;
      const sc = scenarios.find((s) => s.id === 'latency')!;
      const flags: Flags = { ...on };
      const dur = 2 * NSEC_PER_SEC;
      const s = summarize(new Simulator(def.make(flags), def.tasks(sc.tasks, flags), { duration: dur, hz: def.hz }).run());
      const a = s.tasks[0]!;
      m = { avg: a.wakeupLatencyAvg / NSEC_PER_USEC, p99: a.wakeupLatencyP99 / NSEC_PER_USEC, share: a.share, nr: s.nr_switches };
      cache.set(key, m);
    }
    return m;
  };

  const render = () => {
    inputs.forEach((inp) => (inp.checked = on[inp.dataset.k as Key]));
    const m = measure();
    const drop = (RUN * (W - 1)) / W; // 跑 RUN，lag 下降 RUN × (1 − w/W)

    // 醒來時的 lag：沒有 DELAY_DEQUEUE 就是睡前的值（v6.6 的 PLACE_LAG 原樣帶回）；有的話睡眠中已經還到 0
    const wakeLag = on.DELAY_DEQUEUE ? 0 : -drop;
    const eligible = wakeLag >= 0;
    const short = on.custom_slice; // audio 0.3ms < cc 的 0.75ms
    const preempt = on.PREEMPT_SHORT && short && eligible;
    // 等待：不 eligible 就等 lag 以 w/W 的速度爬回 0；eligible 但不能插隊，就等 curr 用完 slice，長度取模擬的平均
    const wait = preempt ? 0 : !eligible ? -wakeLag * W : m.avg / 1000;
    const atRun = wakeLag + wait / W;
    const atSleep = atRun - drop;
    // 睡眠中：有 DELAY_DEQUEUE 且 lag 為負，留在樹上以 w/W 的速度還債，還到 0 時被選中、真正離開（DELAY_ZERO）
    const burn = on.DELAY_DEQUEUE && atSleep < 0 ? -atSleep * W : 0;
    const pts: [number, number][] = [
      [0, wakeLag],
      [wait, atRun],
      [wait + RUN, atSleep],
    ];
    if (burn) pts.push([wait + RUN + burn, 0]);
    const tEnd = wait + RUN + 1.4;
    const endLag = burn ? 0 : atSleep;
    pts.push([tEnd, endLag]);

    const X0 = 60;
    const X1 = 530;
    const Y0 = 40;
    const Y1 = 180;
    const LMAX = 0.3;
    const x = (t: number) => X0 + (t / tEnd) * (X1 - X0);
    const y = (l: number) => Y0 + ((LMAX - l) / (2 * LMAX)) * (Y1 - Y0);
    const line = pts.map(([t, l]) => `${x(t).toFixed(1)},${y(l).toFixed(1)}`).join(' ');
    const band = (t0: number, t1: number, cls: string, txt: string) =>
      t1 - t0 < 1e-9
        ? ''
        : `<rect class="dg-box ${cls}" x="${x(t0)}" y="${Y1 + 14}" width="${Math.max(2, x(t1) - x(t0))}" height="14"/>
           <text class="dg-s" x="${(x(t0) + x(t1)) / 2}" y="${Y1 + 44}" text-anchor="middle">${txt}</text>`;
    const yTicks = [0.2, 0, -0.2]
      .map((l) => `<line class="dg-grid" x1="${X0}" x2="${X1}" y1="${y(l)}" y2="${y(l)}"/><text class="dg-s" x="${X0 - 6}" y="${y(l) + 4}" text-anchor="end">${l > 0 ? '+' : l < 0 ? '−' : ''}${Math.abs(l).toFixed(1)}</text>`)
      .join('');
    svgBox.innerHTML = `<svg viewBox="0 0 640 236" role="img" aria-label="audio 一個週期內的 lag">
      <rect class="dg-elig" x="${X0}" y="${y(LMAX)}" width="${X1 - X0}" height="${y(0) - y(LMAX)}"/>
      <text class="dg-s" x="${X0 + 6}" y="${y(LMAX) + 13}">eligible（lag ≥ 0）</text>
      ${yTicks}
      <text class="dg-s" x="${X0 - 50}" y="${Y0 - 14}">audio 的 lag（ms）</text>
      <line class="dg-axis" x1="${X0}" x2="${X0}" y1="${Y0}" y2="${Y1}"/>
      <polyline class="dg-lag s1" points="${line}"/>
      <circle class="dg-dot s1" cx="${x(0)}" cy="${y(wakeLag)}" r="4"/>
      <text class="dg-s" x="${x(0) + 6}" y="${y(wakeLag) + (wakeLag < 0 ? 16 : -8)}">醒來</text>
      ${band(0, wait, 'wait', wait ? `排隊 ${(wait * 1000).toFixed(0)}µs` : '')}
      ${band(wait, wait + RUN, 'run', '跑 0.31ms')}
      ${band(wait + RUN, tEnd, '', burn ? `睡著，前 ${(burn * 1000).toFixed(0)}µs 還留在佇列上` : '睡著，lag 停住')}
      <text class="dg-s" x="${X1 + 6}" y="${y(endLag) + 4}">… 睡到 ${SLEEP}ms</text>
    </svg>`;

    const mark = (ok: boolean) => `<span class="${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'}</span>`;
    conds.innerHTML = [
      [on.PREEMPT_SHORT, '<code>PREEMPT_SHORT</code> 開著'],
      [short, `audio 的 slice 比正在跑的 cc 短（${short ? SHORT : BASE} ${short ? '&lt;' : '='} ${BASE}ms）`],
      [eligible, `audio 醒來時 eligible（lag ${wakeLag >= 0 ? '0' : `−${drop.toFixed(2)}ms`}）`],
    ]
      .map(([ok, t]) => `<li>${mark(ok as boolean)} ${t}</li>`)
      .join('');

    out.textContent = preempt
      ? '三個條件都成立：audio 一醒來就取消 cc「跑完這個 slice」的保護，馬上上 CPU。它睡前多拿的那 0.21ms，在剛睡著的那段時間已經還清了。'
      : !eligible
        ? `audio 帶著 −${drop.toFixed(2)}ms 的 lag 醒來，還不 eligible，slice 再短也選不到它。只能等其他 task 跑，lag 以 1/3 的速度爬回 0，要 ${(wait * 1000).toFixed(0)}µs。`
        : `audio 醒來時 eligible，但${!short ? ' slice 和 cc 一樣長，deadline 不會比較早' : '沒有 PREEMPT_SHORT，cc 的 RUN_TO_PARITY 保護擋著'}，得等 cc 把這次的 slice 跑完。`;
    tally.textContent = `模擬核心跑情境 4 兩秒（EEVDF v6.12，其他開關預設）：audio 平均喚醒延遲 ${m.avg.toFixed(0)}µs，p99 ${m.p99.toFixed(0)}µs，CPU 比例 ${(m.share * 100).toFixed(2)}%（公平的份 5.49%），context switch ${m.nr} 次。`;
  };
  render();
}

export function mountEevdfWidgets(): void {
  const a = document.getElementById('w-v612');
  if (a) sliceWidget(a);
}
