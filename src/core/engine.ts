// 單核模擬引擎：對應 kernel/sched.c 的核心路徑（與排程器版本無關的部分）。
//
//   scheduler_tick()      → 每個 tick 呼叫 class->task_tick
//   wake_up_new_task()    → 新 task 進入 runqueue
//   try_to_wake_up()      → 睡醒的 task 進入 runqueue
//   schedule()            → deactivate_task / put_prev_task / pick_next_task
//
// 這是離散事件模擬：時間直接跳到下一個事件（tick、burst 結束、喚醒、建立 task），
// 中間由 rq->curr 連續執行。各排程器在事件發生時用 rq->clock 補算執行時間，
// 和 kernel 的 update_curr() 一樣。

import {
  NSEC_PER_SEC,
  resched_task,
  Tracer,
  type Ns,
  type Rq,
  type SchedClass,
  type Task,
  type TaskSpec,
} from './types.ts';
import { nice_to_static_prio } from './weights.ts';

export interface SimConfig {
  /** 模擬總長度 */
  duration: Ns;
  /** CONFIG_HZ，預設 1000（tick = 1ms） */
  hz?: number;
  /** 是否記錄排程器函式呼叫 */
  trace?: boolean;
  traceLimit?: number;
}

/** 每個 task 的統計，由引擎自己記，不依賴排程器的 schedstats */
export interface TaskStats {
  pid: number;
  name: string;
  nice: number;
  /** 實際拿到的 CPU 時間 */
  runtime: Ns;
  /** 可執行但在等 CPU 的總時間 */
  waitTime: Ns;
  /** 每次睡醒到真正上 CPU 的時間 */
  wakeupLatencies: Ns[];
  /** 自己睡著而讓出 CPU */
  nvcsw: number;
  /** 被搶佔 */
  nivcsw: number;
}

export interface SimResult {
  duration: Ns;
  idleTime: Ns;
  /** rq->nr_switches */
  nr_switches: number;
  /** schedule() 被呼叫的次數 */
  nr_schedule: number;
  /** 排程器資料結構操作總成本（見 Rq.ops） */
  ops: number;
  tasks: TaskStats[];
  trace: Tracer;
}

interface Bookkeeping {
  stats: TaskStats;
  /** 開始可執行（在 runqueue 上等）的時間；null 表示正在跑或在睡 */
  runnableSince: Ns | null;
  /** 最近一次被喚醒的時間；上 CPU 後清掉 */
  wokenAt: Ns | null;
  /** 預定醒來的時間 */
  wakeAt: Ns | null;
}

export class Simulator<SE> {
  readonly rq: Rq<SE>;
  readonly tasks: Task<SE>[] = [];
  private readonly book = new Map<Task<SE>, Bookkeeping>();
  private readonly tickNs: Ns;
  private nextTick: Ns;
  private pendingArrivals: Task<SE>[];
  private idleTime = 0;
  private nr_switches = 0;
  private nr_schedule = 0;

  constructor(
    readonly sched: SchedClass<SE>,
    specs: readonly TaskSpec[],
    readonly cfg: SimConfig,
  ) {
    const hz = cfg.hz ?? 1000;
    this.tickNs = Math.round(NSEC_PER_SEC / hz);
    this.nextTick = this.tickNs;
    this.rq = {
      clock: 0,
      tick_nsec: this.tickNs,
      curr: null,
      nr_running: 0,
      need_resched: false,
      trace: new Tracer(cfg.trace ?? false, cfg.traceLimit),
      ops: 0,
    };

    specs.forEach((spec, i) => {
      if (spec.pattern.length === 0) throw new Error(`task ${spec.name}: empty pattern`);
      if (spec.pattern.some((b) => !(b.run > 0) || !(b.sleep >= 0))) {
        throw new Error(`task ${spec.name}: each burst needs run > 0 and sleep >= 0`);
      }
      const p: Task<SE> = {
        pid: i + 1,
        name: spec.name,
        nice: spec.nice,
        static_prio: nice_to_static_prio(spec.nice),
        state: 'NEW',
        se: undefined as unknown as SE,
        spec,
        burstIdx: 0,
        burstLeft: 0,
      };
      // sched_fork()
      p.se = sched.init_entity(p);
      this.tasks.push(p);
      this.book.set(p, {
        stats: {
          pid: p.pid,
          name: p.name,
          nice: p.nice,
          runtime: 0,
          waitTime: 0,
          wakeupLatencies: [],
          nvcsw: 0,
          nivcsw: 0,
        },
        runnableSince: null,
        wokenAt: null,
        wakeAt: null,
      });
    });
    this.pendingArrivals = [...this.tasks].sort(
      (a, b) => (a.spec.arrival ?? 0) - (b.spec.arrival ?? 0) || a.pid - b.pid,
    );
  }

  private bk(p: Task<SE>): Bookkeeping {
    return this.book.get(p)!;
  }

  private loadBurst(p: Task<SE>): void {
    p.burstLeft = p.spec.pattern[p.burstIdx]!.run;
  }

  run(): SimResult {
    const { rq } = this;
    const end = this.cfg.duration;

    while (rq.clock < end) {
      const curr = rq.curr;
      const burstEnd = curr ? rq.clock + curr.burstLeft : Infinity;
      let nextWake = Infinity;
      for (const p of this.tasks) {
        const w = this.bk(p).wakeAt;
        if (w !== null && w < nextWake) nextWake = w;
      }
      const first = this.pendingArrivals[0];
      const nextArrival = first ? (first.spec.arrival ?? 0) : Infinity;
      const t = Math.min(this.nextTick, burstEnd, nextWake, nextArrival, end);

      this.advance(t);
      if (t >= end) break;

      // 同一時間點的事件順序：curr 的 burst 結束 → 新 task → 喚醒 → tick
      if (curr && curr.burstLeft <= 0) this.burstDone(curr);

      while (this.pendingArrivals.length && (this.pendingArrivals[0]!.spec.arrival ?? 0) <= t) {
        this.wake_up_new_task(this.pendingArrivals.shift()!);
      }
      for (const p of this.tasks) {
        if (this.bk(p).wakeAt === t) this.try_to_wake_up(p);
      }
      if (t === this.nextTick) {
        this.scheduler_tick();
        this.nextTick += this.tickNs;
      }
      // 從中斷 / 喚醒返回時檢查 TIF_NEED_RESCHED
      if (rq.need_resched) this.schedule();
    }

    return {
      duration: end,
      idleTime: this.idleTime,
      nr_switches: this.nr_switches,
      nr_schedule: this.nr_schedule,
      ops: rq.ops,
      tasks: this.tasks.map((p) => this.bk(p).stats),
      trace: rq.trace,
    };
  }

  /** 時間前進到 t：curr 持續執行 */
  private advance(t: Ns): void {
    const dt = t - this.rq.clock;
    const curr = this.rq.curr;
    if (curr) {
      curr.burstLeft -= dt;
      this.bk(curr).stats.runtime += dt;
    } else {
      this.idleTime += dt;
    }
    // update_rq_clock()
    this.rq.clock = t;
  }

  /** curr 跑完這段 burst：睡覺（或直接接下一段） */
  private burstDone(p: Task<SE>): void {
    const { sleep } = p.spec.pattern[p.burstIdx]!;
    p.burstIdx = (p.burstIdx + 1) % p.spec.pattern.length;
    this.loadBurst(p);
    if (sleep <= 0) return;
    // set_current_state(TASK_INTERRUPTIBLE); schedule();
    p.state = 'SLEEPING';
    this.bk(p).wakeAt = this.rq.clock + sleep;
    this.schedule();
  }

  /** wake_up_new_task()（v2.6.24 kernel/sched.c:1752） */
  private wake_up_new_task(p: Task<SE>): void {
    const { rq } = this;
    rq.trace.log(rq.clock, 'wake_up_new_task', p.pid);
    p.state = 'RUNNING';
    this.loadBurst(p);
    // 簡化：一律走 class->task_new。kernel 在 parent 不在 runqueue 時
    // 會改走 activate_task(rq, p, 0)，但工作負載的 task 沒有真的 parent。
    this.sched.task_new(rq, p);
    rq.nr_running++;
    this.bk(p).runnableSince = rq.clock;
    this.check_preempt_curr(p);
  }

  /** try_to_wake_up()（v2.6.24 kernel/sched.c:1507） */
  private try_to_wake_up(p: Task<SE>): void {
    const { rq } = this;
    const b = this.bk(p);
    rq.trace.log(rq.clock, 'try_to_wake_up', p.pid);
    b.wakeAt = null;
    b.wokenAt = rq.clock;
    b.runnableSince = rq.clock;
    p.state = 'RUNNING';
    // activate_task(rq, p, 1)
    this.sched.enqueue_task(rq, p, true);
    rq.nr_running++;
    this.check_preempt_curr(p);
  }

  /** check_preempt_curr()（v2.6.24 kernel/sched.c:368） */
  private check_preempt_curr(p: Task<SE>): void {
    // idle class 的 check_preempt_curr：任何 task 都能搶佔 idle
    if (this.rq.curr === null) resched_task(this.rq);
    else this.sched.check_preempt_curr(this.rq, p);
  }

  /** scheduler_tick()（v2.6.24 kernel/sched.c:3476） */
  private scheduler_tick(): void {
    const { rq } = this;
    if (rq.curr) this.sched.task_tick(rq, rq.curr);
  }

  /** schedule()（v2.6.24 kernel/sched.c:3619） */
  private schedule(): void {
    const { rq } = this;
    const prev = rq.curr;
    this.nr_schedule++;
    rq.need_resched = false;
    rq.trace.log(rq.clock, 'schedule', prev?.pid);

    const voluntary = prev !== null && prev.state === 'SLEEPING';
    if (prev && voluntary) {
      // deactivate_task(rq, prev, 1)
      this.sched.dequeue_task(rq, prev, true);
      rq.nr_running--;
    }
    if (prev) this.sched.put_prev_task(rq, prev);
    const next = this.sched.pick_next_task(rq);

    if (next === prev) return;

    this.nr_switches++;
    if (prev) {
      const b = this.bk(prev);
      if (voluntary) b.stats.nvcsw++;
      else {
        b.stats.nivcsw++;
        b.runnableSince = rq.clock;
      }
    }
    if (next) {
      const b = this.bk(next);
      if (b.runnableSince !== null) b.stats.waitTime += rq.clock - b.runnableSince;
      b.runnableSince = null;
      if (b.wokenAt !== null) {
        b.stats.wakeupLatencies.push(rq.clock - b.wokenAt);
        b.wokenAt = null;
      }
    }
    rq.curr = next;
  }
}
