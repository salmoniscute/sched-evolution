// 入門頁的互動小圖：權重、CFS 的 vruntime、EEVDF 的挑選、演進時間軸。
// 這些是教學用的玩具模型，不經過模擬核心；簡化之處寫在圖下方的說明裡。
import { NICE_0_LOAD, prio_to_weight } from '../core/weights.ts';
import { gap, joinList, tr } from '../i18n.ts';
import { tex } from './math.ts';

const NAMES = ['A', 'B', 'C'];
const weightOf = (nice: number) => prio_to_weight[nice + 20]!;
const sign = (x: number, d = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;

function el(html: string): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

// ---------------------------------------------------------------------------
// 權重：拖 nice，看比例

function weightWidget(box: HTMLElement): void {
  const nice = [-5, 0, 5];
  box.innerHTML = `<div class="w-rows"></div><div class="w-eq"></div><p class="w-out"></p>`;
  const rows = box.querySelector<HTMLElement>('.w-rows')!;
  const eq = box.querySelector<HTMLElement>('.w-eq')!;
  const out = box.querySelector<HTMLElement>('.w-out')!;
  const parts = nice.map((n, i) => {
    const row = el(`<div class="w-row s${i + 1}">
      <span class="w-name">${NAMES[i]}</span>
      <label class="w-nice">nice <input type="range" min="-20" max="19" step="1" value="${n}" aria-label="${tr(`${NAMES[i]} 的 nice`, `nice of ${NAMES[i]}`)}"><output></output></label>
      <span class="w-weight"></span>
      <span class="w-track"><span class="w-bar"></span></span>
      <span class="w-pct"></span>
    </div>`);
    rows.append(row);
    const input = row.querySelector('input')!;
    input.addEventListener('input', () => {
      nice[i] = Number(input.value);
      render();
    });
    return row;
  });
  const render = () => {
    const w = nice.map(weightOf);
    const W = w.reduce((a, b) => a + b, 0);
    parts.forEach((row, i) => {
      row.querySelector('output')!.textContent = String(nice[i]);
      row.querySelector<HTMLElement>('.w-weight')!.textContent = tr(`權重 ${w[i]}`, `weight ${w[i]}`);
      row.querySelector<HTMLElement>('.w-bar')!.style.width = `${(w[i]! / W) * 100}%`;
      row.querySelector<HTMLElement>('.w-pct')!.textContent = `${((w[i]! / W) * 100).toFixed(1)}%`;
    });
    // 代入目前的數字：share_A = w_A / (w_A + w_B + w_C)
    const sum = w.join(' + ');
    eq.innerHTML = w
      .map((wi, i) => tex(`\\text{share}_${NAMES[i]} = \\dfrac{${wi}}{${sum}} = \\dfrac{${wi}}{${W}} \\approx ${((wi / W) * 100).toFixed(1)}\\%`))
      .join('');
    const [hi, lo] = [Math.max(...nice), Math.min(...nice)];
    out.textContent =
      hi === lo
        ? tr('三個 task 的 nice 相同，權重也相同，因此各分到三分之一。', 'All three tasks have the same nice value and therefore the same weight, so each gets a third.')
        : tr(
            `總權重是 ${W}。nice 相差 ${hi - lo} 級，權重就相差 ${(weightOf(lo) / weightOf(hi)).toFixed(1)} 倍，大約是 1.25 的 ${hi - lo} 次方。`,
            `The total weight is ${W}. A nice difference of ${hi - lo} levels means the weights differ by ${(weightOf(lo) / weightOf(hi)).toFixed(1)}×, roughly 1.25 to the power ${hi - lo}.`,
          );
  };
  render();
}

// ---------------------------------------------------------------------------
// CFS：挑 vruntime 最小的；睡醒時放到 min_vruntime − 20ms

const LATENCY = 20; // sysctl_sched_latency，單核 20ms

function cfsWidget(box: HTMLElement): void {
  const nice = [0, 0, 5];
  const w = nice.map(weightOf);
  let v = [0, 0, 0];
  let ran = [0, 0, 0];
  let asleep = false;
  let minV = 0;
  const START = tr('按下「跑 1ms」開始。', 'Press "Run 1ms" to start.');
  let last = START;
  let ghost: number | null = null; // 喚醒前的位置，畫成虛線圈

  box.innerHTML = `<div class="w-btns">
      <button type="button" data-a="1">${tr('跑 1ms', 'Run 1ms')}</button>
      <button type="button" data-a="20">${tr('跑 20ms', 'Run 20ms')}</button>
      <button type="button" data-a="sleep"></button>
      <button type="button" data-a="reset" class="quiet">${tr('重來', 'Reset')}</button>
    </div>
    <div class="w-svg"></div>
    <p class="w-out"></p>
    <p class="w-tally"></p>`;
  const svgBox = box.querySelector<HTMLElement>('.w-svg')!;
  const out = box.querySelector<HTMLElement>('.w-out')!;
  const tally = box.querySelector<HTMLElement>('.w-tally')!;
  const sleepBtn = box.querySelector<HTMLButtonElement>('[data-a="sleep"]')!;

  const runnable = () => [0, 1, 2].filter((i) => !(i === 0 && asleep));
  const updateMin = () => {
    // update_min_vruntime()：只往前走
    minV = Math.max(minV, Math.min(...runnable().map((i) => v[i]!)));
  };
  const step = () => {
    const r = runnable();
    const pick = r.reduce((a, b) => (v[b]! < v[a]! ? b : a));
    v[pick]! += (1 * NICE_0_LOAD) / w[pick]!; // update_curr()：Δt × 1024 / 權重
    ran[pick]! += 1;
    updateMin();
    return pick;
  };

  box.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.a;
    if (!a) return;
    if (a === 'reset') {
      v = [0, 0, 0];
      ran = [0, 0, 0];
      asleep = false;
      minV = 0;
      ghost = null;
      last = START;
    } else if (a === 'sleep') {
      if (!asleep) {
        asleep = true;
        ghost = null;
        last = tr(
          'A 進入 sleep 了，它的 vruntime 停在原地，B 和 C 則繼續往前。多按幾次「跑 20ms」之後再喚醒它。',
          'A has gone to sleep. Its vruntime stays where it is while B and C keep moving forward. Press "Run 20ms" a few times, then wake it up.',
        );
      } else {
        asleep = false;
        const floor = minV - LATENCY;
        const before = v[0]!;
        // place_entity()：vruntime = max(原本的, min_vruntime − sched_latency)
        v[0] = Math.max(before, floor);
        ghost = v[0] !== before ? before : null;
        last =
          v[0] !== before
            ? tr(
                `A 被喚醒時落後 min_vruntime ${(minV - before).toFixed(1)}ms，若照規則直接挑最小的，它會一口氣執行這麼久。因此 place_entity() 把它拉到 min_vruntime − 20ms 的位置，接下來它會先連續執行一段，這就是喚醒補償。`,
                `When A wakes up it is ${(minV - before).toFixed(1)}ms behind min_vruntime. If the rule simply picked the smallest, A would run that long in one go. So place_entity() pulls it up to min_vruntime − 20ms; A will still run for a while first, and that is the wakeup bonus.`,
              )
            : tr(
                `A 只睡了一下，vruntime 本來就在 min_vruntime − 20ms 的右邊，place_entity() 取兩者較大的值，所以位置不變。`,
                `A only slept briefly, so its vruntime is already to the right of min_vruntime − 20ms. place_entity() takes the larger of the two, so A stays where it is.`,
              );
      }
    } else {
      const n = Number(a);
      const picks = Array.from({ length: n }, step);
      const counts = [0, 1, 2].map((i) => picks.filter((p) => p === i).length).map((c, i) => (c ? `${NAMES[i]} ${c}ms` : '')).filter(Boolean);
      last =
        n === 1
          ? tr(
              `${NAMES[picks[0]!]} 的 vruntime 最小，所以選它。執行 1ms 後，它的 vruntime 增加 ${(NICE_0_LOAD / w[picks[0]!]!).toFixed(2)}ms。`,
              `${NAMES[picks[0]!]} has the smallest vruntime, so it is picked. After running 1ms, its vruntime grows by ${(NICE_0_LOAD / w[picks[0]!]!).toFixed(2)}ms.`,
            )
          : tr(`這 ${n}ms 內各 task 執行的時間：${joinList(counts)}。`, `Time each task ran in these ${n}ms: ${joinList(counts)}.`);
      ghost = null;
    }
    render();
  });

  const render = () => {
    sleepBtn.textContent = asleep ? tr('叫醒 A', 'Wake A') : tr('讓 A 去睡', 'Put A to sleep');
    // 數線：以 min_vruntime 為準，左 30ms、右 15ms
    const lo = minV - 30;
    const hi = minV + 15;
    const X0 = 96;
    const X1 = 620;
    const x = (t: number) => X0 + ((Math.min(Math.max(t, lo), hi) - lo) / (hi - lo)) * (X1 - X0);
    const cand = Math.min(...runnable().map((i) => v[i]!));
    const rows = [0, 1, 2]
      .map((i) => {
        const y = 26 + i * 26;
        const off = v[i]! < lo;
        const sleeping = i === 0 && asleep;
        const label = `${NAMES[i]}${nice[i] ? tr(`（nice ${nice[i]}）`, ` (nice ${nice[i]})`) : ''}`;
        const dot = sleeping
          ? `<circle class="dg-hollow s${i + 1}" cx="${x(v[i]!)}" cy="${y}" r="5"/>`
          : `<circle class="dg-dot s${i + 1}" cx="${x(v[i]!)}" cy="${y}" r="5.5"/>`;
        const g =
          i === 0 && ghost !== null
            ? ghost < lo
              ? `<text class="dg-s" x="${X0 + 4}" y="${y - 8}">${tr(`← 原本落後 ${(minV - ghost).toFixed(0)}ms`, `← was ${(minV - ghost).toFixed(0)}ms behind`)}</text>`
              : `<circle class="dg-ghost s1" cx="${x(ghost)}" cy="${y}" r="5"/>`
            : '';
        const note = off ? `<text class="dg-s" x="${X0 + 10}" y="${y + 4}">${tr(`← 落後 ${(minV - v[i]!).toFixed(0)}ms`, `← ${(minV - v[i]!).toFixed(0)}ms behind`)}</text>` : '';
        const zz = sleeping ? `<text class="dg-s" x="${x(v[i]!) + 10}" y="${y + 4}">${tr('睡覺中', 'asleep')}</text>` : '';
        const next = !sleeping && v[i] === cand ? `<circle class="dg-ring" cx="${x(v[i]!)}" cy="${y}" r="9"/>` : '';
        return `<text class="dg-n" x="${X0 - 8}" y="${y + 4}" text-anchor="end">${label}</text>${g}${dot}${next}${note}${zz}`;
      })
      .join('');
    const ticks = [-30, -20, -10, 0, 10]
      .map((d) => `<text class="dg-s" x="${x(minV + d)}" y="118" text-anchor="middle">${d === 0 ? 'min_vruntime' : `${d > 0 ? '+' : '−'}${Math.abs(d)}`}</text>`)
      .join('');
    svgBox.innerHTML = `<svg viewBox="0 0 640 126" role="img" aria-label="${tr('三個程式的 vruntime', 'vruntime of three tasks')}">
      <rect class="dg-comp" x="${x(minV - LATENCY)}" y="10" width="${x(minV) - x(minV - LATENCY)}" height="90"/>
      <text class="dg-s" x="${(x(minV - LATENCY) + x(minV)) / 2}" y="8" text-anchor="middle">${tr('喚醒補償 20ms', 'wakeup bonus 20ms')}</text>
      <line class="dg-axis" x1="${X0}" x2="${X1}" y1="104" y2="104"/>
      <line class="dg-ref" x1="${x(minV)}" x2="${x(minV)}" y1="10" y2="104"/>
      ${rows}${ticks}
    </svg>`;
    out.textContent = last;
    const total = ran.reduce((a, b) => a + b, 0);
    tally.textContent = total
      ? tr('目前累計執行：', 'Total run time so far: ') +
        ran.map((r, i) => `${NAMES[i]} ${r}ms${tr(`（${((r / total) * 100).toFixed(0)}%）`, ` (${((r / total) * 100).toFixed(0)}%)`)}`).join(gap)
      : '';
  };
  render();
}

// ---------------------------------------------------------------------------
// EEVDF：eligible 中挑 deadline 最早的

function eevdfWidget(box: HTMLElement): void {
  const init = () => ({ v: [-0.3, 0.35, -0.05], slice: [0.75, 0.75, 0.3], ran: [0, 0, 0] });
  let s = init();
  let last = '';

  box.innerHTML = `<div class="w-sliders"></div>
    <div class="w-svg"></div>
    <p class="w-out"></p>
    <div class="w-btns">
      <button type="button" data-a="run">${tr('讓被選中的跑完它的 slice', 'Let the picked task run its slice')}</button>
      <button type="button" data-a="reset" class="quiet">${tr('重來', 'Reset')}</button>
    </div>
    <p class="w-tally"></p>`;
  const sliders = box.querySelector<HTMLElement>('.w-sliders')!;
  const svgBox = box.querySelector<HTMLElement>('.w-svg')!;
  const out = box.querySelector<HTMLElement>('.w-out')!;
  const tally = box.querySelector<HTMLElement>('.w-tally')!;
  const inputs = NAMES.map((nm, i) => {
    const lab = el(`<label class="w-slice s${i + 1}"><span class="w-name">${nm}</span> slice
      <input type="range" min="0.1" max="1.5" step="0.05" aria-label="${tr(`${nm} 的 slice`, `slice of ${nm}`)}"><output></output></label>`);
    sliders.append(lab);
    const input = lab.querySelector('input')!;
    input.addEventListener('input', () => {
      s.slice[i] = Number(input.value);
      last = '';
      render();
    });
    return input;
  });

  // 三個都是 nice 0，V 就是 vruntime 的平均（avg_vruntime()）
  const V = () => s.v.reduce((a, b) => a + b, 0) / s.v.length;
  const dl = (i: number) => s.v[i]! + s.slice[i]!;
  const pick = () => {
    const vv = V();
    const elig = [0, 1, 2].filter((i) => s.v[i]! <= vv + 1e-9);
    return elig.reduce((a, b) => (dl(b) < dl(a) ? b : a));
  };

  box.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.a;
    if (a === 'reset') {
      s = init();
      last = '';
    } else if (a === 'run') {
      const p = pick();
      s.v[p]! += s.slice[p]!; // nice 0：跑多久 vruntime 就加多少
      s.ran[p]! += s.slice[p]!;
      last = tr(
        `${NAMES[p]} 執行了 ${s.slice[p]!.toFixed(2)}ms，vruntime 往右移了這麼多，但 V 是三者的平均，只移動三分之一。`,
        `${NAMES[p]} ran for ${s.slice[p]!.toFixed(2)}ms and its vruntime moved right by that much, but V is the average of all three, so it moved only a third as far.`,
      );
    }
    render();
  });

  const render = () => {
    inputs.forEach((inp, i) => {
      inp.value = String(s.slice[i]);
      inp.nextElementSibling!.textContent = `${s.slice[i]!.toFixed(2)}ms`;
    });
    const vv = V();
    const p = pick();
    const rel = (t: number) => t - vv;
    const lo = -1.5;
    const hi = 2.5;
    const X0 = 60;
    const X1 = 620;
    const x = (t: number) => X0 + ((Math.min(Math.max(rel(t), lo), hi) - lo) / (hi - lo)) * (X1 - X0);
    const rows = [0, 1, 2]
      .map((i) => {
        const y = 30 + i * 26;
        const elig = s.v[i]! <= vv + 1e-9;
        const f = elig ? '' : ' faint';
        const dot = elig
          ? `<circle class="dg-dot s${i + 1}" cx="${x(s.v[i]!)}" cy="${y}" r="5"/>`
          : `<circle class="dg-hollow s${i + 1}" cx="${x(s.v[i]!)}" cy="${y}" r="4"/>`;
        const ring = i === p ? `<circle class="dg-ring" cx="${x(s.v[i]!)}" cy="${y}" r="8.5"/>` : '';
        return `<text class="dg-n${i === p ? ' picked' : ''}" x="${X0 - 8}" y="${y + 4}" text-anchor="end">${i === p ? '▶ ' : ''}${NAMES[i]}</text>
          <line class="dg-seg s${i + 1}${f}" x1="${x(s.v[i]!)}" x2="${x(dl(i))}" y1="${y}" y2="${y}"/>
          <line class="dg-dl s${i + 1}${f}" x1="${x(dl(i))}" x2="${x(dl(i))}" y1="${y - 6}" y2="${y + 6}"/>${dot}${ring}`;
      })
      .join('');
    const ticks = [-1, -0.5, 0.5, 1, 1.5, 2]
      .map((d) => `<text class="dg-s" x="${x(vv + d)}" y="126" text-anchor="middle">${sign(d, 1)}</text>`)
      .join('');
    svgBox.innerHTML = `<svg viewBox="0 0 640 134" role="img" aria-label="${tr('EEVDF 挑選', 'EEVDF pick')}">
      <rect class="dg-elig" x="${X0}" y="14" width="${x(vv) - X0}" height="88"/>
      <line class="dg-ref" x1="${x(vv)}" x2="${x(vv)}" y1="10" y2="110"/>
      <line class="dg-axis" x1="${X0}" x2="${X1}" y1="110" y2="110"/>
      <text class="dg-s" x="${x(vv)}" y="126" text-anchor="middle">V</text>
      <text class="dg-s" x="${X0 + 4}" y="10">${tr('eligible（lag ≥ 0）', 'eligible (lag ≥ 0)')}</text>
      ${rows}${ticks}
    </svg>`;
    const elig = [0, 1, 2].filter((i) => s.v[i]! <= vv + 1e-9);
    const nope = [0, 1, 2].filter((i) => !elig.includes(i));
    const why =
      elig.length > 1
        ? tr(
            `目前 eligible 的是 ${joinList(elig.map((i) => NAMES[i]!))}，其中 ${NAMES[p]} 的 deadline（${sign(rel(dl(p)))}）最早，因此選 ${NAMES[p]}。`,
            `Eligible right now: ${joinList(elig.map((i) => NAMES[i]!))}. Of these, ${NAMES[p]} has the earliest deadline (${sign(rel(dl(p)))}), so ${NAMES[p]} is picked.`,
          )
        : tr(`只有 ${NAMES[p]} 是 eligible，只能選它。`, `Only ${NAMES[p]} is eligible, so it has to be picked.`);
    const names = joinList(nope.map((i) => NAMES[i]!));
    const no = nope.length
      ? tr(
          `${names} 落在 V 右邊，代表已經多拿了，不論 slice 多短都不能被選。`,
          `${names} ${nope.length > 1 ? 'are' : 'is'} to the right of V, meaning ${nope.length > 1 ? 'they have' : 'it has'} already received more than ${nope.length > 1 ? 'their' : 'its'} share and cannot be picked, however short the slice.`,
        )
      : '';
    out.textContent = [last, why, no].filter(Boolean).join(' ');
    const total = s.ran.reduce((a, b) => a + b, 0);
    tally.textContent = total ? tr('目前累計執行：', 'Total run time so far: ') + s.ran.map((r, i) => `${NAMES[i]} ${r.toFixed(2)}ms`).join(gap) : '';
  };
  render();
}

// ---------------------------------------------------------------------------
// 演進時間軸

interface Era {
  year: string;
  name: string;
  tag?: string;
  body: string;
}

const SIM = tr('模擬頁可以比較', 'on the Simulate page');
const ERAS: Era[] = [
  {
    year: '2001',
    name: '2.4 O(n)',
    tag: SIM,
    body: tr(
      '每次排程都把 runqueue 上所有 task 掃過一遍，用 <code>goodness()</code> 算出分數並挑最高的；所有 task 的 time slice 都用完後再一起重新計算。也就是說，task 越多，每次挑選的成本就越高。',
      'Every scheduling decision scans all tasks on the runqueue, scores each with <code>goodness()</code> and picks the highest. Once every task has used up its time slice, all slices are recalculated together. In other words, the more tasks there are, the more each pick costs.',
    ),
  },
  {
    year: '2003',
    name: '2.6.0 O(1)',
    tag: SIM,
    body: tr(
      '為了解決 O(n) 的問題，每個優先級（共 140 個）各有一條佇列，再搭配一個 bitmap，找出下一個 task 只需要常數時間。它用 <code>sleep_avg</code> 推測哪些 task 是 interactive 並給予加分，但刻意製造的短暫 sleep 就能騙過這套 heuristics，規則也越補越複雜。',
      'To fix the O(n) problem, each of the 140 priority levels gets its own queue, and with a bitmap the next task can be found in constant time. It uses <code>sleep_avg</code> to guess which tasks are interactive and gives them a bonus, but deliberate short sleeps are enough to fool these heuristics, and the rules grew more complicated with every patch.',
    ),
  },
  {
    year: '2007',
    name: tr('2.6.23 CFS 初版', '2.6.23 first CFS'),
    tag: tr('只在說明中提', 'described only'),
    body: tr(
      'CFS 不再猜測誰是 interactive，改為依權重分配 CPU，並直接記錄每個 task 的 <code>wait_runtime</code>，也就是「應得 − 實得」，相當於 lag。',
      'CFS stops guessing who is interactive. It divides the CPU by weight instead, and records each task\'s <code>wait_runtime</code> directly: "entitled − received", which amounts to lag.',
    ),
  },
  {
    year: '2008',
    name: '2.6.24 CFS',
    tag: SIM,
    body: tr(
      '改為記錄 vruntime，也就是只記「跑了多少」，再挑最小的。如此一來 lag 不再明確存在，被喚醒的 task 則靠喚醒補償照顧。',
      'It switches to recording vruntime, that is, only "how much it has run", and picks the smallest. Lag no longer exists explicitly, and tasks that wake up are looked after by a wakeup bonus.',
    ),
  },
  {
    year: '2023',
    name: '6.6 EEVDF',
    tag: SIM,
    body: tr(
      'EEVDF 把 lag 正式帶回來，加上 eligible 與 deadline 兩個概念，演算法出自 1995 年 Stoica 等人的論文，lag 的上下界有證明。然而 slice 只有一種，task 無法表達自己的延遲需求。',
      'EEVDF formally brings lag back and adds two ideas, eligibility and deadlines. The algorithm comes from a 1995 paper by Stoica et al., with proven bounds on lag. There is only one slice length, though, so a task cannot express its latency needs.',
    ),
  },
  {
    year: '2024',
    name: '6.12',
    tag: SIM,
    body: tr(
      'task 可以透過 <code>sched_attr</code> 指定自己的 slice，再搭配 <code>PREEMPT_SHORT</code> 與 <code>DELAY_DEQUEUE</code>，短 slice 才真正發揮作用。同一版也合併了 sched_ext，讓使用者能用 BPF 撰寫自己的 CPU scheduler（本網站不實作）。',
      'A task can set its own slice through <code>sched_attr</code>, and together with <code>PREEMPT_SHORT</code> and <code>DELAY_DEQUEUE</code> a short slice finally takes effect. The same release merged sched_ext, which lets users write their own CPU scheduler in BPF (not implemented on this site).',
    ),
  },
];

function historyWidget(box: HTMLElement): void {
  let cur = 3;
  box.innerHTML = `<div class="h-line" role="tablist"></div><div class="h-body" role="tabpanel"></div>`;
  const line = box.querySelector<HTMLElement>('.h-line')!;
  const body = box.querySelector<HTMLElement>('.h-body')!;
  const btns = ERAS.map((e, i) => {
    const b = el(`<button type="button" role="tab" class="h-node"><span class="h-year">${e.year}</span><span class="h-name">${e.name}</span></button>`) as HTMLButtonElement;
    b.addEventListener('click', () => {
      cur = i;
      render();
    });
    line.append(b);
    return b;
  });
  const render = () => {
    btns.forEach((b, i) => {
      b.classList.toggle('on', i === cur);
      b.setAttribute('aria-selected', String(i === cur));
    });
    const e = ERAS[cur]!;
    body.innerHTML = `<b>${e.name}</b>${e.tag ? `<span class="tag">${e.tag}</span>` : ''}<p>${e.body}</p>`;
  };
  render();
}

export function mountStartWidgets(): void {
  const mount = (id: string, f: (b: HTMLElement) => void) => {
    const b = document.getElementById(id);
    if (b) f(b);
  };
  mount('w-weight', weightWidget);
  mount('w-cfs', cfsWidget);
  mount('w-eevdf', eevdfWidget);
  mount('w-history', historyWidget);
}
