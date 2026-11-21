// 決策檢視：把一個排程事件（SchedEvent）變成「為什麼是它」的說明、數線和數值表。
// 只讀引擎拍下的快照，不重跑排程器；說明裡的判斷都先用快照驗證過，對不上就退回中性的敘述。
import type { SchedEvent } from '../core/engine.ts';
import { NSEC_PER_MSEC as MS, type Ns } from '../core/types.ts';
import { NICE_0_LOAD } from '../core/weights.ts';
import type { CfsSnapshot } from '../sched/cfs-v2.6.24.ts';
import type { EevdfSnapshot } from '../sched/eevdf-v6.6.ts';
import type { Family, Flags } from '../variants.ts';
import { gap, joinList, tr } from '../i18n.ts';
import { linkTerms, term } from './glossary.ts';
import { explainLegacy, legacyDetail } from './inspect-legacy.ts';
import { explainPaper } from './inspect-paper.ts';

export interface InspectCtx {
  family: Family;
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

/** 數值表「狀態」一欄：被選中、繼續跑、剛醒來在等 */
export function taskState(x: Explained, e: SchedEvent, pid: number): string {
  if (pid === x.chosen) return e.kind === 'wakeup' || e.prev === e.next ? tr('繼續跑', 'keeps running') : tr('被選中', 'picked');
  if (e.kind === 'wakeup' && pid === e.causePid) return e.cause === 'new' ? tr('剛建立，等待', 'just created, waiting') : tr('剛醒來，等待', 'just woke up, waiting');
  return tr('等待', 'waiting');
}

/** O(n) 與 O(1) 沒有 vruntime，說明和圖在 inspect-legacy.ts */
export const isLegacy = (ctx: InspectCtx) => ctx.family === 'on' || ctx.family === 'o1';

export function explain(ctx: InspectCtx, idx: number): Explained {
  if (isLegacy(ctx)) return explainLegacy(ctx, idx);
  if (ctx.family === 'paper') return explainPaper(ctx, idx);
  const e = ctx.events[idx]!;
  const rows = rowsOf(e.snapshot);
  const nm = (pid: number | null) => (pid === null ? 'idle' : (ctx.names[pid - 1] ?? `pid ${pid}`));
  const row = (pid: number | null) => rows.find((r) => r.pid === pid);
  const list = (rs: Row[]) => joinList(rs.map((r) => nm(r.pid)));
  const why: string[] = [];
  const eevdf = ctx.family === 'eevdf';
  const on = (k: string) => ctx.flags[k] ?? true;
  let plain = '';

  // ---- 醒來，但 curr 繼續跑 ----
  if (e.kind === 'wakeup') {
    const w = row(e.causePid);
    const c = row(e.next);
    const verb = e.cause === 'new' ? tr('被建立', 'is created') : tr('醒來', 'wakes up');
    const title = tr(`${nm(e.causePid)} ${verb}，${nm(e.next)} 繼續跑`, `${nm(e.causePid)} ${verb}, ${nm(e.next)} keeps running`);
    plain = tr(`${nm(e.causePid)} ${verb}了，${nm(e.next)} 繼續跑。`, `${nm(e.causePid)} ${verb}; ${nm(e.next)} keeps running.`);
    if (!w || !c) {
      why.push(tr(`${nm(e.causePid)} ${verb}，沒有觸發重新排程。`, `${nm(e.causePid)} ${verb} without triggering a reschedule.`));
    } else if (!eevdf) {
      const diff = c.rel - w.rel;
      const gran = Math.round((WAKEUP_GRAN * NICE_0_LOAD) / c.weight);
      why.push(tr(`${nm(w.pid)} ${verb}，place_entity() 把它放在 min_vruntime ${sms(w.rel)}。`, `${nm(w.pid)} ${verb}; place_entity() puts it at min_vruntime ${sms(w.rel)}.`));
      if (!on('WAKEUP_PREEMPT')) {
        plain = tr(
          `${nm(w.pid)} ${verb}了，但這個設定下醒來的程式不能插隊，要等 ${nm(c.pid)} 用完這一輪的時間。`,
          `${nm(w.pid)} ${verb}, but with this setting a waking task cannot jump the queue; it has to wait until ${nm(c.pid)} uses up its time for this round.`,
        );
        why.push(
          tr(
            `WAKEUP_PREEMPT 關掉了，check_preempt_wakeup() 不做任何事。${nm(w.pid)} 要等 ${nm(c.pid)} 在 tick 時用完 sched_slice（${dur(c.slice)}）。`,
            `WAKEUP_PREEMPT is off, so check_preempt_wakeup() does nothing. ${nm(w.pid)} has to wait until ${nm(c.pid)} uses up its sched_slice (${dur(c.slice)}) at a tick.`,
          ),
        );
      } else {
        plain = tr(
          `${nm(w.pid)} ${verb}了，但它沒有比 ${nm(c.pid)} 落後夠多（要差 10ms 以上），排程器不為它打斷 ${nm(c.pid)}，先排隊。`,
          `${nm(w.pid)} ${verb}, but it is not far enough behind ${nm(c.pid)} (it needs to be more than 10ms behind), so the scheduler does not interrupt ${nm(c.pid)} for it; it queues.`,
        );
        why.push(
          tr(
            `check_preempt_wakeup() 的條件是它的 vruntime 要比 ${nm(c.pid)} 小超過 wakeup_granularity（${dur(gran)}）。` +
              `現在只${diff >= 0 ? '小' : '大'} ${ms(Math.abs(diff))}，不搶佔。它要等 ${nm(c.pid)} 在 tick 時用完 sched_slice（${dur(c.slice)}）。`,
            `check_preempt_wakeup() requires its vruntime to be smaller than ${nm(c.pid)}'s by more than wakeup_granularity (${dur(gran)}). ` +
              `It is only ${ms(Math.abs(diff))} ${diff >= 0 ? 'smaller' : 'larger'}, so no preemption. It has to wait until ${nm(c.pid)} uses up its sched_slice (${dur(c.slice)}) at a tick.`,
          ),
        );
      }
    } else if (!w.eligible) {
      plain =
        on('PLACE_LAG') && e.cause === 'wakeup'
          ? tr(
              `${nm(w.pid)} 醒來了，但它之前拿的 CPU 比應得的多，這筆帳醒來還在，要等其他程式追上來才有資格跑。`,
              `${nm(w.pid)} wakes up, but it took more CPU than it was entitled to before; that debt is still there after waking, so it has to wait for the others to catch up before it may run.`,
            )
          : tr(`${nm(w.pid)} ${verb}了，但它現在多拿了一點，沒有資格被選。`, `${nm(w.pid)} ${verb}, but it is currently a little ahead of its share and may not be picked.`);
      why.push(
        tr(
          `${nm(w.pid)} ${verb}，place_entity() 把它放在 V ${sms(w.rel)}，也就是 lag = ${sms(-w.rel)}。`,
          `${nm(w.pid)} ${verb}; place_entity() puts it at V ${sms(w.rel)}, i.e. lag = ${sms(-w.rel)}.`,
        ),
      );
      why.push(
        (on('PLACE_LAG') && e.cause === 'wakeup'
          ? tr('這是它睡前帶走的 lag：之前拿的比應得的多。', 'This is the lag it took with it when it went to sleep: it had received more than it was entitled to. ')
          : '') +
          tr(
            `lag < 0 就不 eligible，pick_eevdf() 不會選它，${nm(c.pid)} 繼續跑。它要等 V 往右走過它的 vruntime 才有資格被選。`,
            `With lag < 0 it is not eligible, so pick_eevdf() will not pick it and ${nm(c.pid)} keeps running. It becomes eligible once V moves right past its vruntime.`,
          ),
      );
    } else {
      const earlier = w.dl! < c.dl!;
      plain = earlier
        ? tr(
            `${nm(w.pid)} 醒來了，有資格跑、截止時間也比 ${nm(c.pid)} 早，但規則是讓 ${nm(c.pid)} 先把手上這一小段跑完。`,
            `${nm(w.pid)} wakes up; it is eligible and its deadline is earlier than ${nm(c.pid)}'s, but the rule lets ${nm(c.pid)} finish the slice it is on first.`,
          )
        : tr(
            `${nm(w.pid)} 醒來了，有資格跑，但截止時間沒有比 ${nm(c.pid)} 早，${nm(c.pid)} 繼續跑。`,
            `${nm(w.pid)} wakes up and is eligible, but its deadline is not earlier than ${nm(c.pid)}'s, so ${nm(c.pid)} keeps running.`,
          );
      why.push(
        tr(
          `${nm(w.pid)} ${verb}，放在 V ${sms(w.rel)}（lag = ${sms(-w.rel)}），是 eligible 的；deadline 在 V ${sms(w.dl!)}，${nm(c.pid)} 的在 V ${sms(c.dl!)}。`,
          `${nm(w.pid)} ${verb} and is placed at V ${sms(w.rel)} (lag = ${sms(-w.rel)}), so it is eligible; its deadline is at V ${sms(w.dl!)}, ${nm(c.pid)}'s at V ${sms(c.dl!)}.`,
        ),
      );
      if (on('RUN_TO_PARITY') && c.parity && c.eligible) {
        why.push(
          tr(
            `${earlier ? `它的 deadline 比較早，但` : `它的 deadline 也沒有比較早，而且`} RUN_TO_PARITY 讓 ${nm(c.pid)} 把目前這個 slice 跑完，中途不重新比 deadline，所以沒有搶佔。`,
            `${earlier ? `Its deadline is earlier, but` : `Its deadline is not earlier either, and`} RUN_TO_PARITY lets ${nm(c.pid)} finish its current slice without comparing deadlines again, so there is no preemption.`,
          ) +
            (earlier && 'PREEMPT_SHORT' in ctx.flags && on('PREEMPT_SHORT') && w.slice >= c.slice
              ? tr(
                  `PREEMPT_SHORT 只幫 slice 比 curr 短的程式，${nm(w.pid)} 的 slice（${dur(w.slice)}）沒有比較短。`,
                  ` PREEMPT_SHORT only helps tasks whose slice is shorter than curr's, and ${nm(w.pid)}'s slice (${dur(w.slice)}) is not shorter.`,
                )
              : ''),
        );
      } else {
        const best = rows.filter((r) => r.eligible).sort((a, b) => a.dl! - b.dl!)[0];
        if (best && best.pid !== w.pid)
          plain = tr(
            `${nm(w.pid)} 醒來了，有資格跑，但 ${nm(best.pid)} 的截止時間更早，輪不到它。`,
            `${nm(w.pid)} wakes up and is eligible, but ${nm(best.pid)} has an earlier deadline, so it is not its turn.`,
          );
        why.push(
          best && best.pid !== w.pid
            ? tr(
                `eligible 的程式裡 deadline 最早的是 ${nm(best.pid)}（V ${sms(best.dl!)}），不是它，所以沒有搶佔。`,
                `Among the eligible tasks the earliest deadline belongs to ${nm(best.pid)} (V ${sms(best.dl!)}), not to it, so there is no preemption.`,
              )
            : tr(`check_preempt_wakeup() 試挑的結果不是它，沒有搶佔。`, `The trial pick in check_preempt_wakeup() does not choose it, so there is no preemption.`),
        );
      }
    }
    return { title, plain, why, rows, chosen: e.next };
  }

  // ---- schedule() 挑選 ----
  const title = e.prev === e.next ? tr(`重新挑選，還是 ${nm(e.next)}`, `Picked again, still ${nm(e.next)}`) : `${nm(e.prev)} → ${nm(e.next)}`;
  const p = row(e.prev);
  const w = row(e.causePid);
  const prevEvent = (() => {
    for (let i = idx - 1; i >= 0; i--) if (ctx.events[i]!.kind === 'pick') return ctx.events[i]!;
    return null;
  })();
  const ran = prevEvent && e.prev !== null && prevEvent.next === e.prev ? e.t - prevEvent.t : null;
  /** prev 的 deadline 剛被 update_deadline() 重發：deadline − vruntime 剛好是一個完整的 vslice */
  const renewed = eevdf && p ? Math.abs(p.dl! - p.rel - (p.slice * NICE_0_LOAD) / p.weight) <= 2 : false;
  const ranFor = (d: Ns | null) => (d !== null ? tr(`（這次跑了 ${dur(d)}）`, ` (it ran ${dur(d)} this time)`) : '');

  // 1. 為什麼這時候要重新排程（reason：白話摘要的前半句；preempted：摘要已經講完，不用再接後半句）
  let reason = tr('排程器重新挑選，', 'The scheduler picks again; ');
  let preempted = false;
  if (e.cause === 'sleep') {
    reason = tr(`${nm(e.causePid)} 做完這一段去睡了，CPU 空出來，`, `${nm(e.causePid)} finished this stretch and went to sleep, freeing the CPU; `);
    why.push(
      tr(
        `${nm(e.causePid)} 做完這一段去睡了${ranFor(ran)}，CPU 空出來，schedule() 要挑下一個。`,
        `${nm(e.causePid)} finished this stretch and went to sleep${ranFor(ran)}, freeing the CPU, so schedule() has to pick the next task.`,
      ),
    );
  } else if (e.cause === 'new') {
    reason = tr(`新程式 ${nm(e.causePid)} 加入，`, `A new task, ${nm(e.causePid)}, joins; `);
    why.push(
      tr(`新程式 ${nm(e.causePid)} 建立。`, `A new task, ${nm(e.causePid)}, is created. `) +
        (!eevdf && w
          ? tr(
              `place_entity() 把它放在 min_vruntime ${sms(w.rel)}${on('START_DEBIT') ? '（START_DEBIT：先欠一個 vslice）' : ''}，task_new_fair() 一律要求重新排程。`,
              `place_entity() puts it at min_vruntime ${sms(w.rel)}${on('START_DEBIT') ? ' (START_DEBIT: it starts one vslice in debt)' : ''}, and task_new_fair() always asks for a reschedule.`,
            )
          : ''),
    );
  } else if (e.cause === 'wakeup') {
    if (e.prev === null) {
      reason = tr(`CPU 閒著，${nm(e.causePid)} 醒來，`, `The CPU is idle and ${nm(e.causePid)} wakes up; `);
      why.push(tr(`${nm(e.causePid)} 醒來時 CPU 是閒的，直接重新排程。`, `The CPU is idle when ${nm(e.causePid)} wakes up, so it reschedules right away.`));
    } else if (!eevdf && w && p) {
      plain = tr(
        `${nm(w.pid)} 醒來，它比 ${nm(p.pid)} 落後超過 10ms，直接插隊。`,
        `${nm(w.pid)} wakes up more than 10ms behind ${nm(p.pid)} and jumps the queue right away.`,
      );
      reason = tr(
        `${nm(w.pid)} 醒來，它比 ${nm(p.pid)} 落後超過 10ms，要求重新排程，`,
        `${nm(w.pid)} wakes up more than 10ms behind ${nm(p.pid)} and asks for a reschedule; `,
      );
      preempted = e.next === w.pid;
      const gran = Math.round((WAKEUP_GRAN * NICE_0_LOAD) / p.weight);
      why.push(
        tr(
          `${nm(w.pid)} 醒來，place_entity() 把它放在 min_vruntime ${sms(w.rel)}。` +
            `它的 vruntime 比 ${nm(p.pid)} 小 ${ms(p.rel - w.rel)}，超過 wakeup_granularity（${dur(gran)}），check_preempt_wakeup() 要求立刻重新排程。`,
          `${nm(w.pid)} wakes up and place_entity() puts it at min_vruntime ${sms(w.rel)}. ` +
            `Its vruntime is ${ms(p.rel - w.rel)} smaller than ${nm(p.pid)}'s, more than wakeup_granularity (${dur(gran)}), so check_preempt_wakeup() asks for an immediate reschedule.`,
        ),
      );
    } else if (eevdf && w && p && e.next === w.pid) {
      plain = tr(
        `${nm(w.pid)} 醒來，它有資格跑，截止時間又是最早的，直接插隊 ${nm(p.pid)}。`,
        `${nm(w.pid)} wakes up; it is eligible and has the earliest deadline, so it preempts ${nm(p.pid)} right away.`,
      );
      preempted = true;
      why.push(
        tr(
          `${nm(w.pid)} 醒來，放在 V ${sms(w.rel)}（lag = ${sms(-w.rel)}）。check_preempt_wakeup() 用 pick_eevdf() 試挑一次，挑到的就是它，所以搶佔 ${nm(p.pid)}。`,
          `${nm(w.pid)} wakes up and is placed at V ${sms(w.rel)} (lag = ${sms(-w.rel)}). check_preempt_wakeup() does a trial pick with pick_eevdf(), which picks it, so it preempts ${nm(p.pid)}.`,
        ),
      );
      if (on('PREEMPT_SHORT') && 'PREEMPT_SHORT' in ctx.flags && p.parityCancelled && w.slice < p.slice) {
        plain += tr(
          `它要的 slice 比 ${nm(p.pid)} 短，所以可以打斷 ${nm(p.pid)} 正在跑的那一小段。`,
          ` Its slice is shorter than ${nm(p.pid)}'s, so it may interrupt the slice ${nm(p.pid)} is in the middle of.`,
        );
        why.push(
          tr(
            `它的 slice（${dur(w.slice)}）比 ${nm(p.pid)} 的（${dur(p.slice)}）短，PREEMPT_SHORT 先取消了 ${nm(p.pid)}「跑完這個 slice」的保護，否則 RUN_TO_PARITY 會讓 ${nm(p.pid)} 繼續跑。`,
            `Its slice (${dur(w.slice)}) is shorter than ${nm(p.pid)}'s (${dur(p.slice)}), so PREEMPT_SHORT first cancelled ${nm(p.pid)}'s "finish this slice" protection; otherwise RUN_TO_PARITY would have let ${nm(p.pid)} keep running.`,
          ),
        );
      }
    } else if (eevdf && p && renewed) {
      reason = tr(`${nm(p.pid)} 的這一小段剛好用完，`, `${nm(p.pid)} has just used up its slice; `);
      why.push(
        tr(
          `${nm(e.causePid)} 醒來時 update_curr() 順便結帳，發現 ${nm(p.pid)} 的 vruntime 已經走過 deadline，slice 用完了，要求重新排程。`,
          `When ${nm(e.causePid)} wakes up, update_curr() settles the accounts and finds that ${nm(p.pid)}'s vruntime has passed its deadline; the slice is used up, so it asks for a reschedule.`,
        ),
      );
    } else {
      reason = tr(`${nm(e.causePid)} 醒來，`, `${nm(e.causePid)} wakes up; `);
      why.push(tr(`${nm(e.causePid)} 醒來，觸發重新排程。`, `${nm(e.causePid)} wakes up, which triggers a reschedule.`));
    }
  } else if (!p) {
    why.push(tr('tick 時要求重新排程。', 'A reschedule is requested at a tick.'));
  } else if (!eevdf) {
    reason = tr(`${nm(p.pid)} 用完了這一輪分到的時間（${dur(p.slice)}），`, `${nm(p.pid)} has used up its time for this round (${dur(p.slice)}); `);
    why.push(
      tr(
        `tick 時 check_preempt_tick() 發現 ${nm(p.pid)} 這次上 CPU 已經跑了${ran !== null ? ` ${dur(ran)}` : '很久'}，` +
          `超過它的 sched_slice（${dur(p.slice)} = 20ms × 自己的權重 ÷ 總權重），要求重新排程。`,
        `At a tick, check_preempt_tick() finds that ${nm(p.pid)} has been on the CPU for ${ran !== null ? dur(ran) : 'a long time'}, ` +
          `more than its sched_slice (${dur(p.slice)} = 20ms × own weight ÷ total weight), so it asks for a reschedule.`,
      ),
    );
  } else if (renewed) {
    reason = tr(`${nm(p.pid)} 用完了這一小段（${dur(p.slice)}），`, `${nm(p.pid)} has used up its slice (${dur(p.slice)}); `);
    why.push(
      tr(
        `tick 時 update_curr() 發現 ${nm(p.pid)} 的 vruntime 走過了 deadline，這個 slice（${dur(p.slice)}）用完了。` +
          `update_deadline() 發給它下一個 deadline（V ${sms(p.dl!)}），並要求重新排程。`,
        `At a tick, update_curr() finds that ${nm(p.pid)}'s vruntime has passed its deadline; this slice (${dur(p.slice)}) is used up. ` +
          `update_deadline() gives it the next deadline (V ${sms(p.dl!)}) and asks for a reschedule.`,
      ) +
        (ran !== null && ran > p.slice
          ? tr(`它這次連續跑了 ${dur(ran)}，比 slice 長，因為只有 1ms 一次的 tick 會檢查。`, ` It ran ${dur(ran)} in a row this time, longer than the slice, because only the 1ms tick checks.`)
          : ''),
    );
  } else if ('PREEMPT_SHORT' in ctx.flags && on('PREEMPT_SHORT') && !p.eligible) {
    reason = tr(`${nm(p.pid)} 已經多拿了，又被取消了「跑完這一段」的保護，`, `${nm(p.pid)} is already ahead of its share and has lost its "finish this slice" protection; `);
    why.push(
      tr(
        `tick 時 ${nm(p.pid)} 已經不 eligible（lag = ${sms(-p.rel)}），而它「跑完這個 slice」的保護先前被 PREEMPT_SHORT 取消了，update_curr() 要求重新排程。`,
        `At a tick ${nm(p.pid)} is no longer eligible (lag = ${sms(-p.rel)}), and its "finish this slice" protection was cancelled earlier by PREEMPT_SHORT, so update_curr() asks for a reschedule.`,
      ),
    );
  } else {
    why.push(tr('tick 時要求重新排程。', 'A reschedule is requested at a tick.'));
  }

  // 2. 為什麼挑到 next
  const chosen = row(e.next);
  let choice = tr(`換 ${nm(e.next)}。`, `${nm(e.next)} runs next.`);
  if (e.next === null) choice = tr('沒有程式想跑，CPU 閒著。', 'no task wants to run, so the CPU is idle.');
  else if (rows.length === 1) choice = tr(`只有 ${nm(e.next)} 想跑。`, `only ${nm(e.next)} wants to run.`);
  else if (e.prev === e.next) choice = tr(`重新比一次，還是 ${nm(e.next)} 最該跑，它繼續跑。`, `comparing again, ${nm(e.next)} is still the one that should run, so it keeps running.`);
  else if (!eevdf) choice = tr(`換 ${nm(e.next)}：按權重換算，它到目前為止跑得最少。`, `${nm(e.next)} runs next: relative to its weight, it has run the least so far.`);
  else choice = tr(`換 ${nm(e.next)}：在沒有多拿的程式裡，它的截止時間最早。`, `${nm(e.next)} runs next: among the tasks not ahead of their share, it has the earliest deadline.`);
  if (!preempted) plain = reason + choice;
  if (e.next === null) {
    why.push(tr('沒有程式想跑，CPU 閒置。', 'No task wants to run; the CPU goes idle.'));
  } else if (!chosen) {
    why.push(tr(`選中 ${nm(e.next)}。`, `${nm(e.next)} is picked.`));
  } else if (!eevdf) {
    const leftmost = rows.every((r) => r.rel >= chosen.rel);
    why.push(
      rows.length === 1
        ? tr(`只有 ${nm(chosen.pid)} 想跑。`, `Only ${nm(chosen.pid)} wants to run.`)
        : leftmost
          ? tr(
              `__pick_next_entity() 拿紅黑樹最左邊的，也就是 vruntime 最小的：${nm(chosen.pid)}（min_vruntime ${sms(chosen.rel)}）。`,
              `__pick_next_entity() takes the leftmost entry of the red-black tree, the one with the smallest vruntime: ${nm(chosen.pid)} (min_vruntime ${sms(chosen.rel)}).`,
            )
          : tr(`選中 ${nm(chosen.pid)}。`, `${nm(chosen.pid)} is picked.`),
    );
  } else {
    // 被選中時才真正離開的 delayed entity：在 before 裡、不在 after 裡
    const gone = rowsOf(e.before).filter((r) => r.delayed && !row(r.pid));
    for (const g of gone) {
      why.push(
        tr(
          `pick_eevdf() 先挑到 ${nm(g.pid)}：它其實已經睡著，睡前 lag 是負的，被 DELAY_DEQUEUE 留在佇列上。` +
            `現在它變成 eligible 又被挑到，表示多拿的已經還完，這時才真正離開佇列（DELAY_ZERO 把剩下的正 lag 歸零），然後重挑。`,
          `pick_eevdf() first picks ${nm(g.pid)}: it is actually asleep, but its lag was negative when it went to sleep, so DELAY_DEQUEUE kept it on the queue. ` +
            `Now it is eligible and gets picked, meaning the excess has been paid back, so only now does it really leave the queue (DELAY_ZERO resets any remaining positive lag to zero), and the pick is repeated.`,
        ),
      );
    }
    const elig = rows.filter((r) => r.eligible);
    const inel = rows.filter((r) => !r.eligible);
    const best = [...elig].sort((a, b) => a.dl! - b.dl!)[0];
    const ties = elig.filter((r) => best && r.dl === best.dl);
    const negLag = inel.length ? tr(`，${list(inel)} 的 lag 是負的，不能選`, `; ${list(inel)} ${inel.length > 1 ? 'have' : 'has'} negative lag and cannot be picked`) : '';
    if (rows.length === 1) {
      why.push(tr(`只有 ${nm(chosen.pid)} 想跑。`, `Only ${nm(chosen.pid)} wants to run.`));
    } else if (ties.length > 1 && ties.includes(chosen)) {
      why.push(
        tr(`pick_eevdf() 的規則：先看誰 eligible（lag ≥ 0）`, `pick_eevdf()'s rule: first, who is eligible (lag ≥ 0)`) +
          negLag +
          tr(
            `。${list(ties)} 的 deadline 一樣早（V ${sms(chosen.dl!)}），平手。模擬器取紅黑樹裡排在前面的 ${nm(chosen.pid)}；kernel 在平手時的結果取決於樹的形狀。`,
            `. ${list(ties)} have equally early deadlines (V ${sms(chosen.dl!)}), a tie. The simulator takes ${nm(chosen.pid)}, which comes first in the red-black tree; in the kernel the outcome of a tie depends on the shape of the tree.`,
          ),
      );
    } else if (best && best.pid === chosen.pid) {
      why.push(
        tr(`pick_eevdf() 的規則：先看誰 eligible（lag ≥ 0，也就是 vruntime 在 V 左邊）`, `pick_eevdf()'s rule: first, who is eligible (lag ≥ 0, i.e. vruntime left of V)`) +
          (inel.length ? negLag : tr('，現在全部都是', '; right now everyone is')) +
          tr('。', '. ') +
          (elig.length > 1
            ? tr(
                `剩下的 ${list(elig)} 裡 deadline 最早的是 ${nm(chosen.pid)}（V ${sms(chosen.dl!)}）。`,
                `Of the remaining ${list(elig)}, the earliest deadline is ${nm(chosen.pid)}'s (V ${sms(chosen.dl!)}).`,
              )
            : tr(`只剩 ${nm(chosen.pid)} 可以選。`, `Only ${nm(chosen.pid)} is left to pick.`)),
      );
    } else {
      why.push(tr(`選中 ${nm(chosen.pid)}。`, `${nm(chosen.pid)} is picked.`));
    }
    const stay = rows.filter((r) => r.delayed);
    if (stay.length) {
      why.push(
        tr(
          `${list(stay)} 已經睡著，但睡前 lag 是負的，DELAY_DEQUEUE 把它留在佇列上：它仍然算進 V，等它變成 eligible 被挑到時才真正離開。`,
          `${list(stay)} ${stay.length > 1 ? 'are' : 'is'} asleep, but went to sleep with negative lag, so DELAY_DEQUEUE keeps ${stay.length > 1 ? 'them' : 'it'} on the queue: still counted in V, and only really leaving once eligible and picked.`,
        ),
      );
    }
  }
  if (e.prev === e.next && e.next !== null && rows.length > 1)
    why.push(tr('重新挑的結果還是同一個，沒有 context switch。', 'The new pick is the same task, so there is no context switch.'));

  return { title, plain, why, rows, chosen: e.next };
}

// ---------------------------------------------------------------------------
// 數線：每個 task 一列，圓點是 vruntime，EEVDF 另外畫到 deadline 的線段

function numberLine(ctx: InspectCtx, x: Explained): string {
  const { rows } = x;
  if (!rows.length) return '';
  const paper = ctx.family === 'paper';
  const eevdf = ctx.family === 'eevdf' || paper;
  const W = 640;
  const LABEL = 92;
  const R = 28;
  const LANE = 18;
  const top = 6;
  const H = top + rows.length * LANE + 30;
  const span = Math.max(0.2 * MS, ...rows.flatMap((r) => [Math.abs(r.rel), Math.abs(r.dl ?? 0)])) * 1.12;
  const X = (v: number) => LABEL + ((v + span) / (2 * span)) * (W - LABEL - R);
  const axisY = top + rows.length * LANE + 4;

  const aria = tr(`各程式相對 ${eevdf ? 'V' : 'min_vruntime'} 的位置`, `Position of each task relative to ${eevdf ? 'V' : 'min_vruntime'}`);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${aria}">`;
  if (eevdf) svg += `<rect class="elig" x="${LABEL}" y="${top - 2}" width="${X(0) - LABEL}" height="${rows.length * LANE + 4}"/>`;
  svg += `<line class="ref" x1="${X(0)}" x2="${X(0)}" y1="${top - 2}" y2="${axisY + 4}"/>`;
  svg += `<line class="axis" x1="${LABEL}" x2="${W - R}" y1="${axisY}" y2="${axisY}"/>`;
  for (const v of [-span / 1.12, span / 1.12]) {
    svg += `<line class="axis" x1="${X(v)}" x2="${X(v)}" y1="${axisY - 3}" y2="${axisY + 3}"/>`;
    svg += `<text class="tl" x="${X(v)}" y="${axisY + 16}" text-anchor="middle">${sms(v, 2)}</text>`;
  }
  svg += `<text class="tl refl" x="${X(0)}" y="${axisY + 16}" text-anchor="middle">${eevdf ? 'V' : 'min_vruntime'}</text>`;
  if (eevdf) svg += `<text class="tl" x="${(LABEL + X(0)) / 2}" y="${axisY + 16}" text-anchor="middle">${tr('eligible（lag ≥ 0）', 'eligible (lag ≥ 0)')}</text>`;

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
  const legend = paper
    ? tr(
        '每一列是一個在競爭的程式，線段是它目前的 request：左端的圓點是 virtual eligible time（ve），右端的直槓是 virtual deadline（vd），虛線是 V。ve 在 V 左邊（綠色區域）的 request 是 eligible 的；其中直槓最靠左的拿到下一個 quantum（紫圈）。',
        'Each row is a competing task and the segment is its current request: the dot at the left end is the virtual eligible time (ve), the bar at the right end is the virtual deadline (vd), and the dashed line is V. A request whose ve is left of V (green area) is eligible; among those the leftmost bar gets the next quantum (purple ring).',
      )
    : eevdf
    ? tr(
        '每一列是一個想跑的程式。圓點是它的 vruntime，虛線是 V。圓點在 V 左邊（綠色區域）表示 lag ≥ 0、沒有多拿，有資格被選；在右邊、畫成空心的表示多拿了，要等。線段右端的直槓是 deadline，有資格的程式裡直槓最靠左的被選中（紫圈）。',
        'Each row is a runnable task. The dot is its vruntime and the dashed line is V. A dot left of V (green area) means lag ≥ 0, not ahead of its share, so it may be picked; a hollow dot on the right has taken too much and must wait. The bar at the right end of each segment is the deadline; among eligible tasks the leftmost bar is picked (purple ring).',
      )
    : tr(
        '每一列是一個想跑的程式，圓點是它的 vruntime，虛線是 min_vruntime。CFS 的規則只有一條：圓點最靠左（按權重算跑得最少）的被選中（紫圈）。',
        'Each row is a runnable task; the dot is its vruntime and the dashed line is min_vruntime. CFS has a single rule: the leftmost dot (least run, relative to weight) is picked (purple ring).',
      );
  return `<div class="insp-line">${svg}<div class="insp-legend">${legend}</div></div>`;
}

function table(ctx: InspectCtx, x: Explained, e: SchedEvent): string {
  const paper = ctx.family === 'paper';
  const eevdf = ctx.family === 'eevdf' || paper;
  const state = (r: Row) => {
    if (r.delayed) return tr('已睡著（delayed）', 'asleep (delayed)');
    return taskState(x, e, r.pid);
  };
  const body = x.rows
    .map((r) => {
      const name = `<span class="swatch" style="background:${ctx.color(r.pid - 1)}"></span>${esc(ctx.names[r.pid - 1] ?? '')}`;
      const cls = r.pid === x.chosen ? ' class="chosen"' : '';
      return eevdf
        ? `<tr${cls}><td>${name}</td><td>${state(r)}</td><td>${sms(paper ? r.rel : -r.rel)}</td><td>${r.eligible ? tr('是', 'yes') : tr('否', 'no')}</td><td>${sms(r.dl!)}</td><td>${dur(r.slice)}</td></tr>`
        : `<tr${cls}><td>${name}</td><td>${state(r)}</td><td>${sms(r.rel)}</td><td>${dur(r.slice)}</td></tr>`;
    })
    .join('');
  const head = paper
    ? `<th>${tr('程式', 'Task')}</th><th>${tr('狀態', 'State')}</th><th>ve − V</th><th>${term('eligible')}</th><th>vd − V</th><th>${tr('request 長度 r', 'request length r')}</th>`
    : eevdf
    ? `<th>${tr('程式', 'Task')}</th><th>${tr('狀態', 'State')}</th><th>${term('lag')}${tr('（V − vruntime）', ' (V − vruntime)')}</th><th>${term('eligible')}</th><th>${term('deadline')} − V</th><th>${term('slice')}</th>`
    : `<th>${tr('程式', 'Task')}</th><th>${tr('狀態', 'State')}</th><th>${term('vruntime')} − ${term('min_vruntime')}</th><th>${term('sched_slice')}</th>`;
  const asleep = ctx.names.filter((_, i) => !x.rows.some((r) => r.pid === i + 1));
  const foot =
    (asleep.length ? tr(`睡覺中、不在佇列上：${joinList(asleep.map(esc))}。`, `Asleep, not on the queue: ${joinList(asleep.map(esc))}. `) : '') +
    (paper
      ? tr(
          '論文的 V 是精確累加的實數，加入與離開時照式 (18)、(19) 調整；ve − V ≤ 0 的 request 才 eligible。',
          "The paper's V is an exact real-valued sum, adjusted on join and leave by Eqs. (18) and (19); a request is eligible only when ve − V ≤ 0.",
        )
      : eevdf
      ? tr(
          '這裡的 lag 是 kernel 自己用 V（vruntime 的加權平均）算的，單位是虛擬時間；下面那張圖的 lag 是照 GPS 另外算的，兩者不是同一個數字。',
          'The lag here is what the kernel itself computes from V (the weighted average of vruntime), in virtual time; the lag in the chart below is computed separately from GPS, and the two are not the same number.',
        )
      : tr('CFS 沒有 lag 這個量，只比 vruntime。', 'CFS has no notion of lag; it only compares vruntime.'));
  return `<table class="insp-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table><p class="note">${foot}</p>`;
}

/** 決策檢視的 HTML（不含上一個 / 下一個按鈕） */
export function renderDecision(ctx: InspectCtx, idx: number, detailOpen = true): { title: string; html: string } {
  const e = ctx.events[idx]!;
  const x = explain(ctx, idx);
  const seen = new Set<string>();
  return {
    title: `t = ${ms(e.t)}${gap}${x.title}`,
    html: `<p class="insp-plain">${linkTerms(esc(x.plain))}</p>
      <details class="insp-detail"${detailOpen ? ' open' : ''}><summary>${tr('排程器實際比了什麼', 'What the scheduler actually compared')}</summary>
        <div class="insp-why">${x.why.map((s) => `<p>${linkTerms(esc(s), seen)}</p>`).join('')}</div>${isLegacy(ctx) ? legacyDetail(ctx, idx, x) : numberLine(ctx, x) + table(ctx, x, e)}
      </details>`,
  };
}
