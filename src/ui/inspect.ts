// 決策檢視：把一個排程事件（SchedEvent）變成「為什麼是它」的說明、數線和數值表。
// 只讀引擎拍下的快照，不重跑排程器；說明裡的判斷都先用快照驗證過，對不上就退回中性的敘述。
import type { SchedEvent } from '../core/engine.ts';
import { NSEC_PER_MSEC as MS, type Ns } from '../core/types.ts';
import { NICE_0_LOAD } from '../core/weights.ts';
import type { CfsSnapshot } from '../sched/cfs-v2.6.24.ts';
import type { EevdfSnapshot } from '../sched/eevdf-v6.6.ts';
import type { Flags } from '../variants.ts';
import { linkTerms, term } from './glossary.ts';
import { explainLegacy, legacyDetail } from './inspect-legacy.ts';

export interface InspectCtx {
  family: 'on' | 'o1' | 'cfs' | 'eevdf';
  names: string[];
  /** 第 i 個 task 的 CSS 顏色 */
  color: (i: number) => string;
  flags: Flags;
  events: SchedEvent[];
}

/** 快照裡的一個 task，位置都換成相對於參考點（CFS：min_vruntime，EEVDF：V） */
export interface Row {
  pid: number;
  weight: number;
  /** vruntime − 參考點 */
  rel: Ns;
  /** deadline − 參考點（只有 EEVDF） */
  dl: Ns | null;
  eligible: boolean;
  delayed: boolean;
  slice: Ns;
  /** RUN_TO_PARITY 的保護還在（vlag 暫存的 deadline 沒變）；只有 EEVDF 的 curr 有意義 */
  parity: boolean;
  /** 保護被 PREEMPT_SHORT 取消（vlag = deadline + 1） */
  parityCancelled: boolean;
  curr: boolean;
}

type Snap = CfsSnapshot | EevdfSnapshot;
const isEevdf = (s: Snap): s is EevdfSnapshot => 'avg_vruntime' in s;

export function rowsOf(snapshot: unknown): Row[] {
  const s = snapshot as Snap | null;
  if (!s) return [];
  const out: Row[] = [];
  if (isEevdf(s)) {
    const V = s.avg_vruntime;
    const add = (e: EevdfSnapshot['timeline'][number], curr: boolean) =>
      out.push({
        pid: e.pid,
        weight: e.weight,
        rel: e.vruntime - V,
        dl: e.deadline - V,
        eligible: e.eligible,
        delayed: e.sched_delayed,
        slice: e.slice,
        parity: e.vlag === e.deadline,
        parityCancelled: e.vlag === e.deadline + 1,
        curr,
      });
    if (s.curr) add(s.curr, true);
    for (const e of s.timeline) add(e, false);
  } else {
    const add = (e: CfsSnapshot['timeline'][number], curr: boolean) =>
      out.push({
        pid: e.pid,
        weight: e.weight,
        rel: e.vruntime - s.min_vruntime,
        dl: null,
        eligible: true,
        delayed: false,
        slice: e.slice,
        parity: false,
        parityCancelled: false,
        curr,
      });
    if (s.curr) add(s.curr, true);
    for (const e of s.timeline) add(e, false);
  }
  return out.sort((a, b) => a.pid - b.pid);
}

// ---------------------------------------------------------------------------
// 找事件

/** 最後一個 t ≤ target 的事件；沒有就回傳 -1 */
export function latestAtOrBefore(events: SchedEvent[], target: Ns): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.t <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** 點在某個 task 那一列時：往前找最近一個和它有關的事件（它醒來、被選中、被換下來） */
export function latestForPid(events: SchedEvent[], target: Ns, pid: number): number {
  for (let i = latestAtOrBefore(events, target); i >= 0; i--) {
    const e = events[i]!;
    if (e.causePid === pid && e.cause !== 'tick') return i;
    if (e.kind === 'pick' && e.prev !== e.next && (e.next === pid || e.prev === pid)) return i;
  }
  return latestAtOrBefore(events, target);
}

// ---------------------------------------------------------------------------
// 格式

const ms = (ns: Ns, digits = 3) => `${(ns / MS).toFixed(digits)}ms`;
/** 帶正負號，給相對位置用 */
const sms = (ns: Ns, digits = 3) => (ns > 0 ? '+' : ns < 0 ? '−' : '') + ms(Math.abs(ns), digits);
const dur = (ns: Ns) => (ns >= MS ? `${+(ns / MS).toFixed(2)}ms` : `${Math.round(ns / 1000)}µs`);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------------------
// 說明文字

export interface Explained {
  /** 例如「cc1 → audio」 */
  title: string;
  /** 不用術語的一句話摘要 */
  plain: string;
  /** 一句一段 */
  why: string[];
  rows: Row[];
  /** 這一步被選中（或繼續跑）的 pid */
  chosen: number | null;
}

const WAKEUP_GRAN = 10 * MS; // v2.6.24 sysctl_sched_wakeup_granularity

/** O(n) 與 O(1) 沒有 vruntime，說明和圖在 inspect-legacy.ts */
export const isLegacy = (ctx: InspectCtx) => ctx.family === 'on' || ctx.family === 'o1';

export function explain(ctx: InspectCtx, idx: number): Explained {
  if (isLegacy(ctx)) return explainLegacy(ctx, idx);
  const e = ctx.events[idx]!;
  const rows = rowsOf(e.snapshot);
  const nm = (pid: number | null) => (pid === null ? 'idle' : (ctx.names[pid - 1] ?? `pid ${pid}`));
  const row = (pid: number | null) => rows.find((r) => r.pid === pid);
  const list = (rs: Row[]) => rs.map((r) => nm(r.pid)).join('、');
  const why: string[] = [];
  const eevdf = ctx.family === 'eevdf';
  const on = (k: string) => ctx.flags[k] ?? true;
  let plain = '';

  // ---- 醒來，但 curr 繼續跑 ----
  if (e.kind === 'wakeup') {
    const w = row(e.causePid);
    const c = row(e.next);
    const verb = e.cause === 'new' ? '被建立' : '醒來';
    const title = `${nm(e.causePid)} ${verb}，${nm(e.next)} 繼續跑`;
    plain = `${nm(e.causePid)} ${verb}了，${nm(e.next)} 繼續跑。`;
    if (!w || !c) {
      why.push(`${nm(e.causePid)} ${verb}，沒有觸發重新排程。`);
    } else if (!eevdf) {
      const diff = c.rel - w.rel;
      const gran = Math.round((WAKEUP_GRAN * NICE_0_LOAD) / c.weight);
      why.push(`${nm(w.pid)} ${verb}，place_entity() 把它放在 min_vruntime ${sms(w.rel)}。`);
      if (!on('WAKEUP_PREEMPT')) {
        plain = `${nm(w.pid)} ${verb}了，但這個設定下醒來的程式不能插隊，要等 ${nm(c.pid)} 用完這一輪的時間。`;
        why.push(`WAKEUP_PREEMPT 關掉了，check_preempt_wakeup() 不做任何事。${nm(w.pid)} 要等 ${nm(c.pid)} 在 tick 時用完 sched_slice（${dur(c.slice)}）。`);
      } else {
        plain = `${nm(w.pid)} ${verb}了，但它沒有比 ${nm(c.pid)} 落後夠多（要差 10ms 以上），排程器不為它打斷 ${nm(c.pid)}，先排隊。`;
        why.push(
          `check_preempt_wakeup() 的條件是它的 vruntime 要比 ${nm(c.pid)} 小超過 wakeup_granularity（${dur(gran)}）。` +
            `現在只${diff >= 0 ? '小' : '大'} ${ms(Math.abs(diff))}，不搶佔。它要等 ${nm(c.pid)} 在 tick 時用完 sched_slice（${dur(c.slice)}）。`,
        );
      }
    } else if (!w.eligible) {
      plain =
        on('PLACE_LAG') && e.cause === 'wakeup'
          ? `${nm(w.pid)} 醒來了，但它之前拿的 CPU 比應得的多，這筆帳醒來還在，要等其他程式追上來才有資格跑。`
          : `${nm(w.pid)} ${verb}了，但它現在多拿了一點，沒有資格被選。`;
      why.push(`${nm(w.pid)} ${verb}，place_entity() 把它放在 V ${sms(w.rel)}，也就是 lag = ${sms(-w.rel)}。`);
      why.push(
        (on('PLACE_LAG') && e.cause === 'wakeup' ? '這是它睡前帶走的 lag：之前拿的比應得的多。' : '') +
          `lag < 0 就不 eligible，pick_eevdf() 不會選它，${nm(c.pid)} 繼續跑。它要等 V 往右走過它的 vruntime 才有資格被選。`,
      );
    } else {
      const earlier = w.dl! < c.dl!;
      plain = earlier
        ? `${nm(w.pid)} 醒來了，有資格跑、截止時間也比 ${nm(c.pid)} 早，但規則是讓 ${nm(c.pid)} 先把手上這一小段跑完。`
        : `${nm(w.pid)} 醒來了，有資格跑，但截止時間沒有比 ${nm(c.pid)} 早，${nm(c.pid)} 繼續跑。`;
      why.push(`${nm(w.pid)} ${verb}，放在 V ${sms(w.rel)}（lag = ${sms(-w.rel)}），是 eligible 的；deadline 在 V ${sms(w.dl!)}，${nm(c.pid)} 的在 V ${sms(c.dl!)}。`);
      if (on('RUN_TO_PARITY') && c.parity && c.eligible) {
        why.push(
          `${earlier ? `它的 deadline 比較早，但` : `它的 deadline 也沒有比較早，而且`} RUN_TO_PARITY 讓 ${nm(c.pid)} 把目前這個 slice 跑完，中途不重新比 deadline，所以沒有搶佔。` +
            (earlier && 'PREEMPT_SHORT' in ctx.flags && on('PREEMPT_SHORT') && w.slice >= c.slice
              ? `PREEMPT_SHORT 只幫 slice 比 curr 短的程式，${nm(w.pid)} 的 slice（${dur(w.slice)}）沒有比較短。`
              : ''),
        );
      } else {
        const best = rows.filter((r) => r.eligible).sort((a, b) => a.dl! - b.dl!)[0];
        if (best && best.pid !== w.pid) plain = `${nm(w.pid)} 醒來了，有資格跑，但 ${nm(best.pid)} 的截止時間更早，輪不到它。`;
        why.push(
          best && best.pid !== w.pid
            ? `eligible 的程式裡 deadline 最早的是 ${nm(best.pid)}（V ${sms(best.dl!)}），不是它，所以沒有搶佔。`
            : `check_preempt_wakeup() 試挑的結果不是它，沒有搶佔。`,
        );
      }
    }
    return { title, plain, why, rows, chosen: e.next };
  }

  // ---- schedule() 挑選 ----
  const title = e.prev === e.next ? `重新挑選，還是 ${nm(e.next)}` : `${nm(e.prev)} → ${nm(e.next)}`;
  const p = row(e.prev);
  const w = row(e.causePid);
  const prevEvent = (() => {
    for (let i = idx - 1; i >= 0; i--) if (ctx.events[i]!.kind === 'pick') return ctx.events[i]!;
    return null;
  })();
  const ran = prevEvent && e.prev !== null && prevEvent.next === e.prev ? e.t - prevEvent.t : null;
  /** prev 的 deadline 剛被 update_deadline() 重發：deadline − vruntime 剛好是一個完整的 vslice */
  const renewed = eevdf && p ? Math.abs(p.dl! - p.rel - (p.slice * NICE_0_LOAD) / p.weight) <= 2 : false;

  // 1. 為什麼這時候要重新排程（reason：白話摘要的前半句；preempted：摘要已經講完，不用再接後半句）
  let reason = '排程器重新挑選，';
  let preempted = false;
  if (e.cause === 'sleep') {
    reason = `${nm(e.causePid)} 做完這一段去睡了，CPU 空出來，`;
    why.push(`${nm(e.causePid)} 做完這一段去睡了${ran !== null ? `（這次跑了 ${dur(ran)}）` : ''}，CPU 空出來，schedule() 要挑下一個。`);
  } else if (e.cause === 'new') {
    reason = `新程式 ${nm(e.causePid)} 加入，`;
    why.push(
      `新程式 ${nm(e.causePid)} 建立。` +
        (!eevdf && w
          ? `place_entity() 把它放在 min_vruntime ${sms(w.rel)}${on('START_DEBIT') ? '（START_DEBIT：先欠一個 vslice）' : ''}，task_new_fair() 一律要求重新排程。`
          : ''),
    );
  } else if (e.cause === 'wakeup') {
    if (e.prev === null) {
      reason = `CPU 閒著，${nm(e.causePid)} 醒來，`;
      why.push(`${nm(e.causePid)} 醒來時 CPU 是閒的，直接重新排程。`);
    } else if (!eevdf && w && p) {
      plain = `${nm(w.pid)} 醒來，它比 ${nm(p.pid)} 落後超過 10ms，直接插隊。`;
      reason = `${nm(w.pid)} 醒來，它比 ${nm(p.pid)} 落後超過 10ms，要求重新排程，`;
      preempted = e.next === w.pid;
      const gran = Math.round((WAKEUP_GRAN * NICE_0_LOAD) / p.weight);
      why.push(
        `${nm(w.pid)} 醒來，place_entity() 把它放在 min_vruntime ${sms(w.rel)}。` +
          `它的 vruntime 比 ${nm(p.pid)} 小 ${ms(p.rel - w.rel)}，超過 wakeup_granularity（${dur(gran)}），check_preempt_wakeup() 要求立刻重新排程。`,
      );
    } else if (eevdf && w && p && e.next === w.pid) {
      plain = `${nm(w.pid)} 醒來，它有資格跑，截止時間又是最早的，直接插隊 ${nm(p.pid)}。`;
      preempted = true;
      why.push(`${nm(w.pid)} 醒來，放在 V ${sms(w.rel)}（lag = ${sms(-w.rel)}）。check_preempt_wakeup() 用 pick_eevdf() 試挑一次，挑到的就是它，所以搶佔 ${nm(p.pid)}。`);
      if (on('PREEMPT_SHORT') && 'PREEMPT_SHORT' in ctx.flags && p.parityCancelled && w.slice < p.slice) {
        plain += `它要的 slice 比 ${nm(p.pid)} 短，所以可以打斷 ${nm(p.pid)} 正在跑的那一小段。`;
        why.push(`它的 slice（${dur(w.slice)}）比 ${nm(p.pid)} 的（${dur(p.slice)}）短，PREEMPT_SHORT 先取消了 ${nm(p.pid)}「跑完這個 slice」的保護，否則 RUN_TO_PARITY 會讓 ${nm(p.pid)} 繼續跑。`);
      }
    } else if (eevdf && p && renewed) {
      reason = `${nm(p.pid)} 的這一小段剛好用完，`;
      why.push(`${nm(e.causePid)} 醒來時 update_curr() 順便結帳，發現 ${nm(p.pid)} 的 vruntime 已經走過 deadline，slice 用完了，要求重新排程。`);
    } else {
      reason = `${nm(e.causePid)} 醒來，`;
      why.push(`${nm(e.causePid)} 醒來，觸發重新排程。`);
    }
  } else if (!p) {
    why.push('tick 時要求重新排程。');
  } else if (!eevdf) {
    reason = `${nm(p.pid)} 用完了這一輪分到的時間（${dur(p.slice)}），`;
    why.push(
      `tick 時 check_preempt_tick() 發現 ${nm(p.pid)} 這次上 CPU 已經跑了${ran !== null ? ` ${dur(ran)}` : '很久'}，` +
        `超過它的 sched_slice（${dur(p.slice)} = 20ms × 自己的權重 ÷ 總權重），要求重新排程。`,
    );
  } else if (renewed) {
    reason = `${nm(p.pid)} 用完了這一小段（${dur(p.slice)}），`;
    why.push(
      `tick 時 update_curr() 發現 ${nm(p.pid)} 的 vruntime 走過了 deadline，這個 slice（${dur(p.slice)}）用完了。` +
        `update_deadline() 發給它下一個 deadline（V ${sms(p.dl!)}），並要求重新排程。` +
        (ran !== null && ran > p.slice ? `它這次連續跑了 ${dur(ran)}，比 slice 長，因為只有 1ms 一次的 tick 會檢查。` : ''),
    );
  } else if ('PREEMPT_SHORT' in ctx.flags && on('PREEMPT_SHORT') && !p.eligible) {
    reason = `${nm(p.pid)} 已經多拿了，又被取消了「跑完這一段」的保護，`;
    why.push(`tick 時 ${nm(p.pid)} 已經不 eligible（lag = ${sms(-p.rel)}），而它「跑完這個 slice」的保護先前被 PREEMPT_SHORT 取消了，update_curr() 要求重新排程。`);
  } else {
    why.push('tick 時要求重新排程。');
  }

  // 2. 為什麼挑到 next
  const chosen = row(e.next);
  let choice = `換 ${nm(e.next)}。`;
  if (e.next === null) choice = '沒有程式想跑，CPU 閒著。';
  else if (rows.length === 1) choice = `只有 ${nm(e.next)} 想跑。`;
  else if (e.prev === e.next) choice = `重新比一次，還是 ${nm(e.next)} 最該跑，它繼續跑。`;
  else if (!eevdf) choice = `換 ${nm(e.next)}：按權重換算，它到目前為止跑得最少。`;
  else choice = `換 ${nm(e.next)}：在沒有多拿的程式裡，它的截止時間最早。`;
  if (!preempted) plain = reason + choice;
  if (e.next === null) {
    why.push('沒有程式想跑，CPU 閒置。');
  } else if (!chosen) {
    why.push(`選中 ${nm(e.next)}。`);
  } else if (!eevdf) {
    const leftmost = rows.every((r) => r.rel >= chosen.rel);
    why.push(
      rows.length === 1
        ? `只有 ${nm(chosen.pid)} 想跑。`
        : leftmost
          ? `__pick_next_entity() 拿紅黑樹最左邊的，也就是 vruntime 最小的：${nm(chosen.pid)}（min_vruntime ${sms(chosen.rel)}）。`
          : `選中 ${nm(chosen.pid)}。`,
    );
  } else {
    // 被選中時才真正離開的 delayed entity：在 before 裡、不在 after 裡
    const gone = rowsOf(e.before).filter((r) => r.delayed && !row(r.pid));
    for (const g of gone) {
      why.push(
        `pick_eevdf() 先挑到 ${nm(g.pid)}：它其實已經睡著，睡前 lag 是負的，被 DELAY_DEQUEUE 留在佇列上。` +
          `現在它變成 eligible 又被挑到，表示多拿的已經還完，這時才真正離開佇列（DELAY_ZERO 把剩下的正 lag 歸零），然後重挑。`,
      );
    }
    const elig = rows.filter((r) => r.eligible);
    const inel = rows.filter((r) => !r.eligible);
    const best = [...elig].sort((a, b) => a.dl! - b.dl!)[0];
    const ties = elig.filter((r) => best && r.dl === best.dl);
    if (rows.length === 1) {
      why.push(`只有 ${nm(chosen.pid)} 想跑。`);
    } else if (ties.length > 1 && ties.includes(chosen)) {
      why.push(
        `pick_eevdf() 的規則：先看誰 eligible（lag ≥ 0）` +
          (inel.length ? `，${list(inel)} 的 lag 是負的，不能選` : '') +
          `。${list(ties)} 的 deadline 一樣早（V ${sms(chosen.dl!)}），平手。模擬器取紅黑樹裡排在前面的 ${nm(chosen.pid)}；kernel 在平手時的結果取決於樹的形狀。`,
      );
    } else if (best && best.pid === chosen.pid) {
      why.push(
        `pick_eevdf() 的規則：先看誰 eligible（lag ≥ 0，也就是 vruntime 在 V 左邊）` +
          (inel.length ? `，${list(inel)} 的 lag 是負的，不能選` : '，現在全部都是') +
          `。` +
          (elig.length > 1 ? `剩下的 ${list(elig)} 裡 deadline 最早的是 ${nm(chosen.pid)}（V ${sms(chosen.dl!)}）。` : `只剩 ${nm(chosen.pid)} 可以選。`),
      );
    } else {
      why.push(`選中 ${nm(chosen.pid)}。`);
    }
    const stay = rows.filter((r) => r.delayed);
    if (stay.length) {
      why.push(`${list(stay)} 已經睡著，但睡前 lag 是負的，DELAY_DEQUEUE 把它留在佇列上：它仍然算進 V，等它變成 eligible 被挑到時才真正離開。`);
    }
  }
  if (e.prev === e.next && e.next !== null && rows.length > 1) why.push('重新挑的結果還是同一個，沒有 context switch。');

  return { title, plain, why, rows, chosen: e.next };
}

// ---------------------------------------------------------------------------
// 數線：每個 task 一列，圓點是 vruntime，EEVDF 另外畫到 deadline 的線段

function numberLine(ctx: InspectCtx, x: Explained): string {
  const { rows } = x;
  if (!rows.length) return '';
  const eevdf = ctx.family === 'eevdf';
  const W = 640;
  const LABEL = 92;
  const R = 28;
  const LANE = 18;
  const top = 6;
  const H = top + rows.length * LANE + 30;
  const span = Math.max(0.2 * MS, ...rows.flatMap((r) => [Math.abs(r.rel), Math.abs(r.dl ?? 0)])) * 1.12;
  const X = (v: number) => LABEL + ((v + span) / (2 * span)) * (W - LABEL - R);
  const axisY = top + rows.length * LANE + 4;

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="各程式相對 ${eevdf ? 'V' : 'min_vruntime'} 的位置">`;
  if (eevdf) svg += `<rect class="elig" x="${LABEL}" y="${top - 2}" width="${X(0) - LABEL}" height="${rows.length * LANE + 4}"/>`;
  svg += `<line class="ref" x1="${X(0)}" x2="${X(0)}" y1="${top - 2}" y2="${axisY + 4}"/>`;
  svg += `<line class="axis" x1="${LABEL}" x2="${W - R}" y1="${axisY}" y2="${axisY}"/>`;
  for (const v of [-span / 1.12, span / 1.12]) {
    svg += `<line class="axis" x1="${X(v)}" x2="${X(v)}" y1="${axisY - 3}" y2="${axisY + 3}"/>`;
    svg += `<text class="tl" x="${X(v)}" y="${axisY + 16}" text-anchor="middle">${sms(v, 2)}</text>`;
  }
  svg += `<text class="tl refl" x="${X(0)}" y="${axisY + 16}" text-anchor="middle">${eevdf ? 'V' : 'min_vruntime'}</text>`;
  if (eevdf) svg += `<text class="tl" x="${(LABEL + X(0)) / 2}" y="${axisY + 16}" text-anchor="middle">eligible（lag ≥ 0）</text>`;

  rows.forEach((r, i) => {
    const y = top + i * LANE + LANE / 2;
    const col = ctx.color(r.pid - 1);
    const name = ctx.names[r.pid - 1] ?? '';
    const picked = r.pid === x.chosen;
    svg += `<text class="nm${picked ? ' picked' : ''}" x="${LABEL - 8}" y="${y + 4}" text-anchor="end">${picked ? '▶ ' : ''}${esc(name)}</text>`;
    if (r.dl !== null) {
      svg += `<line x1="${X(r.rel)}" x2="${X(r.dl)}" y1="${y}" y2="${y}" style="stroke:${col}" stroke-width="2" opacity="${r.eligible ? 0.9 : 0.4}"/>`;
      svg += `<line x1="${X(r.dl)}" x2="${X(r.dl)}" y1="${y - 5}" y2="${y + 5}" style="stroke:${col}" stroke-width="2.5" opacity="${r.eligible ? 1 : 0.5}"/>`;
    }
    svg += r.eligible
      ? `<circle cx="${X(r.rel)}" cy="${y}" r="4.5" style="fill:${col}"/>`
      : `<circle cx="${X(r.rel)}" cy="${y}" r="3.5" class="hollow" style="stroke:${col}"/>`;
    if (picked) svg += `<circle cx="${X(r.rel)}" cy="${y}" r="7.5" class="ring"/>`;
  });
  svg += '</svg>';
  const legend = eevdf
    ? '每一列是一個想跑的程式。圓點是它的 vruntime，虛線是 V。圓點在 V 左邊（綠色區域）表示 lag ≥ 0、沒有多拿，有資格被選；在右邊、畫成空心的表示多拿了，要等。線段右端的直槓是 deadline，有資格的程式裡直槓最靠左的被選中（紫圈）。'
    : '每一列是一個想跑的程式，圓點是它的 vruntime，虛線是 min_vruntime。CFS 的規則只有一條：圓點最靠左（按權重算跑得最少）的被選中（紫圈）。';
  return `<div class="insp-line">${svg}<div class="insp-legend">${legend}</div></div>`;
}

function table(ctx: InspectCtx, x: Explained, e: SchedEvent): string {
  const eevdf = ctx.family === 'eevdf';
  const state = (r: Row) => {
    if (r.delayed) return '已睡著（delayed）';
    if (r.pid === x.chosen) return e.kind === 'wakeup' || e.prev === e.next ? '繼續跑' : '被選中';
    if (e.kind === 'wakeup' && r.pid === e.causePid) return e.cause === 'new' ? '剛建立，等待' : '剛醒來，等待';
    return '等待';
  };
  const body = x.rows
    .map((r) => {
      const name = `<span class="swatch" style="background:${ctx.color(r.pid - 1)}"></span>${esc(ctx.names[r.pid - 1] ?? '')}`;
      const cls = r.pid === x.chosen ? ' class="chosen"' : '';
      return eevdf
        ? `<tr${cls}><td>${name}</td><td>${state(r)}</td><td>${sms(-r.rel)}</td><td>${r.eligible ? '是' : '否'}</td><td>${sms(r.dl!)}</td><td>${dur(r.slice)}</td></tr>`
        : `<tr${cls}><td>${name}</td><td>${state(r)}</td><td>${sms(r.rel)}</td><td>${dur(r.slice)}</td></tr>`;
    })
    .join('');
  const head = eevdf
    ? `<th>程式</th><th>狀態</th><th>${term('lag')}（V − vruntime）</th><th>${term('eligible')}</th><th>${term('deadline')} − V</th><th>${term('slice')}</th>`
    : `<th>程式</th><th>狀態</th><th>${term('vruntime')} − ${term('min_vruntime')}</th><th>${term('sched_slice')}</th>`;
  const asleep = ctx.names.filter((_, i) => !x.rows.some((r) => r.pid === i + 1));
  const foot =
    (asleep.length ? `睡覺中、不在佇列上：${asleep.map(esc).join('、')}。` : '') +
    (eevdf
      ? '這裡的 lag 是 kernel 自己用 V（vruntime 的加權平均）算的，單位是虛擬時間；下面那張圖的 lag 是照 GPS 另外算的，兩者不是同一個數字。'
      : 'CFS 沒有 lag 這個量，只比 vruntime。');
  return `<table class="insp-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table><p class="note">${foot}</p>`;
}

/** 決策檢視的 HTML（不含上一個 / 下一個按鈕） */
export function renderDecision(ctx: InspectCtx, idx: number, detailOpen = true): { title: string; html: string } {
  const e = ctx.events[idx]!;
  const x = explain(ctx, idx);
  const seen = new Set<string>();
  return {
    title: `t = ${ms(e.t)}　${x.title}`,
    html: `<p class="insp-plain">${linkTerms(esc(x.plain))}</p>
      <details class="insp-detail"${detailOpen ? ' open' : ''}><summary>排程器實際比了什麼</summary>
        <div class="insp-why">${x.why.map((s) => `<p>${linkTerms(esc(s), seen)}</p>`).join('')}</div>${isLegacy(ctx) ? legacyDetail(ctx, idx, x) : numberLine(ctx, x) + table(ctx, x, e)}
      </details>`,
  };
}
