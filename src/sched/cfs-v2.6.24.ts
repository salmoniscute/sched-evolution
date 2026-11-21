// CFS，對齊 Linux v2.6.24 kernel/sched_fair.c。
// 函式名稱、順序、參數和原始碼一一對應；註解中的「:行號」都指 kernel-src/v2.6.24/kernel/sched_fair.c。
//
// 省略：schedstats、CONFIG_FAIR_GROUP_SCHED、SMP、SCHED_BATCH / RT。
// 預設 sched_feat：NEW_FAIR_SLEEPERS、WAKEUP_PREEMPT、START_DEBIT 開；TREE_AVG、APPROX_AVG 關
// （kernel/sched.c:464）。

import { NSEC_PER_MSEC, resched_task, charge, type Ns, type Rq, type SchedClass, type Task } from '../core/types.ts';
import { Timeline } from '../core/timeline.ts';
import { NICE_0_LOAD, set_load_weight, type LoadWeight } from '../core/weights.ts';

// ---------------------------------------------------------------------------
// 參數（:35、:41、:46、:80）。單核時 (1 + ilog(ncpus)) = 1。

export interface CfsTunables {
  sysctl_sched_latency: Ns;
  sysctl_sched_min_granularity: Ns;
  sysctl_sched_wakeup_granularity: Ns;
  /**
   * kernel 預設 1。但這個模擬器的 task 不是由「目前正在跑的 task」fork 出來的，
   * 套用的話會把 vruntime 和不相干的 task 互換，所以預設關閉。
   */
  sysctl_sched_child_runs_first: boolean;
  features: {
    NEW_FAIR_SLEEPERS: boolean;
    WAKEUP_PREEMPT: boolean;
    START_DEBIT: boolean;
  };
}

export const defaultTunables: CfsTunables = {
  sysctl_sched_latency: 20 * NSEC_PER_MSEC,
  sysctl_sched_min_granularity: 4 * NSEC_PER_MSEC,
  sysctl_sched_wakeup_granularity: 10 * NSEC_PER_MSEC,
  sysctl_sched_child_runs_first: false,
  features: { NEW_FAIR_SLEEPERS: true, WAKEUP_PREEMPT: true, START_DEBIT: true },
};

// ---------------------------------------------------------------------------
// 資料結構

/** struct sched_entity（include/linux/sched.h:866），只留排程決策會用到的欄位 */
export interface SchedEntity {
  load: LoadWeight;
  on_rq: boolean;
  exec_start: Ns;
  sum_exec_runtime: Ns;
  vruntime: Ns;
  prev_sum_exec_runtime: Ns;
  /** task_of(se) */
  readonly task: Task<SchedEntity>;
}

/** struct cfs_rq（kernel/sched.c:231） */
export interface CfsRq {
  load: { weight: number };
  nr_running: number;
  exec_clock: Ns;
  min_vruntime: Ns;
  /** tasks_timeline + rb_leftmost */
  tasks_timeline: Timeline<SchedEntity>;
  curr: SchedEntity | null;
}

export interface CfsSnapshot {
  clock: Ns;
  min_vruntime: Ns;
  load: number;
  nr_running: number;
  curr: EntityView | null;
  /** 樹中由左到右（不含 curr） */
  timeline: EntityView[];
}

export interface EntityView {
  pid: number;
  name: string;
  weight: number;
  vruntime: Ns;
  /** sched_slice()：以目前的 nr_running 與總權重算出的時間片（實際時間） */
  slice: Ns;
  sum_exec_runtime: Ns;
}

// ---------------------------------------------------------------------------
// calc_delta_mine()（kernel/sched.c:752）：用 inv_weight 定點乘法代替除法。
// 64 位元版本：WMULT_CONST = 1 << 32。用 BigInt 重現 kernel 的捨入。

const WMULT_CONST = 1n << 32n;
const WMULT_SHIFT = 32n;
const LONG_MAX = (1n << 63n) - 1n;

/** SRR(x, y)：右移並四捨五入 */
function SRR(x: bigint, y: bigint): bigint {
  return (x + (1n << (y - 1n))) >> y;
}

export function calc_delta_mine(delta_exec: Ns, weight: number, lw: LoadWeight): Ns {
  if (!lw.inv_weight) {
    const w = BigInt(lw.weight);
    lw.inv_weight = Number((WMULT_CONST - w / 2n) / w + 1n);
  }
  let tmp = BigInt(delta_exec) * BigInt(weight);
  const inv = BigInt(lw.inv_weight);
  if (tmp > WMULT_CONST) tmp = SRR(SRR(tmp, WMULT_SHIFT / 2n) * inv, WMULT_SHIFT / 2n);
  else tmp = SRR(tmp * inv, WMULT_SHIFT);
  return Number(tmp < LONG_MAX ? tmp : LONG_MAX);
}

/** calc_delta_fair()（kernel/sched.c:774）：實際時間 → 虛擬時間 */
export function calc_delta_fair(delta_exec: Ns, lw: LoadWeight): Ns {
  return calc_delta_mine(delta_exec, NICE_0_LOAD, lw);
}

// kernel 的 vruntime 是 u64，比較時用 (s64)(a - b)。JS number 本身有號，直接比較等價。
function max_vruntime(min_vruntime: Ns, vruntime: Ns): Ns {
  return vruntime - min_vruntime > 0 ? vruntime : min_vruntime;
}
function min_vruntime(min_vruntime: Ns, vruntime: Ns): Ns {
  return vruntime - min_vruntime < 0 ? vruntime : min_vruntime;
}

// ---------------------------------------------------------------------------

export class CfsV2_6_24 implements SchedClass<SchedEntity> {
  readonly id = 'cfs-v2.6.24';
  readonly cfs_rq: CfsRq;
  /** sched_nr_latency（:46）= latency / min_granularity */
  private readonly sched_nr_latency: number;

  constructor(readonly tun: CfsTunables = defaultTunables) {
    this.sched_nr_latency = Math.ceil(tun.sysctl_sched_latency / tun.sysctl_sched_min_granularity);
    // init_cfs_rq()（kernel/sched.c:6740）：刻意從 -2^20 開始，讓 u64 溢位的 bug 早點出現
    this.cfs_rq = {
      load: { weight: 0 },
      nr_running: 0,
      exec_clock: 0,
      min_vruntime: -(1 << 20),
      // entity_key() = se->vruntime - cfs_rq->min_vruntime；同一棵樹裡減同一個數，等同比 vruntime
      tasks_timeline: new Timeline((a, b) => a.vruntime - b.vruntime < 0),
      curr: null,
    };
  }

  init_entity(p: Task<SchedEntity>): SchedEntity {
    return {
      load: set_load_weight(p.static_prio),
      on_rq: false,
      exec_start: 0,
      sum_exec_runtime: 0,
      vruntime: 0,
      prev_sum_exec_runtime: 0,
      task: p,
    };
  }

  // ---- tree 操作 --------------------------------------------------------

  /** __enqueue_entity()（:146） */
  private __enqueue_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq, se: SchedEntity): void {
    charge(rq, 'queue', cfs_rq.tasks_timeline.depth());
    cfs_rq.tasks_timeline.insert(se);
  }

  /** __dequeue_entity()（:183） */
  private __dequeue_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq, se: SchedEntity): void {
    charge(rq, 'queue', cfs_rq.tasks_timeline.depth());
    cfs_rq.tasks_timeline.remove(se);
  }

  /** __pick_next_entity()（:196）：rb_leftmost 有快取，O(1) */
  private __pick_next_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq): SchedEntity | undefined {
    charge(rq, 'pick', 1);
    return cfs_rq.tasks_timeline.first();
  }

  // ---- slice ------------------------------------------------------------

  /** __sched_period()（:245）：nr ≤ nr_latency 時為 latency，否則按比例拉長 */
  __sched_period(nr_running: number): Ns {
    let period = this.tun.sysctl_sched_latency;
    if (nr_running > this.sched_nr_latency) {
      period = Math.floor((period * nr_running) / this.sched_nr_latency);
    }
    return period;
  }

  /** sched_slice()（:264）：s = p · w / Σw（實際時間） */
  sched_slice(cfs_rq: CfsRq, se: SchedEntity): Ns {
    const slice = this.__sched_period(cfs_rq.nr_running);
    return Math.floor((slice * se.load.weight) / cfs_rq.load.weight);
  }

  /** __sched_vslice()（:279）：vs = p · NICE_0_LOAD / Σw（虛擬時間） */
  private __sched_vslice(rq_weight: number, nr_running: number): Ns {
    const vslice = this.__sched_period(nr_running);
    return Math.floor((vslice * NICE_0_LOAD) / rq_weight);
  }

  /** sched_vslice_add()（:294）：加入 se 之後的 vslice */
  private sched_vslice_add(cfs_rq: CfsRq, se: SchedEntity): Ns {
    return this.__sched_vslice(cfs_rq.load.weight + se.load.weight, cfs_rq.nr_running + 1);
  }

  // ---- 記帳 -------------------------------------------------------------

  /** __update_curr()（:305） */
  private __update_curr(rq: Rq<SchedEntity>, cfs_rq: CfsRq, curr: SchedEntity, delta_exec: Ns): void {
    curr.sum_exec_runtime += delta_exec;
    cfs_rq.exec_clock += delta_exec;
    let delta_exec_weighted = delta_exec;
    if (curr.load.weight !== NICE_0_LOAD) {
      delta_exec_weighted = calc_delta_fair(delta_exec_weighted, curr.load);
    }
    curr.vruntime += delta_exec_weighted;

    // min_vruntime 單調遞增，追蹤 min(curr, leftmost)
    const left = this.__pick_next_entity(rq, cfs_rq);
    const vruntime = left ? min_vruntime(curr.vruntime, left.vruntime) : curr.vruntime;
    cfs_rq.min_vruntime = max_vruntime(cfs_rq.min_vruntime, vruntime);

    rq.trace.log(rq.clock, 'update_curr', curr.task.pid, {
      delta_exec,
      delta_exec_weighted,
      vruntime: curr.vruntime,
      min_vruntime: cfs_rq.min_vruntime,
    });
  }

  /** update_curr()（:336） */
  private update_curr(rq: Rq<SchedEntity>, cfs_rq: CfsRq): void {
    const curr = cfs_rq.curr;
    if (!curr) return;
    const now = rq.clock;
    const delta_exec = now - curr.exec_start;
    this.__update_curr(rq, cfs_rq, curr, delta_exec);
    curr.exec_start = now;
  }

  // ---- 進出 runqueue ----------------------------------------------------

  /** account_entity_enqueue()（:417） */
  private account_entity_enqueue(cfs_rq: CfsRq, se: SchedEntity): void {
    cfs_rq.load.weight += se.load.weight;
    cfs_rq.nr_running++;
    se.on_rq = true;
  }

  /** account_entity_dequeue()（:425） */
  private account_entity_dequeue(cfs_rq: CfsRq, se: SchedEntity): void {
    cfs_rq.load.weight -= se.load.weight;
    cfs_rq.nr_running--;
    se.on_rq = false;
  }

  /**
   * place_entity()（:488）
   * - initial（新 task）：放在 min_vruntime 之後一個 vslice（START_DEBIT），
   *   不讓新 task 插隊到這一輪已經承諾給別人的時間
   * - 喚醒：最多補償 sched_latency 的睡眠（NEW_FAIR_SLEEPERS），但不能比原本的 vruntime 還小
   */
  private place_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq, se: SchedEntity, initial: boolean): void {
    let vruntime = cfs_rq.min_vruntime;
    const { features } = this.tun;
    // 以下兩個只給 trace 用：START_DEBIT 的量、喚醒補償的量
    let debit = 0;
    let thresh = 0;

    if (initial && features.START_DEBIT) {
      debit = this.sched_vslice_add(cfs_rq, se);
      vruntime += debit;
    }

    if (!initial && features.NEW_FAIR_SLEEPERS) {
      thresh = this.tun.sysctl_sched_latency;
      vruntime -= thresh;
    }
    // max_vruntime 之前的候選位置（只給 trace 用）
    const candidate = vruntime;
    if (!initial) vruntime = max_vruntime(se.vruntime, vruntime);

    rq.trace.log(rq.clock, 'place_entity', se.task.pid, {
      initial,
      old_vruntime: se.vruntime,
      vruntime,
      min_vruntime: cfs_rq.min_vruntime,
      debit,
      thresh,
      candidate,
      /** max_vruntime 選了原本的 vruntime（補償沒用上） */
      kept_old: !initial && se.vruntime - candidate > 0,
    });
    se.vruntime = vruntime;
  }

  /** enqueue_entity()（:525） */
  private enqueue_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq, se: SchedEntity, wakeup: boolean): void {
    this.update_curr(rq, cfs_rq);
    if (wakeup) this.place_entity(rq, cfs_rq, se, false);
    if (se !== cfs_rq.curr) this.__enqueue_entity(rq, cfs_rq, se);
    this.account_entity_enqueue(cfs_rq, se);
    rq.trace.log(rq.clock, 'enqueue_entity', se.task.pid, { wakeup, vruntime: se.vruntime });
  }

  /** dequeue_entity()（:545） */
  private dequeue_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq, se: SchedEntity, sleep: boolean): void {
    this.update_curr(rq, cfs_rq);
    if (se !== cfs_rq.curr) this.__dequeue_entity(rq, cfs_rq, se);
    this.account_entity_dequeue(cfs_rq, se);
    rq.trace.log(rq.clock, 'dequeue_entity', se.task.pid, { sleep, vruntime: se.vruntime, min_vruntime: cfs_rq.min_vruntime });
  }

  // ---- 搶佔與挑選 -------------------------------------------------------

  /** check_preempt_tick()（:575）：這次上 CPU 後跑超過 sched_slice 就該讓出 */
  private check_preempt_tick(rq: Rq<SchedEntity>, cfs_rq: CfsRq, curr: SchedEntity): void {
    const ideal_runtime = this.sched_slice(cfs_rq, curr);
    const delta_exec = curr.sum_exec_runtime - curr.prev_sum_exec_runtime;
    const preempt = delta_exec > ideal_runtime;
    rq.trace.log(rq.clock, 'check_preempt_tick', curr.task.pid, { ideal_runtime, delta_exec, preempt });
    if (preempt) resched_task(rq);
  }

  /** set_next_entity()（:586）：curr 不放在樹裡 */
  private set_next_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq, se: SchedEntity): void {
    if (se.on_rq) this.__dequeue_entity(rq, cfs_rq, se);
    // update_stats_curr_start()
    se.exec_start = rq.clock;
    cfs_rq.curr = se;
    se.prev_sum_exec_runtime = se.sum_exec_runtime;
  }

  /** pick_next_entity()（:615） */
  private pick_next_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq): SchedEntity | null {
    const se = this.__pick_next_entity(rq, cfs_rq) ?? null;
    if (se) this.set_next_entity(rq, cfs_rq, se);
    rq.trace.log(rq.clock, 'pick_next_entity', se?.task.pid, { vruntime: se?.vruntime ?? null });
    return se;
  }

  /** put_prev_entity()（:627） */
  private put_prev_entity(rq: Rq<SchedEntity>, cfs_rq: CfsRq, prev: SchedEntity): void {
    if (prev.on_rq) this.update_curr(rq, cfs_rq);
    if (prev.on_rq) this.__enqueue_entity(rq, cfs_rq, prev);
    cfs_rq.curr = null;
  }

  /** entity_tick()（:645） */
  private entity_tick(rq: Rq<SchedEntity>, cfs_rq: CfsRq, curr: SchedEntity): void {
    this.update_curr(rq, cfs_rq);
    if (cfs_rq.nr_running > 1 || !this.tun.features.WAKEUP_PREEMPT) {
      this.check_preempt_tick(rq, cfs_rq, curr);
    }
  }

  // ---- sched_class 介面（fair_sched_class）-------------------------------

  /** enqueue_task_fair()（:760） */
  enqueue_task(rq: Rq<SchedEntity>, p: Task<SchedEntity>, wakeup: boolean): void {
    if (p.se.on_rq) return;
    this.enqueue_entity(rq, this.cfs_rq, p.se, wakeup);
  }

  /** dequeue_task_fair()（:779） */
  dequeue_task(rq: Rq<SchedEntity>, p: Task<SchedEntity>, sleep: boolean): void {
    this.dequeue_entity(rq, this.cfs_rq, p.se, sleep);
  }

  /**
   * check_preempt_wakeup()（:841）
   * 被喚醒的 task 的 vruntime 要比 curr 小超過 wakeup_granularity 才搶佔，避免過度切換。
   * 注意：這裡沒有先 update_curr（呼叫前的 enqueue_entity 已經做過）。
   */
  check_preempt_curr(rq: Rq<SchedEntity>, p: Task<SchedEntity>): void {
    const curr = rq.curr;
    if (!curr) return;
    const se = curr.se;
    const pse = p.se;
    if (!this.tun.features.WAKEUP_PREEMPT) return;

    let gran = this.tun.sysctl_sched_wakeup_granularity;
    if (se.load.weight !== NICE_0_LOAD) gran = calc_delta_fair(gran, se.load);

    const preempt = pse.vruntime + gran < se.vruntime;
    rq.trace.log(rq.clock, 'check_preempt_wakeup', p.pid, {
      curr: curr.pid,
      pse_vruntime: pse.vruntime,
      se_vruntime: se.vruntime,
      gran,
      preempt,
    });
    if (preempt) resched_task(rq);
  }

  /** pick_next_task_fair()（:877） */
  pick_next_task(rq: Rq<SchedEntity>): Task<SchedEntity> | null {
    if (!this.cfs_rq.nr_running) return null;
    return this.pick_next_entity(rq, this.cfs_rq)?.task ?? null;
  }

  /** put_prev_task_fair()（:896） */
  put_prev_task(rq: Rq<SchedEntity>, prev: Task<SchedEntity>): void {
    this.put_prev_entity(rq, this.cfs_rq, prev.se);
  }

  /** task_tick_fair()（:1045） */
  task_tick(rq: Rq<SchedEntity>, curr: Task<SchedEntity>): void {
    this.entity_tick(rq, this.cfs_rq, curr.se);
  }

  /** task_new_fair()（:1065） */
  task_new(rq: Rq<SchedEntity>, p: Task<SchedEntity>): void {
    const cfs_rq = this.cfs_rq;
    const se = p.se;
    const curr = cfs_rq.curr;

    this.update_curr(rq, cfs_rq);
    this.place_entity(rq, cfs_rq, se, true);

    if (this.tun.sysctl_sched_child_runs_first && curr && curr.vruntime < se.vruntime) {
      [curr.vruntime, se.vruntime] = [se.vruntime, curr.vruntime];
    }

    this.enqueue_task(rq, p, false);
    resched_task(rq);
  }

  snapshot(rq: Rq<SchedEntity>): CfsSnapshot {
    const c = this.cfs_rq;
    const view = (se: SchedEntity): EntityView => ({
      pid: se.task.pid,
      name: se.task.name,
      weight: se.load.weight,
      vruntime: se.vruntime,
      slice: c.load.weight ? this.sched_slice(c, se) : 0,
      sum_exec_runtime: se.sum_exec_runtime,
    });
    return {
      clock: rq.clock,
      min_vruntime: c.min_vruntime,
      load: c.load.weight,
      nr_running: c.nr_running,
      curr: c.curr ? view(c.curr) : null,
      timeline: c.tasks_timeline.toArray().map(view),
    };
  }
}
