// O(n) 排程器，對齊 Linux 2.4.0 kernel/sched.c。
// 註解中的「:行號」都指 kernel-src/v2.4.0/kernel/sched.c，timer.c / fork.c 另外標明。
//
// 只有一條全域的 runqueue（雙向鏈結串列）。每次 schedule() 走過整條串列，對每個 task 算 goodness()，
// 選最大的：成本和可執行的 task 數量成正比。每個 task 有 counter（剩下幾個 tick），
// tick 時扣 1；所有可執行的 task 都用完（goodness 最大是 0）時，對「系統裡每一個 task」重算：
//   counter = counter / 2 + NICE_TO_TICKS(nice)
// 睡著的 task 沒用掉的 counter 會留一半，所以常睡的 task counter 比較高、goodness 比較大，
// 這就是 2.4 唯一的互動性機制。
//
// 省略：SMP（PROC_CHANGE_PENALTY、reschedule_idle 找空閒 CPU）、RT（SCHED_FIFO / SCHED_RR）、SCHED_YIELD。
// 簡化：fork 時假設 parent 的 counter 是滿的 NICE_TO_TICKS(nice)（見 task_new）。

import { resched_task, charge, type Ns, type Rq, type SchedClass, type Task } from '../core/types.ts';

export interface OnTunables {
  /** CONFIG_HZ。2.4.0 i386 是 100（include/asm-i386/param.h），一個 tick 10ms */
  hz: number;
  features: {
    /** recalculate: 用 for_each_task 重算所有 task（含睡著的）。關掉時只重算 runqueue 上的（模擬器開關，kernel 沒有） */
    for_each_task: boolean;
  };
}

export const defaultTunables: OnTunables = { hz: 100, features: { for_each_task: true } };

/** TICK_SCALE(x)（:55）：依 HZ 把 nice 換算成 tick，讓時間片大約 50ms */
export function TICK_SCALE(hz: number, x: number): number {
  if (hz < 200) return x >> 2;
  if (hz < 400) return x >> 1;
  if (hz < 800) return x;
  if (hz < 1600) return x << 1;
  return x << 2;
}

/** NICE_TO_TICKS(nice)（:67）：HZ=100 時 nice 0 → 6 tick（60ms），−20 → 11，19 → 1 */
export function NICE_TO_TICKS(hz: number, nice: number): number {
  return TICK_SCALE(hz, 20 - nice) + 1;
}

/** task_struct 裡 2.4 排程器的欄位（include/linux/sched.h） */
export interface OnEntity {
  counter: number;
  /** 在 runqueue 串列上（task_on_runqueue） */
  on_rq: boolean;
  /** fork 之後才存在於 tasklist（for_each_task 走得到） */
  exists: boolean;
  readonly task: Task<OnEntity>;
}

/**
 * goodness()（:137）。this_mm 是「現在這個 CPU 上的 mm」：prev 自己的 mm，
 * prev 是 idle 時是 idle 借來的 mm（lazy TLB，也就是上一個 user task 的）。
 * 每個 user task 有自己的 mm，所以 mm 相同 ⇔ 同一個 task。
 */
export function goodness(counter: number, nice: number, pid: number, this_mm: number | null): number {
  let weight = counter;
  if (!weight) return 0;
  if (pid === this_mm) weight += 1;
  weight += 20 - nice;
  return weight;
}

export interface OnTaskView {
  pid: number;
  name: string;
  nice: number;
  counter: number;
  /** 完整的時間片（tick） */
  full: number;
  /** 用 pick_mm 算的 goodness */
  goodness: number;
  /** 在 runqueue 串列裡的位置（0 = 頭） */
  pos: number;
  curr: boolean;
}

export interface OnSnapshot {
  kind: 'on';
  clock: Ns;
  tick_ns: Ns;
  /** 最近一次 schedule() 用的 this_mm（goodness 的 +1 給誰） */
  pick_mm: number | null;
  /** runqueue 串列順序（頭在前） */
  runqueue: number[];
  tasks: OnTaskView[];
  /** 睡著的 task 的 counter，給「睡越久 counter 越高」用 */
  sleepers: { pid: number; counter: number; full: number }[];
  /** 累計重算 counter 的次數 */
  recalcs: number;
  /** 最近一次 schedule() 呼叫了幾次 goodness() */
  last_scan: number;
}

export class OnV2_4_0 implements SchedClass<OnEntity> {
  readonly id = 'on-v2.4.0';
  /** runqueue_head：串列頭在 index 0 */
  private readonly runqueue: Task<OnEntity>[] = [];
  /** tasklist（init_task 串起來的所有 task） */
  private readonly tasks: Task<OnEntity>[] = [];
  /** put_prev_task 記下的 prev，給 pick_next_task 判斷 still_running */
  private prev: Task<OnEntity> | null = null;
  /** idle 借用的 mm：最後一個跑過的 user task */
  private last_mm: number | null = null;
  private pick_mm: number | null = null;
  private curr: Task<OnEntity> | null = null;
  private recalcs = 0;
  private last_scan = 0;

  constructor(readonly tun: OnTunables = defaultTunables) {}

  NICE_TO_TICKS(nice: number): number {
    return NICE_TO_TICKS(this.tun.hz, nice);
  }

  init_entity(p: Task<OnEntity>): OnEntity {
    return { counter: 0, on_rq: false, exists: false, task: p };
  }

  /** add_to_runqueue()（:303）：加在串列的「頭」 */
  private add_to_runqueue(rq: Rq<OnEntity>, p: Task<OnEntity>): void {
    charge(rq, 'queue', 1);
    this.runqueue.unshift(p);
    p.se.on_rq = true;
  }

  /** del_from_runqueue()（include/linux/sched.h） */
  private del_from_runqueue(rq: Rq<OnEntity>, p: Task<OnEntity>): void {
    charge(rq, 'queue', 1);
    this.runqueue.splice(this.runqueue.indexOf(p), 1);
    p.se.on_rq = false;
  }

  private g(p: Task<OnEntity>, this_mm: number | null): number {
    return goodness(p.se.counter, p.nice, p.pid, this_mm);
  }

  // ---- sched_class 介面 --------------------------------------------------

  /** wake_up_process()（:329）的 add_to_runqueue 部分 */
  enqueue_task(rq: Rq<OnEntity>, p: Task<OnEntity>, _wakeup: boolean): void {
    if (p.se.on_rq) return;
    this.add_to_runqueue(rq, p);
  }

  /** schedule() 的 switch (prev->state) → del_from_runqueue(prev) */
  dequeue_task(rq: Rq<OnEntity>, p: Task<OnEntity>, _sleep: boolean): void {
    this.del_from_runqueue(rq, p);
  }

  /**
   * reschedule_idle()（:205，UP 版 :287）：preemption_goodness(curr, p) > 1 才搶佔。
   * this_mm 是 curr 的，所以 curr 自己多 1 分。
   */
  check_preempt_curr(rq: Rq<OnEntity>, p: Task<OnEntity>): void {
    const curr = rq.curr;
    if (!curr) return;
    const gp = this.g(p, curr.pid);
    const gc = this.g(curr, curr.pid);
    const preempt = gp - gc > 1;
    rq.trace.log(rq.clock, 'reschedule_idle', p.pid, { goodness: gp, curr: curr.pid, curr_goodness: gc, preempt });
    if (preempt) resched_task(rq);
  }

  put_prev_task(_rq: Rq<OnEntity>, prev: Task<OnEntity>): void {
    this.prev = prev;
  }

  /** schedule()（:508）的 repeat_schedule: 到 recalculate: */
  pick_next_task(rq: Rq<OnEntity>): Task<OnEntity> | null {
    const prev = this.prev;
    this.prev = null;
    const this_mm = prev ? prev.pid : this.last_mm;
    this.pick_mm = this_mm;
    let scan = 0;

    for (;;) {
      const scan0 = scan;
      let next: Task<OnEntity> | null = null; // idle_task
      let c = -1000;
      if (prev && prev.state === 'RUNNING') {
        // still_running: prev 先當候選，平手時留下 prev
        c = this.g(prev, this_mm);
        next = prev;
        scan++;
      }
      for (const p of this.runqueue) {
        scan++;
        const weight = this.g(p, this_mm);
        if (weight > c) {
          c = weight;
          next = p;
        }
      }
      charge(rq, 'pick', scan - scan0);
      if (c !== 0) {
        if (next) this.last_mm = next.pid;
        this.curr = next;
        this.last_scan = scan;
        rq.trace.log(rq.clock, 'schedule', next?.pid, { goodness: c, scanned: scan });
        return next;
      }
      // recalculate:（:658）所有 task 都重算，包括睡著的
      this.recalcs++;
      const all = this.tun.features.for_each_task ? this.tasks : this.runqueue;
      for (const p of all) p.se.counter = (p.se.counter >> 1) + this.NICE_TO_TICKS(p.nice);
      charge(rq, 'recalc', all.length);
      rq.trace.log(rq.clock, 'recalculate', undefined, { tasks: all.length });
    }
  }

  /** update_process_times()（timer.c:580）：每個 tick 扣 1，扣到 0 就要求重新排程 */
  task_tick(rq: Rq<OnEntity>, p: Task<OnEntity>): void {
    if (--p.se.counter <= 0) {
      p.se.counter = 0;
      resched_task(rq);
    }
  }

  /**
   * do_fork()（fork.c:672）：child 拿 parent 剩下 counter 的一半，然後 wake_up_process(p)。
   * 簡化：parent 的 counter 是滿的 NICE_TO_TICKS(nice)，nice 和 child 相同。
   */
  task_new(rq: Rq<OnEntity>, p: Task<OnEntity>): void {
    p.se.counter = (this.NICE_TO_TICKS(p.nice) + 1) >> 1;
    p.se.exists = true;
    this.tasks.push(p); // SET_LINKS
    this.add_to_runqueue(rq, p);
    rq.trace.log(rq.clock, 'do_fork', p.pid, { counter: p.se.counter });
  }

  snapshot(rq: Rq<OnEntity>): OnSnapshot {
    const view = (t: Task<OnEntity>, pos: number): OnTaskView => ({
      pid: t.pid,
      name: t.name,
      nice: t.nice,
      counter: t.se.counter,
      full: this.NICE_TO_TICKS(t.nice),
      goodness: this.g(t, this.pick_mm),
      pos,
      curr: this.curr === t,
    });
    return {
      kind: 'on',
      clock: rq.clock,
      tick_ns: rq.tick_nsec,
      pick_mm: this.pick_mm,
      runqueue: this.runqueue.map((t) => t.pid),
      tasks: this.runqueue.map(view).sort((a, b) => a.pid - b.pid),
      sleepers: this.tasks.filter((t) => !t.se.on_rq).map((t) => ({ pid: t.pid, counter: t.se.counter, full: this.NICE_TO_TICKS(t.nice) })),
      recalcs: this.recalcs,
      last_scan: this.last_scan,
    };
  }
}
