// EEVDF v6.12 選項：在 v6.6 的基礎上，只移植 v6.12 的
//   1. custom_slice：每個 task 可以用 sched_attr.sched_runtime 指定自己的 request size r_i
//   2. PREEMPT_SHORT：slice 較短的 task 醒來時，可以取消 curr 的 RUN_TO_PARITY 保護
//   3. DELAY_DEQUEUE + DELAY_ZERO：睡著時若不 eligible（lag < 0），留在 runqueue 上繼續競爭，
//      把負的 lag 還完（被選中）才真正離開；離開或喚醒時正的 lag 截成 0。
//      沒有這個，短 slice 的 task 醒來時常帶著負 lag、不 eligible，PREEMPT_SHORT 無從發揮。
//   4. wake_up_new_task 帶 ENQUEUE_INITIAL（修正 v6.6 fork 半個 slice 沒作用的問題）
// 註解中的「:行號」都指 kernel-src/v6.12/kernel/sched/fair.c。
//
// 沒有移植的 v6.12 變更（見 notes/05-eevdf-v6.12-slice.md）：
//   - 樹改依 deadline 排序、augmented 欄位改成 min_vruntime；選擇的集合相同，只有平手時的結果不同
//   - pick_eevdf 在 nr_running == 1 時直接回傳（結果相同）
//   - PLACE_REL_DEADLINE（只影響 migration / save-restore，單核模擬用不到）

import { NSEC_PER_MSEC, type Ns, type Rq, type Task } from '../core/types.ts';
import { ENQUEUE_INITIAL, EevdfV6_6, defaultTunables, type CfsRq, type EevdfTunables, type SchedEntity } from './eevdf-v6.6.ts';

export interface EevdfV6_12Tunables extends EevdfTunables {
  features: EevdfTunables['features'] & { PREEMPT_SHORT: boolean; DELAY_DEQUEUE: boolean; DELAY_ZERO: boolean };
}

/** kernel/sched/features.h 的預設值 */
export const defaultTunablesV6_12: EevdfV6_12Tunables = {
  ...defaultTunables,
  features: { ...defaultTunables.features, PREEMPT_SHORT: true, DELAY_DEQUEUE: true, DELAY_ZERO: true },
};

/** custom slice 的允許範圍（kernel/sched/syscalls.c:309） */
export const SLICE_MIN = NSEC_PER_MSEC / 10; // HZ=1000 * 10
export const SLICE_MAX = NSEC_PER_MSEC * 100; // HZ=100  / 10

/** entity_before()（:544）：v6.12 改成比 deadline（v6.6 比 vruntime） */
function entity_before(a: SchedEntity, b: SchedEntity): boolean {
  return a.deadline - b.deadline < 0;
}

export class EevdfV6_12 extends EevdfV6_6 {
  override readonly id: string = 'eevdf-v6.12-slice';

  constructor(override readonly tun: EevdfV6_12Tunables = defaultTunablesV6_12) {
    super(tun);
  }

  /** __setscheduler_params()（kernel/sched/syscalls.c:304）：sched_runtime → se.slice */
  override init_entity(p: Task<SchedEntity>): SchedEntity {
    const se = super.init_entity(p);
    const runtime = p.spec.slice;
    if (runtime) {
      se.custom_slice = true;
      se.slice = Math.min(Math.max(runtime, SLICE_MIN), SLICE_MAX);
    }
    return se;
  }

  /** update_deadline()（:1017）/ place_entity()（:5271）：有 custom_slice 就不重設 */
  protected override base_slice(se: SchedEntity): Ns {
    return se.custom_slice ? se.slice : this.tun.sysctl_sched_base_slice;
  }

  /**
   * did_preempt_short()（:1166）：保護已經被取消（vlag ≠ deadline）而且 curr 不再 eligible，
   * 就在 update_curr 時重新排程，不必等 slice 用完。
   */
  protected override did_preempt_short(cfs_rq: CfsRq, curr: SchedEntity): boolean {
    if (!this.tun.features.PREEMPT_SHORT) return false;
    if (curr.vlag === curr.deadline) return false;
    return !this.entity_eligible(cfs_rq, curr);
  }

  /** do_preempt_short()（:1177） */
  private do_preempt_short(cfs_rq: CfsRq, pse: SchedEntity, se: SchedEntity): boolean {
    if (!this.tun.features.PREEMPT_SHORT) return false;
    if (pse.slice >= se.slice) return false;
    if (!this.entity_eligible(cfs_rq, pse)) return false;
    if (entity_before(pse, se)) return true;
    if (!this.entity_eligible(cfs_rq, se)) return true;
    return false;
  }

  /**
   * check_preempt_wakeup_fair()（:8826）：被喚醒的 task slice 比較短而且 eligible，
   * 就取消 curr 的 slice 保護（vlag = deadline + 1，讓 RUN_TO_PARITY 的條件不成立）。
   * 即使被喚醒的 task 這次沒被選中，curr 的保護也已經沒了。
   */
  protected override wakeup_preempt_short(rq: Rq<SchedEntity>, cfs_rq: CfsRq, pse: SchedEntity, se: SchedEntity): void {
    if (this.do_preempt_short(cfs_rq, pse, se) && se.vlag === se.deadline) {
      se.vlag = se.deadline + 1;
      rq.trace.log(rq.clock, 'do_preempt_short', pse.task.pid, { curr: se.task.pid, slice: pse.slice });
    }
  }

  // ---- DELAY_DEQUEUE ------------------------------------------------------

  /**
   * dequeue_entity()（:5475）的 DEQUEUE_SLEEP 路徑：不 eligible 就只標 sched_delayed，
   * 留在樹上（curr 的話由 put_prev_entity 放回樹上），繼續算進 V 與 nr_running。
   */
  override dequeue_task(rq: Rq<SchedEntity>, p: Task<SchedEntity>, sleep: boolean): void {
    const se = p.se;
    const cfs_rq = this.cfs_rq;
    this.update_curr(rq, cfs_rq);
    if (this.tun.features.DELAY_DEQUEUE && sleep && !this.entity_eligible(cfs_rq, se)) {
      se.sched_delayed = true;
      rq.trace.log(rq.clock, 'dequeue_entity', p.pid, { delayed: true, vruntime: se.vruntime });
      return;
    }
    super.dequeue_task(rq, p, sleep);
  }

  /** dequeue_entities(rq, se, DEQUEUE_SLEEP | DEQUEUE_DELAYED)：真正離開 + finish_delayed_dequeue_entity()（:5468） */
  private dequeue_delayed(rq: Rq<SchedEntity>, se: SchedEntity): void {
    this.dequeue_entity(rq, this.cfs_rq, se);
    se.sched_delayed = false;
    if (this.tun.features.DELAY_ZERO && se.vlag > 0) se.vlag = 0;
    rq.trace.log(rq.clock, 'finish_delayed_dequeue_entity', se.task.pid, { vlag: se.vlag });
  }

  /**
   * pick_next_task_fair()（:8869）+ pick_next_entity()（:5613）：選中的若是 delayed entity，
   * 表示它已經 eligible（還完負的 lag），這時才真正 dequeue，然後重選。
   */
  override pick_next_task(rq: Rq<SchedEntity>): Task<SchedEntity> | null {
    const cfs_rq = this.cfs_rq;
    while (cfs_rq.nr_running) {
      const se = this.pick_next_entity(rq, cfs_rq);
      if (!se) return null;
      if (se.sched_delayed) {
        this.dequeue_delayed(rq, se);
        continue;
      }
      this.set_next_entity(rq, cfs_rq, se);
      return se.task;
    }
    return null;
  }

  /**
   * ttwu_runnable()（kernel/sched/core.c:3735）：delayed 的 task 還在 runqueue 上，喚醒時走
   * enqueue_task(ENQUEUE_DELAYED) → requeue_delayed_entity()（:6919）。
   * DELAY_ZERO：lag 已經是正的就截成 0 重新放置。注意這裡沒有先 update_curr。
   */
  override enqueue_task(rq: Rq<SchedEntity>, p: Task<SchedEntity>, wakeup: boolean): void {
    const se = p.se;
    if (!se.sched_delayed) {
      super.enqueue_task(rq, p, wakeup);
      return;
    }
    const cfs_rq = this.cfs_rq;
    if (this.tun.features.DELAY_ZERO) {
      this.update_entity_lag(rq, cfs_rq, se);
      if (se.vlag > 0) {
        cfs_rq.nr_running--;
        if (se !== cfs_rq.curr) this.__dequeue_entity(rq, cfs_rq, se);
        se.vlag = 0;
        this.place_entity(rq, cfs_rq, se, 0);
        if (se !== cfs_rq.curr) this.__enqueue_entity(rq, cfs_rq, se);
        cfs_rq.nr_running++;
      }
    }
    se.sched_delayed = false;
    rq.trace.log(rq.clock, 'requeue_delayed_entity', p.pid, { vlag: se.vlag, vruntime: se.vruntime });
  }

  /** wake_up_new_task()（kernel/sched/core.c:4829）：activate_task(rq, p, ENQUEUE_NOCLOCK | ENQUEUE_INITIAL) */
  protected override wake_up_new_task_flags(): number {
    return ENQUEUE_INITIAL;
  }
}
