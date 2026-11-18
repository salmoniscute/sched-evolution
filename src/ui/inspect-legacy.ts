// 決策檢視：O(n) 2.4.0 與 O(1) 2.6.0。和 inspect.ts 一樣只讀引擎拍下的快照。
// 這兩代沒有 vruntime，數線換成「prio_array 的格子」（O(1)）和「goodness 長條」（O(n)）。
import type { SchedEvent } from '../core/engine.ts';
import { NSEC_PER_MSEC as MS, type Ns } from '../core/types.ts';
import type { O1Snapshot, O1TaskView } from '../sched/o1-v2.6.0.ts';
import { goodness, type OnSnapshot, type OnTaskView } from '../sched/on-v2.4.0.ts';
import { term } from './glossary.ts';
import type { Explained, InspectCtx } from './inspect.ts';

const dur = (ns: Ns) => (ns >= MS ? `${+(ns / MS).toFixed(2)}ms` : `${Math.round(ns / 1000)}µs`);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sgn = (x: number) => (x > 0 ? `+${x}` : x < 0 ? `−${-x}` : '0');

function helpers(ctx: InspectCtx, idx: number) {
  const e = ctx.events[idx]!;
  const nm = (pid: number | null) => (pid === null ? 'idle' : (ctx.names[pid - 1] ?? `pid ${pid}`));
  const prevPick = (() => {
    for (let i = idx - 1; i >= 0; i--) if (ctx.events[i]!.kind === 'pick') return ctx.events[i]!;
    return null;
  })();
  const ran = prevPick && e.prev !== null && prevPick.next === e.prev ? e.t - prevPick.t : null;
  const verb = e.cause === 'new' ? '被建立' : '醒來';
  return { e, nm, ran, verb };
}

const pickTitle = (e: SchedEvent, nm: (p: number | null) => string) =>
  e.kind === 'wakeup'
    ? `${nm(e.causePid)} ${e.cause === 'new' ? '被建立' : '醒來'}，${nm(e.next)} 繼續跑`
    : e.prev === e.next
      ? `重新挑選，還是 ${nm(e.next)}`
      : `${nm(e.prev)} → ${nm(e.next)}`;

// ---------------------------------------------------------------------------
// O(1) 2.6.0

function explainO1(ctx: InspectCtx, idx: number): Explained {
  const { e, nm, ran, verb } = helpers(ctx, idx);
  const S = e.snapshot as O1Snapshot;
  const B = e.before as O1Snapshot | null;
  const t = (pid: number | null) => S.tasks.find((x) => x.pid === pid);
  const tick = (n: number) => `${n} 個 tick（${dur(n * S.tick_ns)}）`;
  const prioOf = (x: O1TaskView) => `prio ${x.prio}（static_prio ${x.static_prio}，bonus ${sgn(x.bonus)}）`;
  const on = (k: string) => ctx.flags[k] ?? true;
  const why: string[] = [];
  const title = pickTitle(e, nm);

  if (e.kind === 'wakeup') {
    const w = t(e.causePid);
    const c = t(e.next);
    let plain = `${nm(e.causePid)} ${verb}了，${nm(e.next)} 繼續跑。`;
    if (w && c) {
      plain = `${nm(w.pid)} ${verb}了，但它的優先權沒有比正在跑的 ${nm(c.pid)} 高，先排隊。`;
      why.push(
        `${nm(w.pid)} ${verb}，recalc_task_prio() 把這次睡眠加進 sleep_avg（現在 ${dur(w.sleep_avg)}），算出 ${prioOf(w)}。`,
      );
      const ahead = S.active.slice(0, S.active.indexOf(w.pid)).filter((p) => p !== c.pid);
      why.push(
        `TASK_PREEMPTS_CURR 只比 prio：數字要比 curr 小才搶佔。${nm(c.pid)} 是 prio ${c.prio}，${w.prio === c.prio ? '一樣' : '比較好'}，不搶佔。` +
          `${nm(w.pid)} 排到 active 的 prio ${w.prio} 佇列尾端` +
          (ahead.length ? `，前面還有 ${ahead.map(nm).join('、')}。` : '，等 curr 讓出 CPU。'),
      );
    } else why.push(`${nm(e.causePid)} ${verb}，沒有觸發重新排程。`);
    return { title, plain, why, rows: [], chosen: e.next };
  }

  // ---- 為什麼這時候要重新排程
  const w = t(e.causePid) ?? B?.tasks.find((x) => x.pid === e.causePid);
  const p = t(e.prev);
  let reason = '';
  let plain = '';
  if (e.cause === 'sleep') {
    reason = `${nm(e.causePid)} 做完這一段去睡了，`;
    why.push(`${nm(e.causePid)} 去睡了${ran !== null ? `（這次跑了 ${dur(ran)}）` : ''}，deactivate_task() 把它移出 prio_array，schedule() 要挑下一個。跑掉的時間從 sleep_avg 扣掉。`);
  } else if (e.cause === 'new') {
    reason = `新程式 ${nm(e.causePid)} 加入，`;
    why.push(
      `新程式 ${nm(e.causePid)} 建立。` +
        (w ? `時間片是 parent 剩下的一半（${tick(w.time_slice)}），sleep_avg 從 parent 繼承再打 95 折，得到 ${prioOf(w)}。` : '') +
        'do_fork() 最後一律要求重新排程。',
    );
  } else if (e.cause === 'wakeup') {
    if (e.prev === null) {
      reason = `CPU 閒著，${nm(e.causePid)} 醒來，`;
      why.push(`${nm(e.causePid)} 醒來時 CPU 是閒的，直接重新排程。`);
    } else if (w && p) {
      reason = `${nm(w.pid)} 醒來，它的優先權比 ${nm(p.pid)} 高，`;
      if (e.next === w.pid) plain = `${nm(w.pid)} 醒來，它的優先權（prio ${w.prio}）比 ${nm(p.pid)} 的（${p.prio}）高，直接插隊。`;
      why.push(`${nm(w.pid)} 醒來，recalc_task_prio() 算出 ${prioOf(w)}，比 ${nm(p.pid)} 的 prio ${p.prio} 好，TASK_PREEMPTS_CURR 成立，要求重新排程。`);
    } else {
      reason = `${nm(e.causePid)} 醒來，`;
      why.push(`${nm(e.causePid)} 醒來，觸發重新排程。`);
    }
  } else if (p) {
    const full = tick(p.timeslice_full);
    if (p.array === 'expired') {
      reason = `${nm(p.pid)} 的時間片用完了，被排到下一輪（expired），要等這一輪的程式都用完時間片才輪得到它，`;
      const cause = !on('TASK_INTERACTIVE')
        ? 'TASK_INTERACTIVE 關掉了，用完一律搬到 expired。'
        : p.interactive && S.starving
          ? `它算互動型，但 expired 裡的 task 已經等太久（EXPIRED_STARVING），還是得去 expired。`
          : `它的 prio ${p.prio} 沒有比 static_prio ${p.static_prio} 好 ${p.delta} 以上，不算互動型（TASK_INTERACTIVE），搬到 expired，要等 active 裡的 task 都用完才輪得到。`;
      why.push(`tick 時 scheduler_tick() 把 ${nm(p.pid)} 的 time_slice 扣到 0，時間片（${full}）用完，重新發一份。${cause}`);
    } else if (p.time_slice === p.timeslice_full) {
      reason = `${nm(p.pid)} 的時間片用完了，但 CPU scheduler 認定它是互動型，讓它不必等下一輪，排到這一輪的隊伍尾端，`;
      why.push(
        `tick 時 scheduler_tick() 把 ${nm(p.pid)} 的 time_slice 扣到 0，時間片（${full}）用完，重新發一份。` +
          `它的 prio ${p.prio} 比 static_prio ${p.static_prio} 好 ${p.delta} 以上，算互動型（TASK_INTERACTIVE），放回 active 的佇列尾端，不用去 expired 等。`,
      );
    } else {
      reason = `${nm(p.pid)} 的時間片被切成幾小段，這一段跑完了，讓同優先權的程式先跑，`;
      why.push(
        `${nm(p.pid)} 算互動型，時間片有 ${full}，TIMESLICE_GRANULARITY 把它切成每 ${tick(p.gran)} 一段。` +
          `這一段跑完，排到同一個 prio（${p.prio}）佇列的尾端，讓同優先權的 task 輪流；剩下的 ${tick(p.time_slice)} 還是它的。`,
      );
    }
  } else {
    why.push('tick 時要求重新排程。');
  }

  // ---- 為什麼挑到 next
  const n = t(e.next);
  const swapped = B !== null && S.swaps > B.swaps;
  if (swapped) {
    why.push('active 裡已經沒有 task，把 active 和 expired 兩個指標對調（只是交換指標，O(1)）。剛才在 expired 的 task 拿著新的時間片回到 active。');
  }
  let choice: string;
  if (e.next === null) {
    choice = '沒有程式想跑，CPU 閒著。';
    why.push('沒有程式想跑，CPU 閒置。');
  } else if (!n) {
    choice = `換 ${nm(e.next)}。`;
    why.push(`選中 ${nm(e.next)}。`);
  } else {
    const better = S.tasks.filter((x) => x.array === 'expired' && x.prio < n.prio);
    if (S.tasks.length === 1) {
      choice = `只有 ${nm(n.pid)} 想跑。`;
      why.push(`只有 ${nm(n.pid)} 想跑。`);
    } else {
      choice =
        e.prev === e.next
          ? `重新挑還是 ${nm(n.pid)}，在這一輪還有時間片的程式裡，它的優先權仍是最高的。`
          : swapped
            ? `這一輪的程式都用完時間片了，開始下一輪，換 ${nm(n.pid)}。`
            : `換 ${nm(n.pid)}：在這一輪還有時間片的程式裡，它的優先權最高（prio ${n.prio}）。`;
      why.push(
        `sched_find_first_bit() 在 active 的 bitmap 找第一個 1，是 prio ${n.prio}，取那一條佇列最前面的 ${nm(n.pid)}。` +
          (better.length ? `expired 裡的 ${better.map((x) => nm(x.pid)).join('、')} 優先權更高，但要等 active 用完才輪得到。` : ''),
      );
    }
  }
  if (e.prev === e.next && e.next !== null && S.tasks.length > 1) why.push('重新挑的結果還是同一個，沒有 context switch。');
  if (!plain) plain = reason + choice;
  return { title, plain, why, rows: [], chosen: e.next };
}

/** prio_array 的格子：橫軸是 prio，兩列是 active 和 expired */
function o1Grid(ctx: InspectCtx, S: O1Snapshot, chosen: number | null): string {
  if (!S.tasks.length) return '';
  const prios = S.tasks.flatMap((x) => [x.prio, x.static_prio]);
  let lo = Math.min(...prios) - 1;
  let hi = Math.max(...prios) + 1;
  while (hi - lo < 12) {
    lo--;
    hi++;
  }
  lo = Math.max(100, lo);
  hi = Math.min(139, hi);
  // 每個 task 一列（依 prio、佇列順序），相鄰 prio 的名字才不會疊在一起
  const rowOf = new Map<number, number>();
  for (const arr of ['active', 'expired'] as const) {
    S.tasks
      .filter((x) => x.array === arr)
      .sort((a, b) => a.prio - b.prio || a.pos - b.pos)
      .forEach((x, i) => rowOf.set(x.pid, i));
  }
  const depth = (arr: 'active' | 'expired') => Math.max(1, S.tasks.filter((x) => x.array === arr).length);
  const W = 640;
  const LABEL = 70;
  const R = 12;
  const CELL = (W - LABEL - R) / (hi - lo + 1);
  const LANE = 16;
  const lanes = [
    { arr: 'active' as const, y: 6, h: depth('active') * LANE + 6 },
    { arr: 'expired' as const, y: 0, h: depth('expired') * LANE + 6 },
  ];
  lanes[1]!.y = lanes[0]!.y + lanes[0]!.h + 8;
  const axisY = lanes[1]!.y + lanes[1]!.h + 4;
  const H = axisY + 30;
  const X = (prio: number) => LABEL + (prio - lo + 0.5) * CELL;

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="active 和 expired 兩個 prio_array">`;
  for (const l of lanes) {
    svg += `<text class="nm" x="${LABEL - 8}" y="${l.y + 13}" text-anchor="end">${l.arr}</text>`;
    svg += `<rect class="lane" x="${LABEL}" y="${l.y}" width="${W - LABEL - R}" height="${l.h}" rx="4"/>`;
  }
  for (let pr = lo; pr <= hi; pr++) {
    if (pr % 5 === 0 || pr === lo || pr === hi) {
      svg += `<line class="axis" x1="${X(pr)}" x2="${X(pr)}" y1="${axisY - 3}" y2="${axisY + 3}"/>`;
      svg += `<text class="tl" x="${X(pr)}" y="${axisY + 16}" text-anchor="middle">${pr}</text>`;
    }
  }
  svg += `<line class="axis" x1="${LABEL}" x2="${W - R}" y1="${axisY}" y2="${axisY}"/>`;
  svg += `<text class="tl" x="${W - R}" y="${axisY + 28}" text-anchor="end">prio（數字小 = 優先）</text>`;
  for (const x of S.tasks) {
    const l = lanes.find((q) => q.arr === x.array)!;
    const cy = l.y + 3 + rowOf.get(x.pid)! * LANE + LANE / 2;
    const cx = X(x.prio);
    const col = ctx.color(x.pid - 1);
    // static_prio 的位置：細線連到目前的 prio，看得出 bonus 往哪邊推
    if (x.static_prio !== x.prio) svg += `<line x1="${X(x.static_prio)}" x2="${cx}" y1="${cy}" y2="${cy}" style="stroke:${col}" stroke-width="1.5" stroke-dasharray="2 2" opacity="0.7"/>`;
    svg += `<line x1="${X(x.static_prio)}" x2="${X(x.static_prio)}" y1="${cy - 4}" y2="${cy + 4}" style="stroke:${col}" stroke-width="1.5" opacity="0.7"/>`;
    svg += `<circle cx="${cx}" cy="${cy}" r="5" style="fill:${col}"/>`;
    if (x.pid === chosen) svg += `<circle cx="${cx}" cy="${cy}" r="8.5" class="ring"/>`;
    const name = ctx.names[x.pid - 1] ?? '';
    // 名字放在 static_prio 那條虛線的另一邊
    const left = x.static_prio > x.prio;
    svg += `<text class="nm${x.pid === chosen ? ' picked' : ''}" x="${left ? cx - 11 : cx + 11}" y="${cy + 4}" text-anchor="${left ? 'end' : 'start'}">${esc(name)}</text>`;
  }
  svg += '</svg>';
  const legend =
    '每一欄是一個 prio，active 和 expired 各有一塊，每個 task 一列，同一個 prio 裡由上到下是佇列順序。圓點是目前的 prio，細槓是只看 nice 的 static_prio，兩者的差就是 sleep_avg 給的 bonus。' +
    'sched_find_first_bit() 找 active 裡最左邊有 task 的那一格，取最上面那個（紫圈）。';
  return `<div class="insp-line">${svg}<div class="insp-legend">${legend}</div></div>`;
}

function o1Table(ctx: InspectCtx, S: O1Snapshot, x: Explained, e: SchedEvent): string {
  const state = (r: O1TaskView) => {
    if (r.pid === x.chosen) return e.kind === 'wakeup' || e.prev === e.next ? '繼續跑' : '被選中';
    if (e.kind === 'wakeup' && r.pid === e.causePid) return e.cause === 'new' ? '剛建立，等待' : '剛醒來，等待';
    return '等待';
  };
  const tick = (n: number) => dur(n * S.tick_ns);
  const body = S.tasks
    .map((r) => {
      const name = `<span class="swatch" style="background:${ctx.color(r.pid - 1)}"></span>${esc(ctx.names[r.pid - 1] ?? '')}`;
      return `<tr${r.pid === x.chosen ? ' class="chosen"' : ''}><td>${name}</td><td>${state(r)}</td><td>${r.array}</td><td>${r.prio}（${r.static_prio}）</td><td>${sgn(r.bonus)}</td><td>${dur(r.sleep_avg)}</td><td>${tick(r.time_slice)} / ${tick(r.timeslice_full)}</td><td>${r.interactive ? '是' : '否'}</td></tr>`;
    })
    .join('');
  const head = `<th>程式</th><th>狀態</th><th>${term('陣列', 'active')}</th><th>prio（static_prio）</th><th>${term('bonus')}</th><th>${term('sleep_avg')}</th><th>時間片 剩下 / 全部</th><th>${term('互動型', 'TASK_INTERACTIVE')}</th>`;
  const asleep = ctx.names.filter((_, i) => !S.tasks.some((r) => r.pid === i + 1));
  const starve = S.expired_timestamp
    ? `排到下一輪（expired）的 task 從第 ${S.expired_timestamp} 個 tick（jiffies）開始等，等到第 ${S.expired_timestamp + S.starve_after} 個 tick 就算等太久（STARVATION_LIMIT × task 數），互動型的 task 用完時間片也不能再留在這一輪。`
    : '';
  const foot = (asleep.length ? `睡覺中、不在 prio_array 上：${asleep.map(esc).join('、')}。` : '') + starve + '時間片以 tick 為單位，每個 tick 扣一格，不管這個 tick 裡實際跑了多久。';
  return `<table class="insp-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table><p class="note">${foot}</p>`;
}

// ---------------------------------------------------------------------------
// O(n) 2.4.0

function explainOn(ctx: InspectCtx, idx: number): Explained {
  const { e, nm, ran, verb } = helpers(ctx, idx);
  const S = e.snapshot as OnSnapshot;
  const B = e.before as OnSnapshot | null;
  const t = (pid: number | null, s: OnSnapshot | null = S) => s?.tasks.find((x) => x.pid === pid);
  const g = (x: OnTaskView, mm: number | null) => goodness(x.counter, x.nice, x.pid, mm);
  const tick = (n: number) => `${n} 個 tick（${dur(n * S.tick_ns)}）`;
  const why: string[] = [];
  const title = pickTitle(e, nm);

  if (e.kind === 'wakeup') {
    const w = t(e.causePid);
    const c = t(e.next);
    let plain = `${nm(e.causePid)} ${verb}了，${nm(e.next)} 繼續跑。`;
    if (w && c) {
      const gw = g(w, c.pid);
      const gc = g(c, c.pid);
      why.push(`${nm(w.pid)} ${verb}，add_to_runqueue() 把它加在 runqueue 串列的最前面。` + (e.cause === 'new' ? `它拿到 parent 一半的 counter（${w.counter}）。` : ''));
      if (w.counter === 0) {
        plain = `${nm(w.pid)} 醒來了，但它這一輪的時間片已經用完，要等所有程式都用完、一起重算才能再跑。`;
        why.push(`${nm(w.pid)} 的 counter 是 0，goodness() 回傳 0，不可能搶佔，要等 runqueue 上每個 task 都用完、重算 counter 之後才有機會。`);
      } else {
        plain = `${nm(w.pid)} ${verb}了，但它剩下的時間片沒有比 ${nm(c.pid)} 多夠多，先排隊。`;
        why.push(
          `reschedule_idle() 比 goodness（剩下的 counter + 20 − nice，正在跑的 ${nm(c.pid)} 用自己的 mm 再加 1）：` +
            `${nm(w.pid)} 是 ${gw}，${nm(c.pid)} 是 ${gc}。要高出 2 以上才搶佔，所以 ${nm(c.pid)} 繼續跑。`,
        );
      }
    } else why.push(`${nm(e.causePid)} ${verb}，沒有觸發重新排程。`);
    return { title, plain, why, rows: [], chosen: e.next };
  }

  let reason = '';
  let plain = '';
  const pB = t(e.prev, B);
  if (e.cause === 'sleep') {
    reason = `${nm(e.causePid)} 做完這一段去睡了，`;
    why.push(`${nm(e.causePid)} 去睡了${ran !== null ? `（這次跑了 ${dur(ran)}）` : ''}，從 runqueue 串列上拿掉，schedule() 要挑下一個。沒用完的 counter 留著。`);
  } else if (e.cause === 'new') {
    const w = t(e.causePid);
    reason = `新程式 ${nm(e.causePid)} 加入，`;
    why.push(`新程式 ${nm(e.causePid)} 建立${w ? `，拿到 parent 一半的 counter（${w.counter}）` : ''}，wake_up_process() 把它加在 runqueue 最前面。CPU 閒著，直接重新排程。`);
  } else if (e.cause === 'wakeup') {
    const wB = t(e.causePid, B);
    if (e.prev === null) {
      reason = `CPU 閒著，${nm(e.causePid)} 醒來，`;
      why.push(`${nm(e.causePid)} 醒來時 CPU 是閒的，直接重新排程。`);
    } else if (wB && pB) {
      const gw = g(wB, pB.pid);
      const gp = g(pB, pB.pid);
      reason = `${nm(wB.pid)} 醒來，它剩下的時間片比 ${nm(pB.pid)} 多（goodness 較高），`;
      if (e.next === wB.pid) plain = `${nm(wB.pid)} 醒來，它剩下的時間片比 ${nm(pB.pid)} 多得多，直接插隊。`;
      why.push(`${nm(wB.pid)} 醒來，goodness 是 ${gw}，比 ${nm(pB.pid)} 的 ${gp} 高出 2 以上，reschedule_idle() 要求重新排程。`);
    } else {
      reason = `${nm(e.causePid)} 醒來，`;
      why.push(`${nm(e.causePid)} 醒來，觸發重新排程。`);
    }
  } else if (pB) {
    reason = `${nm(pB.pid)} 的時間片用完了，`;
    why.push(`tick 時 update_process_times() 把 ${nm(pB.pid)} 的 counter 扣到 0（一個 tick 扣 1，滿的是 ${tick(pB.full)}），要求重新排程。`);
  } else {
    why.push('tick 時要求重新排程。');
  }

  const recalc = B !== null && S.recalcs > B.recalcs;
  if (recalc) {
    const rich = S.sleepers.filter((x) => x.counter > x.full);
    why.push(
      'runqueue 上每個 task 的 counter 都用完了（goodness 全是 0），schedule() 跳到 recalculate：系統裡每一個 task，包括睡著的，counter = counter / 2 + NICE_TO_TICKS(nice)，然後重挑。' +
        (rich.length ? `睡著的 ${rich.map((x) => nm(x.pid)).join('、')} 上一輪沒用完的保留一半，重算後比滿的還多。` : ''),
    );
  }
  let choice: string;
  const n = t(e.next);
  if (e.next === null) {
    choice = '沒有程式想跑，CPU 閒著。';
    why.push('runqueue 是空的，CPU 閒置。');
  } else if (!n) {
    choice = `換 ${nm(e.next)}。`;
    why.push(`選中 ${nm(e.next)}。`);
  } else if (S.tasks.length === 1) {
    choice = `只有 ${nm(n.pid)} 想跑。`;
    why.push(`只有 ${nm(n.pid)} 想跑。`);
  } else {
    const gn = n.goodness;
    const ties = S.tasks.filter((x) => x.pid !== n.pid && x.goodness === gn);
    choice =
      e.prev === e.next
        ? `重新比一次，還是 ${nm(n.pid)} 的分數最高。`
        : recalc
          ? `所有程式的時間片一起重發，換 ${nm(n.pid)}。`
          : `換 ${nm(n.pid)}：它剩下的時間片加上 nice 的分數最高。`;
    why.push(
      `schedule() 從頭走過整條 runqueue（${S.runqueue.length} 個 task，呼叫 goodness() ${S.last_scan} 次），選最大的：${nm(n.pid)} 是 ${gn}` +
        `（counter ${n.counter} + 20 − nice ${n.nice}${n.pid === S.pick_mm ? ' + 同一個 mm 的 1' : ''}）。` +
        (ties.length
          ? `${ties.map((x) => nm(x.pid)).join('、')} 也是 ${gn}，平手時${e.prev === e.next ? '留下原本在跑的' : '取串列裡排在前面的'}。`
          : ''),
    );
  }
  if (e.prev === e.next && e.next !== null && S.tasks.length > 1) why.push('重新挑的結果還是同一個，沒有 context switch。');
  if (!plain) plain = reason + choice;
  return { title, plain, why, rows: [], chosen: e.next };
}

/** goodness 長條，依 runqueue 串列順序 */
function onBars(ctx: InspectCtx, S: OnSnapshot, chosen: number | null): string {
  if (!S.tasks.length) return '';
  const order = S.runqueue.map((pid) => S.tasks.find((x) => x.pid === pid)!);
  const W = 640;
  const LABEL = 92;
  const R = 60;
  const LANE = 18;
  const top = 4;
  const H = top + order.length * LANE + 26;
  const max = Math.max(40, ...order.map((x) => x.goodness));
  const X = (v: number) => LABEL + (v / max) * (W - LABEL - R);
  const axisY = top + order.length * LANE + 4;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="runqueue 上每個 task 的 goodness">`;
  order.forEach((x, i) => {
    const y = top + i * LANE;
    const col = ctx.color(x.pid - 1);
    const picked = x.pid === chosen;
    const name = ctx.names[x.pid - 1] ?? '';
    svg += `<text class="nm${picked ? ' picked' : ''}" x="${LABEL - 8}" y="${y + 13}" text-anchor="end">${picked ? '▶ ' : ''}${esc(name)}</text>`;
    if (x.goodness > 0) {
      // counter 的部分深色，20 − nice（和 mm 的 1 分）淺色
      svg += `<rect x="${X(0)}" y="${y + 3}" width="${X(x.counter) - X(0)}" height="${LANE - 6}" style="fill:${col}"/>`;
      svg += `<rect x="${X(x.counter)}" y="${y + 3}" width="${X(x.goodness) - X(x.counter)}" height="${LANE - 6}" style="fill:${col}" opacity="0.35"/>`;
    }
    svg += `<text class="tl" x="${X(x.goodness) + 6}" y="${y + 13}">${x.goodness}</text>`;
    if (picked) svg += `<rect x="${X(0) - 2}" y="${y + 1}" width="${X(x.goodness) - X(0) + 4}" height="${LANE - 2}" class="ring" rx="3"/>`;
  });
  svg += `<line class="axis" x1="${LABEL}" x2="${W - R}" y1="${axisY}" y2="${axisY}"/>`;
  svg += `<text class="tl" x="${LABEL}" y="${axisY + 16}">← runqueue 串列頭（剛醒來的加在這裡）</text>`;
  svg += '</svg>';
  const legend =
    '一列是 runqueue 串列上的一個 task，由上到下是串列順序。長條長度是 goodness：深色是剩下的 counter，淺色是 20 − nice（加上和上一個 task 同 mm 的 1 分）。counter 是 0 的 goodness 直接是 0。' +
    'schedule() 每次都從頭掃到尾，選最長的（紫框），所以成本和 task 數量成正比。';
  return `<div class="insp-line">${svg}<div class="insp-legend">${legend}</div></div>`;
}

function onTable(ctx: InspectCtx, S: OnSnapshot, x: Explained, e: SchedEvent): string {
  const state = (r: OnTaskView) => {
    if (r.pid === x.chosen) return e.kind === 'wakeup' || e.prev === e.next ? '繼續跑' : '被選中';
    if (e.kind === 'wakeup' && r.pid === e.causePid) return e.cause === 'new' ? '剛建立，等待' : '剛醒來，等待';
    return '等待';
  };
  const body = S.tasks
    .map((r) => {
      const name = `<span class="swatch" style="background:${ctx.color(r.pid - 1)}"></span>${esc(ctx.names[r.pid - 1] ?? '')}`;
      return `<tr${r.pid === x.chosen ? ' class="chosen"' : ''}><td>${name}</td><td>${state(r)}</td><td>${r.counter} / ${r.full}</td><td>${r.nice}</td><td>${r.goodness}</td><td>${r.pos + 1}</td></tr>`;
    })
    .join('');
  const head = `<th>程式</th><th>狀態</th><th>${term('counter')} 剩下 / 滿</th><th>${term('nice')}</th><th>${term('goodness')}</th><th>串列位置</th>`;
  const sleepers = S.sleepers.map((s) => `${esc(ctx.names[s.pid - 1] ?? '')}（counter ${s.counter}）`);
  const foot =
    (sleepers.length ? `睡覺中、不在 runqueue 上：${sleepers.join('、')}。` : '') +
    `counter 以 tick 為單位（HZ = ${Math.round(1e9 / S.tick_ns)}，一個 tick ${dur(S.tick_ns)}），tick 時正在跑的扣 1，不管這個 tick 裡實際跑了多久。`;
  return `<table class="insp-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table><p class="note">${foot}</p>`;
}

// ---------------------------------------------------------------------------

export function explainLegacy(ctx: InspectCtx, idx: number): Explained {
  return ctx.family === 'o1' ? explainO1(ctx, idx) : explainOn(ctx, idx);
}

/** 圖與數值表 */
export function legacyDetail(ctx: InspectCtx, idx: number, x: Explained): string {
  const e = ctx.events[idx]!;
  if (ctx.family === 'o1') {
    const S = e.snapshot as O1Snapshot;
    return o1Grid(ctx, S, x.chosen) + o1Table(ctx, S, x, e);
  }
  const raw = e.snapshot as OnSnapshot;
  // goodness 的 +1 給「現在這個 CPU 上的 mm」：挑選時是 prev 的，喚醒時 reschedule_idle() 用的是 curr 的
  const mm = e.kind === 'wakeup' ? e.next : raw.pick_mm;
  const S: OnSnapshot = { ...raw, pick_mm: mm, tasks: raw.tasks.map((t) => ({ ...t, goodness: goodness(t.counter, t.nice, t.pid, mm) })) };
  return onBars(ctx, S, x.chosen) + onTable(ctx, S, x, e);
}
