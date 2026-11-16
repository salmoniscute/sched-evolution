// EEVDF，對齊 Linux v6.6 kernel/sched/fair.c。
// 註解中的「:行號」都指 kernel-src/v6.6/kernel/sched/fair.c。
//
// 省略：PELT（update_load_avg）、cgroup / CONFIG_FAIR_GROUP_SCHED、CFS bandwidth、SMP、
//       schedstats、buddy（NEXT_BUDDY 預設關）、SCHED_IDLE / BATCH、HRTICK（預設關）。
// 預設 sched_feat（features.h）：PLACE_LAG、PLACE_DEADLINE_INITIAL、RUN_TO_PARITY、
//       WAKEUP_PREEMPTION 開。
//
// 權重：64 位元 kernel 的 se->load.weight 是 scale_load(w) = w << 10，但凡是參與計算的地方
// 都會先 scale_load_down()，所以這裡直接存未放大的 w（nice 0 = 1024），結果相同。

import { NSEC_PER_USEC, resched_task, type Ns, type Rq, type SchedClass, type Task } from '../core/types.ts';
import { Timeline } from '../core/timeline.ts';
import { NICE_0_LOAD, set_load_weight, type LoadWeight } from '../core/weights.ts';

// ---------------------------------------------------------------------------
// 參數

export interface EevdfTunables {
  /** sysctl_sched_base_slice（:78），單核時 factor = 1 */
  sysctl_sched_base_slice: Ns;
  features: {
    PLACE_LAG: boolean;
    PLACE_DEADLINE_INITIAL: boolean;
    RUN_TO_PARITY: boolean;
    WAKEUP_PREEMPTION: boolean;
  };
}

export const defaultTunables: EevdfTunables = {
  sysctl_sched_base_slice: 750 * NSEC_PER_USEC,
  features: { PLACE_LAG: true, PLACE_DEADLINE_INITIAL: true, RUN_TO_PARITY: true, WAKEUP_PREEMPTION: true },
};

/** kernel/sched/sched.h 的 enqueue flags（只列用到的） */
export const ENQUEUE_WAKEUP = 0x01;
export const ENQUEUE_INITIAL = 0x80;

// ---------------------------------------------------------------------------
// 資料結構

/** struct sched_entity（include/linux/sched.h:548） */
export interface SchedEntity {
  load: LoadWeight;
  deadline: Ns;
  on_rq: boolean;
  exec_start: Ns;
  sum_exec_runtime: Ns;
  prev_sum_exec_runtime: Ns;
  vruntime: Ns;
  /**
   * 不在 runqueue 時：dequeue 當下的 lag（V − v_i，虛擬時間）。
   * 正在執行時：set_next_entity 暫存的 deadline（RUN_TO_PARITY 用的 HACK）。
   */
  vlag: Ns;
  /** request size r_i */
  slice: Ns;
  readonly task: Task<SchedEntity>;
}

/** struct cfs_rq（kernel/sched/sched.h:546） */
export interface CfsRq {
  load: { weight: number };
  nr_running: number;
  /** Σ (v_i − v0)·w_i，v0 = min_vruntime；不含 curr */
  avg_vruntime: number;
  /** Σ w_i；不含 curr */
  avg_load: number;
  exec_clock: Ns;
  min_vruntime: Ns;
  tasks_timeline: Timeline<SchedEntity>;
  curr: SchedEntity | null;
}

export interface EntityView {
  pid: number;
  name: string;
  weight: number;
  vruntime: Ns;
  deadline: Ns;
  vlag: Ns;
  /** 目前是否 eligible（lag ≥ 0） */
  eligible: boolean;
  sum_exec_runtime: Ns;
}

export interface EevdfSnapshot {
  clock: Ns;
  min_vruntime: Ns;
  /** V：所有 entity vruntime 的加權平均 */
  avg_vruntime: Ns;
  load: number;
  nr_running: number;
  curr: EntityView | null;
  timeline: EntityView[];
}

// ---------------------------------------------------------------------------
// __calc_delta()（:281）：delta · weight / lw.weight，用 inv_weight 的定點乘法。
// 和 v2.6.24 的 calc_delta_mine 不同：沒有四捨五入，改成動態調整 shift 以保留精度。

const WMULT_CONST = 0xffff_ffffn; // ~0U
const WMULT_SHIFT = 32;

/** fls()：最高位 1 的位置（1-based），0 → 0 */
function fls(x: bigint): number {
  return x === 0n ? 0 : x.toString(2).length;
}

/** __update_inv_weight()（:252） */
function __update_inv_weight(lw: LoadWeight): void {
  if (lw.inv_weight) return;
  const w = BigInt(lw.weight);
  if (w >= WMULT_CONST) lw.inv_weight = 1;
  else if (w === 0n) lw.inv_weight = Number(WMULT_CONST);
  else lw.inv_weight = Number(WMULT_CONST / w);
}

export function __calc_delta(delta_exec: Ns, weight: number, lw: LoadWeight): Ns {
  let fact = BigInt(weight);
  let shift = WMULT_SHIFT;
  __update_inv_weight(lw);

  let fact_hi = fact >> 32n;
  if (fact_hi) {
    const fs = fls(fact_hi);
    shift -= fs;
    fact >>= BigInt(fs);
  }

  fact *= BigInt(lw.inv_weight); // mul_u32_u32

  fact_hi = fact >> 32n;
  if (fact_hi) {
    const fs = fls(fact_hi);
    shift -= fs;
    fact >>= BigInt(fs);
  }

  // mul_u64_u32_shr：128 位元乘積後右移（截斷）
  return Number((BigInt(delta_exec) * fact) >> BigInt(shift));
}

/** calc_delta_fair()（:311）：delta /= w */
export function calc_delta_fair(delta: Ns, se: SchedEntity): Ns {
  if (se.load.weight !== NICE_0_LOAD) delta = __calc_delta(delta, NICE_0_LOAD, se.load);
  return delta;
}

/** div_s64()：有號除法，向 0 截斷 */
function div_s64(a: number, b: number): number {
  return Math.trunc(a / b);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

function min_vruntime(min_vruntime: Ns, vruntime: Ns): Ns {
  return vruntime - min_vruntime < 0 ? vruntime : min_vruntime;
}

/** entity_before()（:566） */
function entity_before(a: SchedEntity, b: SchedEntity): boolean {
  return a.vruntime - b.vruntime < 0;
}

// ---------------------------------------------------------------------------

export class EevdfV6_6 implements SchedClass<SchedEntity> {
  readonly id: string = 'eevdf-v6.6';
  readonly cfs_rq: CfsRq;

  constructor(readonly tun: EevdfTunables = defaultTunables) {
    // init_cfs_rq()（:12584）
    this.cfs_rq = {
      load: { weight: 0 },
      nr_running: 0,
      avg_vruntime: 0,
      avg_load: 0,
      exec_clock: 0,
      min_vruntime: -(1 << 20),
      tasks_timeline: new Timeline(entity_before),
      curr: null,
    };
  }

  /** __sched_fork()（kernel/sched/core.c:4493）+ set_load_weight()（core.c:1305） */
  init_entity(p: Task<SchedEntity>): SchedEntity {
    return {
      load: set_load_weight(p.static_prio),
      deadline: 0,
      on_rq: false,
      exec_start: 0,
      sum_exec_runtime: 0,
      prev_sum_exec_runtime: 0,
      vruntime: 0,
      vlag: 0,
      slice: this.tun.sysctl_sched_base_slice,
      task: p,
    };
  }

  // ---- avg_vruntime：V 的維護 -------------------------------------------

  /** entity_key()（:572）：以 min_vruntime 為基準的相對 vruntime，避免乘法溢位 */
  private entity_key(cfs_rq: CfsRq, se: SchedEntity): number {
    return se.vruntime - cfs_rq.min_vruntime;
  }

  /** avg_vruntime_add()（:639） */
  private avg_vruntime_add(cfs_rq: CfsRq, se: SchedEntity): void {
    const weight = se.load.weight;
    cfs_rq.avg_vruntime += this.entity_key(cfs_rq, se) * weight;
    cfs_rq.avg_load += weight;
  }

  /** avg_vruntime_sub()（:649） */
  private avg_vruntime_sub(cfs_rq: CfsRq, se: SchedEntity): void {
    const weight = se.load.weight;
    cfs_rq.avg_vruntime -= this.entity_key(cfs_rq, se) * weight;
    cfs_rq.avg_load -= weight;
  }

  /** avg_vruntime_update()（:659）：v0 前進 d 時，Σ(v_i − v0)·w_i 要減 d·Σw */
  private avg_vruntime_update(cfs_rq: CfsRq, delta: number): void {
    cfs_rq.avg_vruntime -= cfs_rq.avg_load * delta;
  }

  /** avg_vruntime()（:671）：V = v0 + Σ(v_i − v0)·w_i / Σw，curr 要另外加回去 */
  avg_vruntime(cfs_rq: CfsRq): Ns {
    const curr = cfs_rq.curr;
    let avg = cfs_rq.avg_vruntime;
    let load = cfs_rq.avg_load;

    if (curr && curr.on_rq) {
      const weight = curr.load.weight;
      avg += this.entity_key(cfs_rq, curr) * weight;
      load += weight;
    }

    if (load) {
      // 負數時改成向下取整，讓 V 偏左，保證 avg_vruntime() 本身一定 eligible
      if (avg < 0) avg -= load - 1;
      avg = div_s64(avg, load);
    }
    return cfs_rq.min_vruntime + avg;
  }

  /** update_entity_lag()（:710）：vlag = V − v_i，限制在 ±max(2·slice, TICK) 換成虛擬時間 */
  private update_entity_lag(rq: Rq<SchedEntity>, cfs_rq: CfsRq, se: SchedEntity): void {
    const lag = this.avg_vruntime(cfs_rq) - se.vruntime;
    const limit = calc_delta_fair(Math.max(2 * se.slice, rq.tick_nsec), se);
    se.vlag = clamp(lag, -limit, limit);
    rq.trace.log(rq.clock, 'update_entity_lag', se.task.pid, { lag, limit, vlag: se.vlag });
  }

  /**
   * entity_eligible()（:738）：lag ≥ 0 ⇔ V ≥ v_i。
   * 不做除法，改比 Σ(v−v0)·w ≥ (v_i−v0)·Σw，避免整數除法的誤差。
   */
  entity_eligible(cfs_rq: CfsRq, se: SchedEntity): boolean {
    const curr = cfs_rq.curr;
    let avg = cfs_rq.avg_vruntime;
    let load = cfs_rq.avg_load;

    if (curr && curr.on_rq) {
      const weight = curr.load.weight;
      avg += this.entity_key(cfs_rq, curr) * weight;
      load += weight;
    }
    return avg >= this.entity_key(cfs_rq, se) * load;
  }

  /** __update_min_vruntime()（:754） */
  private __update_min_vruntime(cfs_rq: CfsRq, vruntime: Ns): Ns {
    let min_vruntime = cfs_rq.min_vruntime;
    const delta = vruntime - min_vruntime;
    if (delta > 0) {
      this.avg_vruntime_update(cfs_rq, delta);
      min_vruntime = vruntime;
    }
    return min_vruntime;
  }

  /** update_min_vruntime()（:768） */
  private update_min_vruntime(cfs_rq: CfsRq): void {
    const se = cfs_rq.tasks_timeline.first();
    let curr = cfs_rq.curr;
    let vruntime = cfs_rq.min_vruntime;

    if (curr) {
      if (curr.on_rq) vruntime = curr.vruntime;
      else curr = null;
    }
    if (se) {
      if (!curr) vruntime = se.vruntime;
      else vruntime = min_vruntime(vruntime, se.vruntime);
    }
    cfs_rq.min_vruntime = this.__update_min_vruntime(cfs_rq, vruntime);
  }

  // ---- tree 操作 --------------------------------------------------------

  /** __enqueue_entity()（:831） */
  private __enqueue_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq, se: SchedEntity): void {
    this.avg_vruntime_add(cfs_rq, se);
    rq.ops += cfs_rq.tasks_timeline.depth();
    cfs_rq.tasks_timeline.insert(se);
  }

  /** __dequeue_entity()（:839） */
  private __dequeue_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq, se: SchedEntity): void {
    rq.ops += cfs_rq.tasks_timeline.depth();
    cfs_rq.tasks_timeline.remove(se);
    this.avg_vruntime_sub(cfs_rq, se);
  }

  /**
   * __pick_eevdf()（:875）：eligible 的 entity 中，deadline 最早者。
   *
   * kernel 用 augmented rbtree（每個節點存子樹的 min_deadline）在 O(log n) 內找到。
   * 這裡用線性掃描得到同樣的集合與最小值：樹依 vruntime 排序，而 eligible ⇔ v_i ≤ V，
   * 所以 eligible 的一定是左邊連續的一段，遇到第一個不 eligible 的就可以停。
   * 成本仍以 rbtree 的深度計入 rq.ops。
   *
   * 簡化：deadline 完全相同時，kernel 的結果取決於樹的形狀；這裡取最左邊的，curr 優先。
   */
  private __pick_eevdf(rq: Rq<SchedEntity>, cfs_rq: CfsRq): SchedEntity | null {
    let curr = cfs_rq.curr;
    if (curr && (!curr.on_rq || !this.entity_eligible(cfs_rq, curr))) curr = null;
    let best = curr;

    // 選中之後就一直跑到不 eligible 或拿到新 slice 為止（見 set_next_entity 的 HACK）
    if (this.tun.features.RUN_TO_PARITY && curr && curr.vlag === curr.deadline) {
      rq.trace.log(rq.clock, '__pick_eevdf', curr.task.pid, { run_to_parity: true });
      return curr;
    }

    rq.ops += Math.max(1, cfs_rq.tasks_timeline.depth());
    for (const se of cfs_rq.tasks_timeline.toArray()) {
      if (!this.entity_eligible(cfs_rq, se)) break;
      if (!best || best.deadline - se.deadline > 0) best = se;
    }
    rq.trace.log(rq.clock, '__pick_eevdf', best?.task.pid, {
      V: this.avg_vruntime(cfs_rq),
      deadline: best?.deadline ?? null,
    });
    return best;
  }

  /** pick_eevdf()（:969） */
  private pick_eevdf(rq: Rq<SchedEntity>, cfs_rq: CfsRq): SchedEntity | null {
    const se = this.__pick_eevdf(rq, cfs_rq);
    if (!se) {
      // "EEVDF scheduling fail, picking leftmost"
      return cfs_rq.tasks_timeline.first() ?? null;
    }
    return se;
  }

  // ---- deadline 與記帳 ---------------------------------------------------

  /**
   * update_deadline()（:1019）：用完這次 request（vruntime 超過 deadline）就發新的 deadline。
   * vd_i = ve_i + r_i / w_i
   */
  private update_deadline(rq: Rq<SchedEntity>, cfs_rq: CfsRq, se: SchedEntity): void {
    if (se.vruntime - se.deadline < 0) return;

    se.slice = this.base_slice(se);
    se.deadline = se.vruntime + calc_delta_fair(se.slice, se);
    rq.trace.log(rq.clock, 'update_deadline', se.task.pid, {
      vruntime: se.vruntime,
      deadline: se.deadline,
      slice: se.slice,
    });

    // request 用完了，重新排程
    if (cfs_rq.nr_running > 1) resched_task(rq);
  }

  /** 每次重新指定 slice 時的值。v6.6 一律是 sysctl_sched_base_slice；v6.12 子類別覆寫。 */
  protected base_slice(_se: SchedEntity): Ns {
    return this.tun.sysctl_sched_base_slice;
  }

  /** update_curr()（:1150） */
  private update_curr(rq: Rq<SchedEntity>, cfs_rq: CfsRq): void {
    const curr = cfs_rq.curr;
    if (!curr) return;
    const now = rq.clock;
    const delta_exec = now - curr.exec_start;
    if (delta_exec <= 0) return;

    curr.exec_start = now;
    curr.sum_exec_runtime += delta_exec;
    cfs_rq.exec_clock += delta_exec;

    curr.vruntime += calc_delta_fair(delta_exec, curr);
    rq.trace.log(rq.clock, 'update_curr', curr.task.pid, {
      delta_exec,
      vruntime: curr.vruntime,
      min_vruntime: cfs_rq.min_vruntime,
    });
    this.update_deadline(rq, cfs_rq, curr);
    this.update_min_vruntime(cfs_rq);
  }

  // ---- 進出 runqueue ----------------------------------------------------

  /**
   * place_entity()（:4974）：保留 lag 的放置。
   * v_i = V − vl_i · (W + w_i) / W，補償新 entity 加入後對 V 的影響（推導見原始碼註解）。
   */
  private place_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq, se: SchedEntity, flags: number): void {
    const vruntime = this.avg_vruntime(cfs_rq);
    let lag = 0;

    se.slice = this.base_slice(se);
    let vslice = calc_delta_fair(se.slice, se);

    if (this.tun.features.PLACE_LAG && cfs_rq.nr_running) {
      const curr = cfs_rq.curr;
      lag = se.vlag;

      let load = cfs_rq.avg_load;
      if (curr && curr.on_rq) load += curr.load.weight;

      lag *= load + se.load.weight;
      if (!load) load = 1; // WARN_ON_ONCE
      lag = div_s64(lag, load);
    }

    se.vruntime = vruntime - lag;

    // 新 task 加入時，其他 task 平均已經跑了半個 slice，所以先給半個 slice
    if (this.tun.features.PLACE_DEADLINE_INITIAL && flags & ENQUEUE_INITIAL) vslice = Math.trunc(vslice / 2);

    se.deadline = se.vruntime + vslice;

    rq.trace.log(rq.clock, 'place_entity', se.task.pid, {
      initial: Boolean(flags & ENQUEUE_INITIAL),
      V: vruntime,
      vlag: se.vlag,
      lag,
      vruntime: se.vruntime,
      deadline: se.deadline,
    });
  }

  /** account_entity_enqueue()（:3526） */
  private account_entity_enqueue(cfs_rq: CfsRq, se: SchedEntity): void {
    cfs_rq.load.weight += se.load.weight;
    cfs_rq.nr_running++;
  }

  /** account_entity_dequeue()（:3543） */
  private account_entity_dequeue(cfs_rq: CfsRq, se: SchedEntity): void {
    cfs_rq.load.weight -= se.load.weight;
    cfs_rq.nr_running--;
  }

  /** enqueue_entity()（:5080） */
  private enqueue_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq, se: SchedEntity, flags: number): void {
    const curr = cfs_rq.curr === se;

    // curr 要在 update_curr 之前重新放置
    if (curr) this.place_entity(rq, cfs_rq, se, flags);
    this.update_curr(rq, cfs_rq);
    if (!curr) this.place_entity(rq, cfs_rq, se, flags);

    this.account_entity_enqueue(cfs_rq, se);
    if (!curr) this.__enqueue_entity(rq, cfs_rq, se);
    se.on_rq = true;
    rq.trace.log(rq.clock, 'enqueue_entity', se.task.pid, { flags, vruntime: se.vruntime, deadline: se.deadline });
  }

  /** dequeue_entity()（:5167） */
  private dequeue_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq, se: SchedEntity): void {
    this.update_curr(rq, cfs_rq);
    this.update_entity_lag(rq, cfs_rq, se);
    if (se !== cfs_rq.curr) this.__dequeue_entity(rq, cfs_rq, se);
    se.on_rq = false;
    this.account_entity_dequeue(cfs_rq, se);
    // flags = DEQUEUE_SLEEP，不是 DEQUEUE_SAVE，所以要更新 min_vruntime
    this.update_min_vruntime(cfs_rq);
    rq.trace.log(rq.clock, 'dequeue_entity', se.task.pid, { vruntime: se.vruntime, vlag: se.vlag });
  }

  /** set_next_entity()（:5220） */
  private set_next_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq, se: SchedEntity): void {
    if (se.on_rq) {
      this.__dequeue_entity(rq, cfs_rq, se);
      // HACK：把選中當下的 deadline 暫存在 vlag（dequeue 之前不會用到 vlag）。
      // 之後 vlag === deadline 就表示「這個 slice 還沒跑完」，給 RUN_TO_PARITY 用。
      se.vlag = se.deadline;
    }
    se.exec_start = rq.clock;
    cfs_rq.curr = se;
    se.prev_sum_exec_runtime = se.sum_exec_runtime;
  }

  /** pick_next_entity()（:5270）：NEXT_BUDDY 預設關，等同 pick_eevdf */
  private pick_next_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq): SchedEntity | null {
    return this.pick_eevdf(rq, cfs_rq);
  }

  /** put_prev_entity()（:5284） */
  private put_prev_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq, prev: SchedEntity): void {
    if (prev.on_rq) this.update_curr(rq, cfs_rq);
    if (prev.on_rq) this.__enqueue_entity(rq, cfs_rq, prev);
    cfs_rq.curr = null;
  }

  /** entity_tick()（:5307）：已經沒有 check_preempt_tick，slice 用完由 update_deadline 觸發 */
  private entity_tick(rq: Rq<SchedEntity>, cfs_rq: CfsRq): void {
    this.update_curr(rq, cfs_rq);
  }

  // ---- sched_class 介面 ---------------------------------------------------

  /** enqueue_task_fair()（:6510） */
  enqueue_task(rq: Rq<SchedEntity>, p: Task<SchedEntity>, wakeup: boolean): void {
    this.enqueue_task_flags(rq, p, wakeup ? ENQUEUE_WAKEUP : 0);
  }

  private enqueue_task_flags(rq: Rq<SchedEntity>, p: Task<SchedEntity>, flags: number): void {
    if (p.se.on_rq) return;
    this.enqueue_entity(rq, this.cfs_rq, p.se, flags);
  }

  /** dequeue_task_fair()（:6603） */
  dequeue_task(rq: Rq<SchedEntity>, p: Task<SchedEntity>, _sleep: boolean): void {
    this.dequeue_entity(rq, this.cfs_rq, p.se);
  }

  /**
   * check_preempt_wakeup()（:8055）：先 update_curr，再看 pick_eevdf 會不會選被喚醒的 task。
   * 和 v2.6.24 不同，沒有 wakeup_granularity。
   */
  check_preempt_curr(rq: Rq<SchedEntity>, p: Task<SchedEntity>): void {
    const curr = rq.curr;
    if (!curr) return;
    const se = curr.se;
    const pse = p.se;
    if (se === pse) return;
    if (rq.need_resched) return;
    if (!this.tun.features.WAKEUP_PREEMPTION) return;

    const cfs_rq = this.cfs_rq;
    this.update_curr(rq, cfs_rq);
    const picked = this.pick_eevdf(rq, cfs_rq);
    const preempt = picked === pse;
    rq.trace.log(rq.clock, 'check_preempt_wakeup', p.pid, {
      curr: curr.pid,
      picked: picked?.task.pid ?? null,
      preempt,
    });
    if (preempt) resched_task(rq);
  }

  /** pick_next_task_fair()（:8169）的 simple 路徑：put_prev_task 已先做，所以 curr 為 NULL */
  pick_next_task(rq: Rq<SchedEntity>): Task<SchedEntity> | null {
    if (!this.cfs_rq.nr_running) return null;
    const se = this.pick_next_entity(rq, this.cfs_rq);
    if (!se) return null;
    this.set_next_entity(rq, this.cfs_rq, se);
    return se.task;
  }

  /** put_prev_task_fair()（:8321） */
  put_prev_task(rq: Rq<SchedEntity>, prev: Task<SchedEntity>): void {
    this.put_prev_entity(rq, this.cfs_rq, prev.se);
  }

  /** task_tick_fair()（:12386） */
  task_tick(rq: Rq<SchedEntity>, _curr: Task<SchedEntity>): void {
    this.entity_tick(rq, this.cfs_rq);
  }

  /**
   * 新 task：fork 時的 task_fork_fair()（:12410）+ wake_up_new_task() 的
   * activate_task(rq, p, ENQUEUE_NOCLOCK)（kernel/sched/core.c:4872）。
   *
   * 注意 v6.6 的怪處：task_fork_fair 用 ENQUEUE_INITIAL 放置（半個 slice），
   * 但 activate_task 沒帶 ENQUEUE_INITIAL，enqueue_entity 會再呼叫一次 place_entity，
   * 覆蓋成完整的 slice。v6.12 才改成 activate_task(rq, p, ENQUEUE_NOCLOCK | ENQUEUE_INITIAL)。
   */
  task_new(rq: Rq<SchedEntity>, p: Task<SchedEntity>): void {
    const cfs_rq = this.cfs_rq;
    // task_fork_fair()
    if (cfs_rq.curr) this.update_curr(rq, cfs_rq);
    this.place_entity(rq, cfs_rq, p.se, ENQUEUE_INITIAL);
    // wake_up_new_task()
    this.enqueue_task_flags(rq, p, this.wake_up_new_task_flags());
  }

  /** wake_up_new_task() 傳給 activate_task 的 flags（ENQUEUE_NOCLOCK 與模擬無關，省略） */
  protected wake_up_new_task_flags(): number {
    return 0;
  }

  snapshot(rq: Rq<SchedEntity>): EevdfSnapshot {
    const c = this.cfs_rq;
    const view = (se: SchedEntity): EntityView => ({
      pid: se.task.pid,
      name: se.task.name,
      weight: se.load.weight,
      vruntime: se.vruntime,
      deadline: se.deadline,
      vlag: se.vlag,
      eligible: this.entity_eligible(c, se),
      sum_exec_runtime: se.sum_exec_runtime,
    });
    return {
      clock: rq.clock,
      min_vruntime: c.min_vruntime,
      avg_vruntime: this.avg_vruntime(c),
      load: c.load.weight,
      nr_running: c.nr_running,
      curr: c.curr ? view(c.curr) : null,
      timeline: c.tasks_timeline.toArray().map(view),
    };
  }
}
