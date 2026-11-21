// O(1) 排程器，對齊 Linux 2.6.0 kernel/sched.c（Ingo Molnar 2002；互動性調整 Con Kolivas 2003）。
// 函式名稱、順序、巨集和原始碼一一對應；註解中的「:行號」都指 kernel-src/v2.6.0/kernel/sched.c。
//
// 核心是兩個 prio_array（active / expired）：每個優先權一條 FIFO 佇列加一張 bitmap，
// 挑選 = 找 bitmap 第一個 1（sched_find_first_bit），跟 task 數量無關。
// 時間片用完就搬到 expired；active 空了就把兩個指標互換。
// 互動性靠 sleep_avg：睡越多 bonus 越高（優先權 ±5），夠互動的 task 用完時間片還能留在 active。
//
// 省略：SMP / NUMA load balancing、RT class、sched_exit() 把時間片還給 parent、
// TASK_UNINTERRUPTIBLE（activated = -1）、set_user_nice()。
// 簡化：工作負載的 task 沒有真的 parent，fork 時假設 parent 是一個 sleep_avg 滿的 shell（見 task_new）。
// 模擬器的開關（features）不是 kernel 的設定，2.6.0 沒有 sched_feat；關掉是為了看少了它會怎樣。

import { NSEC_PER_SEC, resched_task, charge, type Ns, type Rq, type SchedClass, type Task } from '../core/types.ts';
import { MAX_RT_PRIO } from '../core/weights.ts';

// ---------------------------------------------------------------------------
// 巨集（:48–:166）。數值都是 jiffies，除了名字有 NS_ 的。C 的整數除法：正數 floor，負數往 0 截斷。

const MAX_PRIO = MAX_RT_PRIO + 40;
const MAX_USER_PRIO = 40; // USER_PRIO(MAX_PRIO)
const PRIO_BONUS_RATIO = 25;
const MAX_BONUS = Math.trunc((MAX_USER_PRIO * PRIO_BONUS_RATIO) / 100); // 10
const INTERACTIVE_DELTA = 2;
const ON_RUNQUEUE_WEIGHT = 30;
const CHILD_PENALTY = 95;
const CREDIT_LIMIT = 100;
const NICE_TO_PRIO_0 = MAX_RT_PRIO + 20;

const idiv = (a: number, b: number) => Math.trunc(a / b);
/** unsigned long 在 i386 是 32 位元 */
const U32 = 2 ** 32;

export interface O1Tunables {
  /** CONFIG_HZ。2.6.0 i386 是 1000（include/asm-i386/param.h） */
  hz: number;
  /** sizeof(unsigned long) × 8。i386 是 32：recalc_task_prio() 的 sleep_time 乘上倍數時會溢位 */
  bits_per_long: 32 | 64;
  /** 計時器、硬體中斷叫醒的 task 是 activated = 2（排隊時間全額算成睡眠）；被別的 process 叫醒是 1（打 3 折） */
  wake_from_interrupt: boolean;
  /** fork 時假設的 parent sleep_avg（ns）。shell 大多在等輸入，預設是滿的 */
  parent_sleep_avg: Ns | 'max';
  features: {
    /** effective_prio() 的 ±5 bonus。關掉時 prio = static_prio */
    sleep_avg: boolean;
    /** TASK_INTERACTIVE 的 task 用完時間片時放回 active，而不是 expired */
    TASK_INTERACTIVE: boolean;
    /** expired 裡的 task 等太久時，互動型的也要去 expired（防 starvation） */
    EXPIRED_STARVING: boolean;
    /** 互動型 task 的長時間片切成 TIMESLICE_GRANULARITY 一段，同優先權輪流 */
    TIMESLICE_GRANULARITY: boolean;
  };
}

export const defaultTunables: O1Tunables = {
  hz: 1000,
  bits_per_long: 32,
  wake_from_interrupt: true,
  parent_sleep_avg: 'max',
  features: { sleep_avg: true, TASK_INTERACTIVE: true, EXPIRED_STARVING: true, TIMESLICE_GRANULARITY: true },
};

/** 由 HZ 算出來的常數（:63–:93） */
export class O1Params {
  readonly MIN_TIMESLICE: number;
  readonly MAX_TIMESLICE: number;
  readonly AVG_TIMESLICE: number;
  readonly MAX_SLEEP_AVG: number;
  readonly STARVATION_LIMIT: number;
  readonly NS_MAX_SLEEP_AVG: Ns;
  readonly ns_per_jiffy: Ns;

  constructor(readonly hz: number) {
    this.MIN_TIMESLICE = Math.max(1, idiv(10 * hz, 1000));
    this.MAX_TIMESLICE = idiv(200 * hz, 1000);
    this.AVG_TIMESLICE =
      this.MIN_TIMESLICE + idiv((this.MAX_TIMESLICE - this.MIN_TIMESLICE) * (MAX_PRIO - 1 - NICE_TO_PRIO_0), MAX_USER_PRIO - 1);
    this.MAX_SLEEP_AVG = this.AVG_TIMESLICE * MAX_BONUS;
    this.STARVATION_LIMIT = this.MAX_SLEEP_AVG;
    this.ns_per_jiffy = idiv(NSEC_PER_SEC, hz);
    this.NS_MAX_SLEEP_AVG = this.JIFFIES_TO_NS(this.MAX_SLEEP_AVG);
  }

  NS_TO_JIFFIES(t: Ns): number {
    return Math.floor(t / this.ns_per_jiffy);
  }
  JIFFIES_TO_NS(j: number): Ns {
    return j * this.ns_per_jiffy;
  }

  /** BASE_TIMESLICE / task_timeslice()（:170）：nice −20 → 200ms，0 → 102ms，19 → 10ms */
  task_timeslice(static_prio: number): number {
    return this.MIN_TIMESLICE + idiv((this.MAX_TIMESLICE - this.MIN_TIMESLICE) * (MAX_PRIO - 1 - static_prio), MAX_USER_PRIO - 1);
  }

  /** CURRENT_BONUS(p)（:120）：sleep_avg 換算成 0..MAX_BONUS */
  CURRENT_BONUS(sleep_avg: Ns): number {
    return idiv(this.NS_TO_JIFFIES(sleep_avg) * MAX_BONUS, this.MAX_SLEEP_AVG);
  }

  /** TIMESLICE_GRANULARITY(p)（:129，UP 版） */
  TIMESLICE_GRANULARITY(sleep_avg: Ns): number {
    const k = MAX_BONUS - this.CURRENT_BONUS(sleep_avg) || 1;
    return this.MIN_TIMESLICE * (1 << (k - 1));
  }

  /** DELTA(p)（:137）：nice 0 是 2，nice −20 是 −3，nice 19 是 6 */
  DELTA(static_prio: number): number {
    const nice = static_prio - NICE_TO_PRIO_0;
    return idiv(nice * idiv(MAX_USER_PRIO * PRIO_BONUS_RATIO, 100), 40) + INTERACTIVE_DELTA;
  }

  /** JUST_INTERACTIVE_SLEEP(p)（:144）：睡超過這麼久就直接當成互動型（nice 0：815ms） */
  JUST_INTERACTIVE_SLEEP(static_prio: number): Ns {
    return this.JIFFIES_TO_NS(idiv(this.MAX_SLEEP_AVG * (idiv(MAX_BONUS, 2) + this.DELTA(static_prio) + 1), MAX_BONUS) - 1);
  }
}

// ---------------------------------------------------------------------------
// 資料結構

/** struct prio_array（:193） */
export interface PrioArray {
  readonly name: 'arrays[0]' | 'arrays[1]';
  nr_active: number;
  /** BITMAP_SIZE 個 unsigned long；這裡用一個 boolean 代表一個 bit */
  bitmap: boolean[];
  /** queue[MAX_PRIO]，每條是 FIFO */
  queue: Task<O1Entity>[][];
}

/** task_struct 裡 O(1) 排程器的欄位（include/linux/sched.h:340） */
export interface O1Entity {
  prio: number;
  array: PrioArray | null;
  sleep_avg: Ns;
  interactive_credit: number;
  timestamp: Ns;
  activated: number;
  /** 剩下幾個 tick */
  time_slice: number;
  first_time_slice: boolean;
  readonly task: Task<O1Entity>;
}

export interface O1TaskView {
  pid: number;
  name: string;
  static_prio: number;
  prio: number;
  /** CURRENT_BONUS − MAX_BONUS/2，−5..+5 */
  bonus: number;
  sleep_avg: Ns;
  /** 剩下的時間片（tick） */
  time_slice: number;
  /** 完整時間片（tick） */
  timeslice_full: number;
  interactive: boolean;
  /** DELTA(p)：prio 要比 static_prio 好這麼多才算互動型 */
  delta: number;
  /** TIMESLICE_GRANULARITY(p)（tick） */
  gran: number;
  credit: number;
  array: 'active' | 'expired';
  /** 在自己那一條佇列的第幾個（0 = 最前面） */
  pos: number;
  curr: boolean;
}

export interface O1Snapshot {
  kind: 'o1';
  clock: Ns;
  jiffies: number;
  tick_ns: Ns;
  /** 依 active 的 bitmap 順序（prio 小的在前），同 prio 依佇列順序 */
  active: number[];
  expired: number[];
  tasks: O1TaskView[];
  expired_timestamp: number;
  /** EXPIRED_STARVING(rq) 現在是否成立 */
  starving: boolean;
  /** 從 rq->expired_timestamp 起算、多久之後算 starving（jiffies） */
  starve_after: number;
  /** 累計交換 active / expired 的次數 */
  swaps: number;
}

// ---------------------------------------------------------------------------

export class O1V2_6_0 implements SchedClass<O1Entity> {
  readonly id = 'o1-v2.6.0';
  readonly P: O1Params;
  private readonly arrays: [PrioArray, PrioArray];
  active: PrioArray;
  expired: PrioArray;
  /** rq->expired_timestamp（jiffies）；0 表示沒有 */
  expired_timestamp = 0;
  private swaps = 0;
  /** 最近一次 pick_next_task() 選中的（rq->curr 由引擎在 pick 之後才改） */
  private curr: Task<O1Entity> | null = null;

  constructor(readonly tun: O1Tunables = defaultTunables) {
    this.P = new O1Params(tun.hz);
    const mk = (name: PrioArray['name']): PrioArray => ({
      name,
      nr_active: 0,
      bitmap: Array<boolean>(MAX_PRIO).fill(false),
      queue: Array.from({ length: MAX_PRIO }, () => []),
    });
    this.arrays = [mk('arrays[0]'), mk('arrays[1]')];
    this.active = this.arrays[0];
    this.expired = this.arrays[1];
  }

  private jiffies(rq: Rq<O1Entity>): number {
    return Math.floor(rq.clock / rq.tick_nsec);
  }

  /** unsigned long 的運算 */
  private ulong(x: number): number {
    return this.tun.bits_per_long === 32 ? ((x % U32) + U32) % U32 : x;
  }

  private HIGH_CREDIT(p: O1Entity): boolean {
    return p.interactive_credit > CREDIT_LIMIT;
  }
  private LOW_CREDIT(p: O1Entity): boolean {
    return p.interactive_credit < -CREDIT_LIMIT;
  }

  /** TASK_INTERACTIVE(p)（:141）：prio 比 static_prio 好至少 DELTA */
  TASK_INTERACTIVE(p: Task<O1Entity>): boolean {
    return p.se.prio <= p.static_prio - this.P.DELTA(p.static_prio);
  }

  /** EXPIRED_STARVING(rq)（:1345）：expired 裡最早的 task 等超過 STARVATION_LIMIT × nr_running */
  EXPIRED_STARVING(rq: Rq<O1Entity>): boolean {
    return (
      this.P.STARVATION_LIMIT > 0 &&
      this.expired_timestamp !== 0 &&
      this.jiffies(rq) - this.expired_timestamp >= this.P.STARVATION_LIMIT * rq.nr_running + 1
    );
  }

  init_entity(p: Task<O1Entity>): O1Entity {
    return {
      prio: p.static_prio,
      array: null,
      sleep_avg: 0,
      interactive_credit: 0,
      timestamp: 0,
      activated: 0,
      time_slice: 0,
      first_time_slice: false,
      task: p,
    };
  }

  // ---- prio_array 操作 ---------------------------------------------------

  /** dequeue_task()（:325） */
  private dequeue_task_array(rq: Rq<O1Entity>, p: Task<O1Entity>, array: PrioArray): void {
    charge(rq, 'queue', 1);
    array.nr_active--;
    const q = array.queue[p.se.prio]!;
    q.splice(q.indexOf(p), 1);
    if (q.length === 0) array.bitmap[p.se.prio] = false;
  }

  /** enqueue_task()（:333）：放到該優先權佇列的尾端 */
  private enqueue_task_array(rq: Rq<O1Entity>, p: Task<O1Entity>, array: PrioArray): void {
    charge(rq, 'queue', 1);
    array.queue[p.se.prio]!.push(p);
    array.bitmap[p.se.prio] = true;
    array.nr_active++;
    p.se.array = array;
  }

  /** sched_find_first_bit()：140 個 bit = 5 個 word，固定成本 */
  private sched_find_first_bit(rq: Rq<O1Entity>, bitmap: boolean[]): number {
    charge(rq, 'pick', 1);
    return bitmap.indexOf(true);
  }

  // ---- 優先權 -----------------------------------------------------------

  /** effective_prio()（:355）：sleep_avg 換算成 −5..+5 的 bonus */
  effective_prio(p: Task<O1Entity>): number {
    if (!this.tun.features.sleep_avg) return p.static_prio;
    const bonus = this.P.CURRENT_BONUS(p.se.sleep_avg) - idiv(MAX_BONUS, 2);
    let prio = p.static_prio - bonus;
    if (prio < MAX_RT_PRIO) prio = MAX_RT_PRIO;
    if (prio > MAX_PRIO - 1) prio = MAX_PRIO - 1;
    return prio;
  }

  /** recalc_task_prio()（:381）：把這段睡眠加進 sleep_avg，重算 prio */
  private recalc_task_prio(rq: Rq<O1Entity>, p: Task<O1Entity>, now: Ns): void {
    const se = p.se;
    const P = this.P;
    const __sleep_time = now - se.timestamp;
    let sleep_time = __sleep_time > P.NS_MAX_SLEEP_AVG ? P.NS_MAX_SLEEP_AVG : __sleep_time;
    const before = se.sleep_avg;
    let path: 'none' | 'just_interactive' | 'accumulate' = 'none';

    if (sleep_time > 0) {
      // p->mm 一律成立：工作負載都是 user task
      if (se.activated !== -1 && sleep_time > P.JUST_INTERACTIVE_SLEEP(p.static_prio)) {
        // 睡很久的直接設成「剛好互動」，避免它醒來後一下子變成霸佔 CPU 的 hog
        path = 'just_interactive';
        se.sleep_avg = P.JIFFIES_TO_NS(P.MAX_SLEEP_AVG - P.AVG_TIMESLICE);
        if (!this.HIGH_CREDIT(se)) se.interactive_credit++;
      } else {
        path = 'accumulate';
        // sleep_avg 越低，睡眠的效果越大（最多 10 倍）。i386 上這個乘法是 32 位元，會溢位
        sleep_time = this.ulong(sleep_time * (MAX_BONUS - P.CURRENT_BONUS(se.sleep_avg) || 1));
        if (this.LOW_CREDIT(se) && sleep_time > P.JIFFIES_TO_NS(P.task_timeslice(p.static_prio))) {
          sleep_time = P.JIFFIES_TO_NS(P.task_timeslice(p.static_prio));
        }
        if (se.activated === -1 && !this.HIGH_CREDIT(se)) {
          const jis = P.JUST_INTERACTIVE_SLEEP(p.static_prio);
          if (se.sleep_avg >= jis) sleep_time = 0;
          else if (se.sleep_avg + sleep_time >= jis) {
            se.sleep_avg = jis;
            sleep_time = 0;
          }
        }
        se.sleep_avg = this.ulong(se.sleep_avg + sleep_time);
        if (se.sleep_avg > P.NS_MAX_SLEEP_AVG) {
          se.sleep_avg = P.NS_MAX_SLEEP_AVG;
          if (!this.HIGH_CREDIT(se)) se.interactive_credit++;
        }
      }
    }
    const old_prio = se.prio;
    se.prio = this.effective_prio(p);
    rq.trace.log(rq.clock, 'recalc_task_prio', p.pid, {
      sleep_time: __sleep_time,
      path,
      sleep_avg_before: before,
      sleep_avg: se.sleep_avg,
      old_prio,
      prio: se.prio,
    });
  }

  /** activate_task()（:463） */
  private activate_task(rq: Rq<O1Entity>, p: Task<O1Entity>): void {
    const now = rq.clock; // sched_clock()
    this.recalc_task_prio(rq, p, now);
    if (!p.se.activated) p.se.activated = this.tun.wake_from_interrupt ? 2 : 1;
    p.se.timestamp = now;
    this.enqueue_task_array(rq, p, this.active); // __activate_task()
  }

  // ---- sched_class 介面 --------------------------------------------------

  /** try_to_wake_up()（:617）的 activate_task 部分 */
  enqueue_task(rq: Rq<O1Entity>, p: Task<O1Entity>, _wakeup: boolean): void {
    this.activate_task(rq, p);
  }

  /** deactivate_task()（:498） */
  dequeue_task(rq: Rq<O1Entity>, p: Task<O1Entity>, _sleep: boolean): void {
    if (p.se.array) this.dequeue_task_array(rq, p, p.se.array);
    p.se.array = null;
  }

  /** TASK_PREEMPTS_CURR(p, rq)（:156）：醒來的 prio 比 curr 好就搶佔 */
  check_preempt_curr(rq: Rq<O1Entity>, p: Task<O1Entity>): void {
    const curr = rq.curr;
    if (!curr) return;
    const preempt = p.se.prio < curr.se.prio;
    rq.trace.log(rq.clock, 'TASK_PREEMPTS_CURR', p.pid, { prio: p.se.prio, curr: curr.pid, curr_prio: curr.se.prio, preempt });
    if (preempt) resched_task(rq);
  }

  /**
   * schedule()（:1471）裡和 prev 有關的記帳：run_time 從 sleep_avg 扣掉，timestamp 記下現在。
   * kernel 在挑完 next 之後才扣（switch_tasks:），但 pick 不會讀 prev 的 sleep_avg，順序對結果沒有影響。
   */
  put_prev_task(rq: Rq<O1Entity>, prev: Task<O1Entity>): void {
    const se = prev.se;
    const now = rq.clock;
    let run_time = now - se.timestamp < this.P.NS_MAX_SLEEP_AVG ? now - se.timestamp : this.P.NS_MAX_SLEEP_AVG;
    // interactive_credit 高的，扣得比較少
    if (this.HIGH_CREDIT(se)) run_time = Math.floor(run_time / (this.P.CURRENT_BONUS(se.sleep_avg) || 1));
    se.sleep_avg -= run_time;
    if (se.sleep_avg <= 0) {
      se.sleep_avg = 0;
      if (!(this.HIGH_CREDIT(se) || this.LOW_CREDIT(se))) se.interactive_credit--;
    }
    se.timestamp = now;
    rq.trace.log(rq.clock, 'schedule', prev.pid, { run_time, sleep_avg: se.sleep_avg });
  }

  /** schedule() 的 pick_next_task: 段落（:1534） */
  pick_next_task(rq: Rq<O1Entity>): Task<O1Entity> | null {
    if (!rq.nr_running) {
      this.expired_timestamp = 0;
      this.curr = null;
      return null;
    }
    let array = this.active;
    if (!array.nr_active) {
      // 交換 active 和 expired：只是兩個指標，O(1)
      this.active = this.expired;
      this.expired = array;
      array = this.active;
      this.expired_timestamp = 0;
      this.swaps++;
      rq.trace.log(rq.clock, 'array_switch', undefined, { swaps: this.swaps });
    }
    const idx = this.sched_find_first_bit(rq, array.bitmap);
    const next = array.queue[idx]![0]!;

    if (next.se.activated > 0) {
      // 醒來後在 runqueue 上等的時間也算成睡眠（activated == 1 只算 30%）
      let delta = rq.clock - next.se.timestamp;
      if (next.se.activated === 1) delta = Math.floor((delta * Math.trunc((ON_RUNQUEUE_WEIGHT * 128) / 100)) / 128);
      const a = next.se.array!;
      this.dequeue_task_array(rq, next, a);
      this.recalc_task_prio(rq, next, next.se.timestamp + delta);
      this.enqueue_task_array(rq, next, a);
    }
    next.se.activated = 0;
    next.se.timestamp = rq.clock;
    this.curr = next;
    rq.trace.log(rq.clock, 'pick_next_task', next.pid, { idx, prio: next.se.prio });
    return next;
  }

  /** scheduler_tick()（:1357）：每個 tick 扣一格時間片，不管這個 tick 裡 curr 實際跑了多久 */
  task_tick(rq: Rq<O1Entity>, p: Task<O1Entity>): void {
    const se = p.se;
    const P = this.P;
    const f = this.tun.features;
    // 已經用完、搬到 expired，但還沒被換下來
    if (se.array !== this.active) {
      resched_task(rq);
      return;
    }
    if (!--se.time_slice) {
      this.dequeue_task_array(rq, p, this.active);
      resched_task(rq);
      se.prio = this.effective_prio(p);
      se.time_slice = P.task_timeslice(p.static_prio);
      se.first_time_slice = false;
      if (!this.expired_timestamp) this.expired_timestamp = this.jiffies(rq);
      const interactive = f.TASK_INTERACTIVE && this.TASK_INTERACTIVE(p);
      const starving = f.EXPIRED_STARVING && this.EXPIRED_STARVING(rq);
      const to = !interactive || starving ? this.expired : this.active;
      this.enqueue_task_array(rq, p, to);
      rq.trace.log(rq.clock, 'scheduler_tick', p.pid, {
        expired: true,
        interactive: this.TASK_INTERACTIVE(p),
        starving,
        to: to === this.active ? 'active' : 'expired',
        prio: se.prio,
      });
    } else if (
      f.TIMESLICE_GRANULARITY &&
      this.TASK_INTERACTIVE(p) &&
      !((P.task_timeslice(p.static_prio) - se.time_slice) % P.TIMESLICE_GRANULARITY(se.sleep_avg)) &&
      se.time_slice >= P.TIMESLICE_GRANULARITY(se.sleep_avg) &&
      se.array === this.active
    ) {
      // 互動型 task 的時間片很長，切成小段：排到同優先權佇列的尾端，讓同 prio 的輪流
      this.dequeue_task_array(rq, p, this.active);
      resched_task(rq);
      se.prio = this.effective_prio(p);
      this.enqueue_task_array(rq, p, this.active);
      rq.trace.log(rq.clock, 'scheduler_tick', p.pid, { requeue: true, prio: se.prio });
    }
  }

  /**
   * 新 task：kernel/fork.c 的 copy_process()（:982，時間片和 parent 對分）+ wake_up_forked_process()（:682）
   * + do_fork() 最後的 set_need_resched()（fork.c:1197）。
   * 簡化：parent 是一個 sleep_avg 為 parent_sleep_avg、時間片剛好滿的 shell，nice 和 child 相同。
   * kernel 在 parent 在 runqueue 上時讓 child 沿用 parent 的 prio、排在 parent 旁邊；這裡一律走 __activate_task()。
   */
  task_new(rq: Rq<O1Entity>, p: Task<O1Entity>): void {
    const se = p.se;
    const P = this.P;
    const parent_sleep_avg = this.tun.parent_sleep_avg === 'max' ? P.NS_MAX_SLEEP_AVG : this.tun.parent_sleep_avg;
    se.time_slice = (P.task_timeslice(p.static_prio) + 1) >> 1;
    se.first_time_slice = true;
    se.timestamp = rq.clock;
    // child 一開始是 parent 的複本，CURRENT_BONUS(p) 就是 parent 的 bonus；再打 95 折
    se.sleep_avg = P.JIFFIES_TO_NS(idiv(idiv(P.CURRENT_BONUS(parent_sleep_avg) * CHILD_PENALTY, 100) * P.MAX_SLEEP_AVG, MAX_BONUS));
    se.interactive_credit = 0;
    se.prio = this.effective_prio(p);
    this.enqueue_task_array(rq, p, this.active);
    rq.trace.log(rq.clock, 'wake_up_forked_process', p.pid, { sleep_avg: se.sleep_avg, prio: se.prio, time_slice: se.time_slice });
    resched_task(rq);
  }

  snapshot(rq: Rq<O1Entity>): O1Snapshot {
    const order = (a: PrioArray) => a.queue.flatMap((q) => q.map((t) => t.pid));
    const tasks: O1TaskView[] = [];
    for (const a of [this.active, this.expired]) {
      for (const q of a.queue) {
        q.forEach((t, pos) => {
          tasks.push({
            pid: t.pid,
            name: t.name,
            static_prio: t.static_prio,
            prio: t.se.prio,
            bonus: this.P.CURRENT_BONUS(t.se.sleep_avg) - idiv(MAX_BONUS, 2),
            sleep_avg: t.se.sleep_avg,
            time_slice: t.se.time_slice,
            timeslice_full: this.P.task_timeslice(t.static_prio),
            interactive: this.TASK_INTERACTIVE(t),
            delta: this.P.DELTA(t.static_prio),
            gran: this.P.TIMESLICE_GRANULARITY(t.se.sleep_avg),
            credit: t.se.interactive_credit,
            array: a === this.active ? 'active' : 'expired',
            pos,
            curr: this.curr === t,
          });
        });
      }
    }
    return {
      kind: 'o1',
      clock: rq.clock,
      jiffies: this.jiffies(rq),
      tick_ns: rq.tick_nsec,
      active: order(this.active),
      expired: order(this.expired),
      tasks: tasks.sort((a, b) => a.pid - b.pid),
      expired_timestamp: this.expired_timestamp,
      starving: this.EXPIRED_STARVING(rq),
      starve_after: this.P.STARVATION_LIMIT * rq.nr_running + 1,
      swaps: this.swaps,
    };
  }
}
