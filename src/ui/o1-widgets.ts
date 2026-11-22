// 學習路線 O(1) 兩章的互動小圖：prio_array 的兩輪（active / expired），以及 sleep_avg 怎麼被睡眠推高。
// 玩具模型，不經過模擬核心；常數照 2.6.0 kernel/sched.c（HZ = 1000，nice 0），簡化之處寫在圖下方。
import { gap, tr } from '../i18n.ts';
import { tex } from './math.ts';

const SLICE = 102; // BASE_TIMESLICE(nice 0)，ms
const MAX_SLEEP_AVG = 1020; // AVG_TIMESLICE × MAX_BONUS，ms
const MAX_BONUS = 10;
const STARVATION_LIMIT = MAX_SLEEP_AVG;

/** CURRENT_BONUS(p)：NS_TO_JIFFIES(sleep_avg) × MAX_BONUS / MAX_SLEEP_AVG，整數除法 */
const currentBonus = (sleepAvg: number) => Math.floor((Math.floor(sleepAvg) * MAX_BONUS) / MAX_SLEEP_AVG);

// ---------------------------------------------------------------------------
// prio_array：這一輪（active）與下一輪（expired）

type Arr = 'active' | 'expired';
interface Toy {
  name: string;
  prio: number;
  arr: Arr;
  ran: number;
}

function arraysWidget(box: HTMLElement): void {
  const LEVELS = [118, 125];
  let tasks: Toy[];
  let queue: Record<Arr, Record<number, number[]>>; // prio → task 的索引，FIFO
  let now: number;
  let expiredTs: number; // rq->expired_timestamp，0 表示 expired 是空的
  let cInteractive: boolean;
  let last: string;

  const reset = () => {
    cInteractive = false;
    tasks = [
      { name: 'A', prio: 125, arr: 'active', ran: 0 },
      { name: 'B', prio: 125, arr: 'active', ran: 0 },
      { name: 'C', prio: 125, arr: 'active', ran: 0 },
    ];
    queue = { active: { 118: [], 125: [0, 1, 2] }, expired: { 118: [], 125: [] } };
    now = 0;
    expiredTs = 0;
    last = tr(
      '三個 task 都是一直有事做的 CPU-bound task，nice 0，時間片各 102ms。按「跑一個時間片」開始。',
      'All three are CPU-bound tasks that always have work to do, nice 0, with a 102ms time slice each. Press "Run one time slice" to start.',
    );
  };
  reset();

  const nrActive = (a: Arr) => LEVELS.reduce((n, p) => n + queue[a][p]!.length, 0);
  /** sched_find_first_bit()：bitmap 裡第一個是 1 的位置，也就是最優先的那一級 */
  const firstBit = (a: Arr) => LEVELS.find((p) => queue[a][p]!.length > 0);
  const starving = () => expiredTs > 0 && now - expiredTs >= STARVATION_LIMIT * tasks.length + 1;
  const limit = STARVATION_LIMIT * 3 + 1;

  const setInteractive = (on: boolean) => {
    cInteractive = on;
    const c = tasks[2]!;
    const q = queue[c.arr];
    q[c.prio] = q[c.prio]!.filter((i) => i !== 2);
    c.prio = on ? 118 : 125;
    q[c.prio]!.push(2);
  };

  /** 跑一個時間片；回傳說明 */
  const step = (): string => {
    const notes: string[] = [];
    if (nrActive('active') === 0) {
      // schedule()：active 空了就把兩個指標對調
      [queue.active, queue.expired] = [queue.expired, queue.active];
      for (const t of tasks) t.arr = t.arr === 'active' ? 'expired' : 'active';
      expiredTs = 0;
      notes.push(tr('這一輪空了，兩個 prio_array 的指標對調，下一輪變成這一輪。', 'This round is empty, so the two prio_array pointers are swapped and the next round becomes this round. '));
    }
    const p = firstBit('active')!;
    const i = queue.active[p]!.shift()!;
    const t = tasks[i]!;
    now += SLICE;
    t.ran += SLICE;
    // scheduler_tick()：時間片用完
    if (!expiredTs) expiredTs = now;
    const inter = i === 2 && cInteractive;
    if (!inter || starving()) {
      t.arr = 'expired';
      queue.expired[t.prio]!.push(i);
      notes.push(
        inter
          ? tr(
              `${t.name} 是 interactive，但從第一個 task 用完時間片算起已經過了 ${now - expiredTs}ms，超過 ${limit}ms（STARVATION_LIMIT × 3 個 task），EXPIRED_STARVING 成立，這次它也得去下一輪。`,
              `${t.name} is interactive, but ${now - expiredTs}ms have passed since the first task used up its time slice, more than ${limit}ms (STARVATION_LIMIT × 3 tasks). EXPIRED_STARVING holds, so this time it has to go to the next round too.`,
            )
          : tr(
              `${t.name} 跑完 102ms 的時間片，拿到新的時間片後排到下一輪。`,
              `${t.name} finished its 102ms time slice, got a new one and was put into the next round.`,
            ),
      );
    } else {
      queue.active[t.prio]!.push(i);
      notes.push(
        tr(
          `${t.name} 被判定為 interactive（TASK_INTERACTIVE），跑完時間片後排回這一輪的隊尾，不用等下一輪。`,
          `${t.name} counts as interactive (TASK_INTERACTIVE), so after its time slice it goes back to the tail of this round instead of waiting for the next.`,
        ),
      );
    }
    return tr(`選了 prio ${p} 的 ${t.name}。`, `Picked ${t.name} at prio ${p}. `) + notes.join('');
  };

  box.innerHTML = `<div class="w-btns">
      <button type="button" data-a="1">${tr('跑一個時間片', 'Run one time slice')}</button>
      <button type="button" data-a="10">${tr('跑 10 個', 'Run 10')}</button>
      <button type="button" data-a="30">${tr('跑 30 個', 'Run 30')}</button>
      <button type="button" data-a="inter"></button>
      <button type="button" data-a="reset" class="quiet">${tr('重來', 'Reset')}</button>
    </div>
    <div class="w-svg"></div>
    <p class="w-out"></p>
    <p class="w-tally"></p>`;
  const svgBox = box.querySelector<HTMLElement>('.w-svg')!;
  const out = box.querySelector<HTMLElement>('.w-out')!;
  const tally = box.querySelector<HTMLElement>('.w-tally')!;
  const interBtn = box.querySelector<HTMLButtonElement>('[data-a="inter"]')!;

  box.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.a;
    if (!a) return;
    if (a === 'reset') reset();
    else if (a === 'inter') {
      setInteractive(!cInteractive);
      last = cInteractive
        ? tr(
            'C 的 sleep_avg 夠高，bonus +2，prio 從 120 變成 118，被判定為 interactive。它在 prio 118 那一格，比 A、B 的 125 優先。（C 為什麼會有這麼高的 sleep_avg，是下一章的主題，這裡先直接給它。）',
            'C\'s sleep_avg is high enough for a bonus of +2, so its prio goes from 120 to 118 and it counts as interactive. It sits at prio 118, ahead of A and B at 125. (Why C would have such a high sleep_avg is the topic of the next chapter; here it is simply given.)',
          )
        : tr('C 回到 bonus −5、prio 125，和 A、B 一樣。', 'C is back at bonus −5 and prio 125, the same as A and B.');
    } else {
      const n = Number(a);
      const msgs = Array.from({ length: n }, step);
      last = n === 1 ? msgs[0]! : tr(`跑了 ${n} 個時間片（${n * SLICE}ms）。最後一次：${msgs[n - 1]}`, `Ran ${n} time slices (${n * SLICE}ms). The last one: ${msgs[n - 1]}`);
    }
    render();
  });

  const render = () => {
    interBtn.textContent = cInteractive ? tr('讓 C 回到普通的 task', 'Make C a normal task again') : tr('讓 C 被判定為 interactive', 'Make C interactive');
    const next = nrActive('active') ? ['active', firstBit('active')] : ['expired', firstBit('expired')];
    const nextIdx = next[1] !== undefined ? queue[next[0] as Arr][next[1] as number]![0] : undefined;
    const panel = (a: Arr, x0: number, title: string) => {
      const rows = LEVELS.map((p, r) => {
        const y = 52 + r * 44;
        const ids = queue[a][p]!;
        const bit = ids.length ? 1 : 0;
        const chips = ids
          .map((i, k) => {
            const cx = x0 + 120 + k * 40;
            const ring = i === nextIdx && a === next[0] && k === 0 ? `<rect class="o1-ring" x="${cx - 3}" y="${y - 16}" width="38" height="30" rx="6"/>` : '';
            return `${ring}<rect class="o1-chip s${i + 1}" x="${cx}" y="${y - 13}" width="32" height="24" rx="4"/><text class="o1-chip-t" x="${cx + 16}" y="${y + 4}" text-anchor="middle">${tasks[i]!.name}</text>`;
          })
          .join('');
        return `<text class="dg-n" x="${x0 + 8}" y="${y + 4}">prio ${p}</text>
          <rect class="o1-bit${bit ? ' on' : ''}" x="${x0 + 74}" y="${y - 12}" width="22" height="22" rx="3"/>
          <text class="o1-bit-t${bit ? ' on' : ''}" x="${x0 + 85}" y="${y + 4}" text-anchor="middle">${bit}</text>
          <line class="dg-grid" x1="${x0 + 108}" x2="${x0 + 290}" y1="${y + 16}" y2="${y + 16}"/>${chips}`;
      }).join('');
      return `<rect class="o1-panel${a === 'active' ? ' cur' : ''}" x="${x0}" y="4" width="300" height="138" rx="8"/>
        <text class="dg-t" x="${x0 + 12}" y="24">${title}</text>
        <text class="dg-s" x="${x0 + 74}" y="38">bitmap</text>${rows}`;
    };
    svgBox.innerHTML = `<svg viewBox="0 0 640 148" role="img" aria-label="${tr('O(1) 的兩個 prio_array', 'The two prio_arrays of O(1)')}">
      ${panel('active', 6, tr('這一輪（active）', 'This round (active)'))}${panel('expired', 334, tr('下一輪（expired）', 'Next round (expired)'))}
    </svg>`;
    out.textContent = last;
    const total = tasks.reduce((s, t) => s + t.ran, 0);
    // expired_timestamp 在第一個 task 用完時間片時開始計時（即使它被排回這一輪），對調時歸零
    const wait = expiredTs ? gap + tr(`EXPIRED_STARVING 的計時：${now - expiredTs} / ${limit}ms`, `EXPIRED_STARVING timer: ${now - expiredTs} / ${limit}ms`) : '';
    const pct = (t: Toy) => ((t.ran / total) * 100).toFixed(0);
    tally.textContent = total
      ? tr(`經過 ${now}ms，累計執行：`, `After ${now}ms, total run time: `) +
        tasks.map((t) => `${t.name} ${t.ran}ms${tr(`（${pct(t)}%）`, ` (${pct(t)}%)`)}`).join(gap) +
        wait
      : '';
  };
  render();
}

// ---------------------------------------------------------------------------
// sleep_avg：跑 r、睡 s，重複 3 秒

const PRESETS = [
  { label: tr('編輯器：跑 1.3、睡 8.73', 'editor: run 1.3, sleep 8.73'), r: 1.3, s: 8.73 },
  { label: tr('cheat：跑 2.3、睡 0.83', 'cheat: run 2.3, sleep 0.83'), r: 2.3, s: 0.83 },
  { label: tr('跑 3、睡 0.8', 'run 3, sleep 0.8'), r: 3, s: 0.8 },
];
const DURATION = 3000;

function sleepAvgWidget(box: HTMLElement): void {
  let r = 2.3;
  let s = 0.83;

  box.innerHTML = `<div class="w-btns">${PRESETS.map((p, i) => `<button type="button" data-p="${i}">${p.label}</button>`).join('')}</div>
    <div class="w-sliders">
      <label class="w-slice s1">${tr('每次跑', 'run each time')} <input type="range" min="0.1" max="10" step="0.01" data-k="r" aria-label="${tr('每次跑多久', 'how long each run lasts')}"><output></output></label>
      <label class="w-slice s2">${tr('每次睡', 'sleep each time')} <input type="range" min="0.1" max="10" step="0.01" data-k="s" aria-label="${tr('每次睡多久', 'how long each sleep lasts')}"><output></output></label>
    </div>
    <div class="w-svg"></div>
    <div class="w-eq"></div>
    <p class="w-out"></p>`;
  const svgBox = box.querySelector<HTMLElement>('.w-svg')!;
  const eq = box.querySelector<HTMLElement>('.w-eq')!;
  const out = box.querySelector<HTMLElement>('.w-out')!;
  const inputs = [...box.querySelectorAll<HTMLInputElement>('input')];
  for (const inp of inputs)
    inp.addEventListener('input', () => {
      if (inp.dataset.k === 'r') r = Number(inp.value);
      else s = Number(inp.value);
      render();
    });
  box.addEventListener('click', (e) => {
    const p = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.p;
    if (p === undefined) return;
    ({ r, s } = PRESETS[Number(p)]!);
    render();
  });

  /** 從 sleep_avg = 0（一直在跑的 task）開始，跑 r、睡 s 重複；回傳 (t, sleep_avg) 的折線點 */
  const simulate = () => {
    let sa = 0;
    let t = 0;
    const pts: [number, number][] = [[0, 0]];
    const tail: number[] = []; // 最後一秒的 CURRENT_BONUS
    while (t < DURATION) {
      // schedule()：prev->sleep_avg -= run_time
      t += r;
      sa = Math.max(0, sa - r);
      pts.push([t, sa]);
      if (t > DURATION - 1000) tail.push(currentBonus(sa));
      // recalc_task_prio()：睡越少的（CURRENT_BONUS 越低）乘越多
      const mult = MAX_BONUS - currentBonus(sa) || 1;
      t += s;
      sa = Math.min(MAX_SLEEP_AVG, sa + s * mult);
      pts.push([t, sa]);
      if (t > DURATION - 1000) tail.push(currentBonus(sa));
    }
    return { pts, lo: Math.min(...tail), hi: Math.max(...tail) };
  };

  const render = () => {
    inputs[0]!.value = String(r);
    inputs[1]!.value = String(s);
    inputs[0]!.nextElementSibling!.textContent = `${r.toFixed(2)}ms`;
    inputs[1]!.nextElementSibling!.textContent = `${s.toFixed(2)}ms`;
    const { pts, lo, hi } = simulate();

    const X0 = 64;
    const X1 = 600;
    const Y0 = 206;
    const Y1 = 24;
    const x = (t: number) => X0 + (Math.min(t, DURATION) / DURATION) * (X1 - X0);
    const y = (v: number) => Y0 - (v / MAX_SLEEP_AVG) * (Y0 - Y1);
    // 折線點太多時抽樣：每個像素留一個點
    const step = Math.max(1, Math.floor(pts.length / 1200));
    const line = pts
      .filter((_, i) => i % step === 0 || i === pts.length - 1)
      .map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`)
      .join(' ');
    // CURRENT_BONUS 7 從 sleep_avg 714ms 開始（⌈7 × 1020 / 10⌉）
    const th = Math.ceil((7 * MAX_SLEEP_AVG) / MAX_BONUS);
    const bands = [0, 3, 5, 7, 10]
      .map((b) => {
        const v = Math.ceil((b * MAX_SLEEP_AVG) / MAX_BONUS);
        const lab = b - 5 > 0 ? `+${b - 5}` : b - 5 < 0 ? `−${5 - b}` : '0';
        return `<line class="dg-grid" x1="${X0}" x2="${X1}" y1="${y(v)}" y2="${y(v)}"/>
          <text class="dg-s" x="${X0 - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>
          <text class="dg-s" x="${X1 + 6}" y="${y(v) + 4}">${lab}</text>`;
      })
      .join('');
    const ticks = [0, 1000, 2000, 3000]
      .map((t) => `<text class="dg-s" x="${x(t)}" y="${Y0 + 16}" text-anchor="middle">${t / 1000}${tr(' 秒', 's')}</text>`)
      .join('');
    svgBox.innerHTML = `<svg viewBox="0 0 640 228" role="img" aria-label="${tr('sleep_avg 隨時間的變化', 'sleep_avg over time')}">
      <rect class="dg-elig" x="${X0}" y="${y(MAX_SLEEP_AVG)}" width="${X1 - X0}" height="${y(th) - y(MAX_SLEEP_AVG)}"/>
      <text class="dg-s" x="${X0 + 6}" y="${y(MAX_SLEEP_AVG) + 13}">${tr('interactive（nice 0：bonus ≥ +2）', 'interactive (nice 0: bonus ≥ +2)')}</text>
      ${bands}
      <text class="dg-s" x="${X0 - 40}" y="${Y1 - 10}" text-anchor="start">sleep_avg</text>
      <text class="dg-s" x="${X1 + 6}" y="${Y1 - 10}">bonus</text>
      <line class="dg-axis" x1="${X0}" x2="${X1}" y1="${Y0}" y2="${Y0}"/>
      <polyline class="dg-lag s1" points="${line}"/>
      ${ticks}
    </svg>`;

    const use = r / (r + s);
    const bStar = MAX_BONUS - r / s;
    eq.innerHTML = tex(
      `s\\,(10 - b) = r \\;\\Longrightarrow\\; b = 10 - \\frac{r}{s} = 10 - \\frac{${r.toFixed(2)}}{${s.toFixed(2)}} \\approx ${bStar.toFixed(2)}`,
    );
    // 最後一秒的範圍：hi 是剛睡醒時（recalc_task_prio() 之後），lo 是跑完時
    const verdict =
      lo >= 7
        ? tr(
            `剛睡醒時 CURRENT_BONUS ${hi}（bonus ${fmt(hi - 5)}），跑完時 ${lo}（bonus ${fmt(lo - 5)}），一直都在 interactive 的區域：醒來能打斷 bonus 比它低的 task，時間片用完還能留在這一輪。`,
            `CURRENT_BONUS is ${hi} (bonus ${fmt(hi - 5)}) right after waking and ${lo} (bonus ${fmt(lo - 5)}) after running, so it stays in the interactive zone throughout: on waking it can interrupt tasks with a lower bonus, and when its time slice runs out it can stay in this round.`,
          )
        : hi >= 7
          ? tr(
              `剛睡醒時 CURRENT_BONUS ${hi}（bonus ${fmt(hi - 5)}），算 interactive，醒來能打斷一直在跑的 task；跑著跑著掉到 ${lo}（bonus ${fmt(lo - 5)}），時間片多半在這時用完，得去下一輪。`,
              `CURRENT_BONUS is ${hi} (bonus ${fmt(hi - 5)}) right after waking, which counts as interactive, so on waking it can interrupt a task that runs all the time. While running it drops to ${lo} (bonus ${fmt(lo - 5)}), and since the time slice usually runs out then, it has to go to the next round.`,
            )
          : tr(`CURRENT_BONUS 最高只到 ${hi}（bonus ${fmt(hi - 5)}），不算 interactive。`, `CURRENT_BONUS reaches only ${hi} (bonus ${fmt(hi - 5)}) at most, which does not count as interactive.`);
    out.textContent =
      tr(`這個 task 有 ${(use * 100).toFixed(1)}% 的時間在用 CPU。`, `This task uses the CPU ${(use * 100).toFixed(1)}% of the time. `) +
      verdict +
      (lo >= 7 && use >= 0.5 ? tr('它用 CPU 的時間比睡覺多，卻被當成需要快速回應的程式。', ' It spends more time using the CPU than sleeping, yet is treated as a program that needs a fast response.') : '');
  };
  render();
}

const fmt = (b: number) => (b > 0 ? `+${b}` : b < 0 ? `−${-b}` : '0');

export function mountO1Widgets(): void {
  const a = document.getElementById('w-o1arrays');
  if (a) arraysWidget(a);
  const b = document.getElementById('w-sleepavg');
  if (b) sleepAvgWidget(b);
}
