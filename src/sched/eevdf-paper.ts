// 論文版的離散 EEVDF：Stoica & Abdel-Wahab, "Earliest Eligible Virtual Deadline First: A Flexible and
// Accurate Mechanism for Proportional Share Resource Allocation", TR-95-22, Old Dominion University, 1995。
// 這不是 kernel 程式碼，而是拿來和 kernel（v6.6 / v6.12）對照的「理想演算法」。
//
// 對照論文：
//   - 虛擬時間 V：dV/dt = 1 / Σ_{active} w_j（§3，Eq. 5）。這裡乘上 NICE_0_LOAD，單位和 kernel 的 vruntime 相同。
//   - request：ve⁽¹⁾ = V(t_i)，vd⁽ᵏ⁾ = ve⁽ᵏ⁾ + r⁽ᵏ⁾ / w，ve⁽ᵏ⁺¹⁾ = ve⁽ᵏ⁾ + u⁽ᵏ⁾ / w（§3，Eq. 11–13）。
//     request 在 ve ≤ V 時 eligible；eligible 的 request 裡 vd 最早的拿到下一個 quantum。
//   - quantum q：分配的單位。request 比 q 長時，quantum 到期就重新分配；request 用完或 client 去睡時也重新分配。
//     醒來的 client 不會在 quantum 中間搶佔（論文的分配只發生在 quantum 開始時）。
//   - 加入／離開（§4，Eq. 18、19，附錄 A 的 join() / leave()）：
//       離開：V ← V + lag_j / Σ_{離開後} w
//       加入：V ← V − lag_j / Σ_{加入後} w
//     這兩條維持「所有 active client 的 lag 總和為 0」（§6 的 Lemma），因此 V 恆等於 Σ w_i·v_i / W。
//   - 重新加入時帶多少 lag（§5）：strategy 1 保留離開時的 lag，strategy 2 一律從 0 開始。
//
// 由 Eq. 19 和 lag 總和為 0 推得：帶著 lag ℓ 加入的 client，加入後實際的 lag 是 ℓ·W/(W + w)，
// 自己也分攤了一份。kernel v6.6 的 place_entity() 把 lag 放大 (W + w)/W，就是為了抵銷這一份
// （fair.c 的註解：「otherwise lag can quickly evaporate」）。這裡照論文，不放大。
//
// 論文附錄 A 的 join() 讓新 request 從 ve = V 開始（立刻 eligible）；這裡照 §3 的定義（Eq. 9），
// 讓 ve 落在 lag 為 0 的位置，負 lag 的 client 要等 V 追上來才 eligible。
//
// 簡化：數值用浮點數（論文是實數），不做 kernel 的整數截斷；沒有 lag 截斷；tick 不做任何事。
import { charge, resched_task, type Ns, type Rq, type SchedClass, type Task } from '../core/types.ts';
import { NSEC_PER_USEC } from '../core/types.ts';
import { NICE_0_LOAD } from '../core/weights.ts';
import { weight_of_nice } from '../core/metrics.ts';
import type { EevdfSnapshot, EntityView } from './eevdf-v6.6.ts';

export interface PaperTunables {
  /** 時間量子 q */
  quantum: Ns;
  /** 沒有指定 request 大小時用的 r（和 kernel 的 sysctl_sched_base_slice 相同） */
  base_slice: Ns;
  /** true：strategy 1（保留 lag）；false：strategy 2（重新加入時 lag = 0） */
  keep_lag: boolean;
  /** 記下每個 request 的 (ve, vd)，給測試對照論文 Figure 1 */
  record?: boolean;
}

/** 浮點誤差的容許量（虛擬 ns） */
const EPS = 1e-3;

export const defaultTunables: PaperTunables = {
  quantum: 100 * NSEC_PER_USEC,
  base_slice: 750 * NSEC_PER_USEC,
  keep_lag: true,
};

export interface PaperEntity {
  task: Task<PaperEntity>;
  weight: number;
  /** request 長度 r（實際時間） */
  r: Ns;
  /** 目前 request 的 virtual eligible time */
  ve: number;
  /** 目前 request 的 virtual deadline */
  vd: number;
  /** 目前 request 已經用掉的服務時間 u */
  used: Ns;
  /** 有沒有在競爭（有 pending request） */
  active: boolean;
  /** 離開時的 lag（服務時間，ns），重新加入時用 */
  lag: number;
  /** 這個 quantum 從什麼時候開始（只有 curr 有意義） */
  qStart: Ns;
  sum_exec_runtime: Ns;
}

export class EevdfPaper implements SchedClass<PaperEntity> {
  readonly id = 'eevdf-paper';
  /** 虛擬時間 V（以 NICE_0_LOAD 為單位，和 vruntime 相同） */
  V = 0;
  /** Σ_{active} w */
  W = 0;
  private last = 0;
  private curr: PaperEntity | null = null;
  private readonly active: PaperEntity[] = [];
  /** 加入時實際帶回的 lag，給測試看 Eq. 19 的效果 */
  readonly joins: { pid: number; t: Ns; lag: number; effective: number }[] = [];
  /** tun.record 時：每個 request 的 (ve, vd) */
  readonly requests: { pid: number; t: Ns; ve: number; vd: number }[] = [];

  constructor(readonly tun: PaperTunables = defaultTunables) {}

  init_entity(p: Task<PaperEntity>): PaperEntity {
    return {
      task: p,
      weight: weight_of_nice(p.nice),
      r: p.spec.slice ?? this.tun.base_slice,
      ve: 0,
      vd: 0,
      used: 0,
      active: false,
      lag: 0,
      qStart: 0,
      sum_exec_runtime: 0,
    };
  }

  /**
   * request 是否 eligible（ve ≤ V）。V 和 ve 是分別累加的浮點數，理論上相等時可能差一點點，
   * 所以容許 EPS 的誤差；否則會出現「沒有任何 request eligible」，違反論文 §6 的 Lemma 1。
   */
  eligible(se: PaperEntity): boolean {
    return se.ve - this.V <= EPS;
  }

  /** 服務位置 v = ve + u/w：lag = w·(V − v) / NICE_0_LOAD */
  private v(se: PaperEntity): number {
    return se.ve + (se.used * NICE_0_LOAD) / se.weight;
  }

  /** lag_i = S_i − s_i（服務時間，ns） */
  lagOf(se: PaperEntity): number {
    return ((this.V - this.v(se)) * se.weight) / NICE_0_LOAD;
  }

  /** 把時間推進到 rq.clock：V 照 1/W 前進，curr 的 request 累計使用量 */
  private update(rq: Rq<PaperEntity>): void {
    const dt = rq.clock - this.last;
    this.last = rq.clock;
    if (dt <= 0) return;
    if (this.W > 0) this.V += (dt * NICE_0_LOAD) / this.W;
    if (this.curr) {
      this.curr.used += dt;
      this.curr.sum_exec_runtime += dt;
    }
  }

  /** 發出新的 request：ve 照 Eq. 13 接在上一個後面（或由加入時的 lag 決定） */
  private issue(se: PaperEntity, ve: number): void {
    se.ve = ve;
    se.vd = ve + (se.r * NICE_0_LOAD) / se.weight;
    se.used = 0;
    if (this.tun.record) this.requests.push({ pid: se.task.pid, t: this.last, ve: se.ve, vd: se.vd });
  }

  /** 目前在競爭的 entity（含 curr） */
  entities(): readonly PaperEntity[] {
    return this.active;
  }

  /** join()（附錄 A）＋ Eq. 19 */
  private join(rq: Rq<PaperEntity>, se: PaperEntity, lag: number): void {
    const before = this.W;
    this.W += se.weight;
    this.V -= (lag * NICE_0_LOAD) / this.W;
    // 加入後實際的 lag：其他 client 分攤了 lag·(W_before / W)，總和維持 0
    const effective = (lag * before) / this.W;
    this.issue(se, this.V - (effective * NICE_0_LOAD) / se.weight);
    se.active = true;
    this.active.push(se);
    charge(rq, 'queue', 1);
    this.joins.push({ pid: se.task.pid, t: rq.clock, lag, effective });
  }

  /** leave()（附錄 A）＋ Eq. 18 */
  private leave(rq: Rq<PaperEntity>, se: PaperEntity): void {
    const lag = this.lagOf(se);
    this.W -= se.weight;
    if (this.W > 0) this.V += (lag * NICE_0_LOAD) / this.W;
    se.lag = lag;
    se.active = false;
    this.active.splice(this.active.indexOf(se), 1);
    charge(rq, 'queue', 1);
  }

  task_new(rq: Rq<PaperEntity>, p: Task<PaperEntity>): void {
    this.update(rq);
    this.join(rq, p.se, 0);
  }

  enqueue_task(rq: Rq<PaperEntity>, p: Task<PaperEntity>, _wakeup: boolean): void {
    this.update(rq);
    this.join(rq, p.se, this.tun.keep_lag ? p.se.lag : 0);
  }

  dequeue_task(rq: Rq<PaperEntity>, p: Task<PaperEntity>, _sleep: boolean): void {
    this.update(rq);
    this.leave(rq, p.se);
    if (this.curr === p.se) this.curr = null;
  }

  /** 論文只在 quantum 開始時分配，醒來不搶佔；CPU 閒著時由引擎處理 */
  check_preempt_curr(rq: Rq<PaperEntity>, _p: Task<PaperEntity>): void {
    this.update(rq);
  }

  /** EEVDF_dispatch()（附錄 A）：eligible 的 request 裡 vd 最早的 */
  pick_next_task(rq: Rq<PaperEntity>): Task<PaperEntity> | null {
    this.update(rq);
    charge(rq, 'pick', Math.max(1, Math.ceil(Math.log2(this.active.length + 1))));
    let best: PaperEntity | null = null;
    for (const se of this.active) {
      if (!this.eligible(se)) continue;
      // 平手時論文說任意決定（§3）；Figure 1 的兩次平手都給了 ve 較晚的 request，這裡照圖，再取 pid 較小的
      if (!best || se.vd < best.vd || (se.vd === best.vd && (se.ve > best.ve || (se.ve === best.ve && se.task.pid < best.task.pid)))) best = se;
    }
    // Lemma 1：有 active client 就一定有 eligible request；剩下的只可能是浮點誤差，取 ve 最小的
    if (!best && this.active.length) best = this.active.reduce((a, b) => (b.ve < a.ve ? b : a));
    this.curr = best;
    if (best) best.qStart = rq.clock;
    rq.trace.log(rq.clock, 'EEVDF_dispatch', best?.task.pid, { V: this.V });
    return best?.task ?? null;
  }

  put_prev_task(rq: Rq<PaperEntity>, _prev: Task<PaperEntity>): void {
    this.update(rq);
    this.curr = null;
  }

  task_tick(rq: Rq<PaperEntity>, _curr: Task<PaperEntity>): void {
    this.update(rq);
  }

  next_timer(rq: Rq<PaperEntity>): Ns | null {
    const c = this.curr;
    if (!c) return null;
    // 還沒推進到 rq.clock 的使用量也要算進去
    const used = c.used + (rq.clock - this.last);
    return Math.min(c.qStart + this.tun.quantum, rq.clock + Math.max(0, c.r - used));
  }

  timer_fire(rq: Rq<PaperEntity>): void {
    this.update(rq);
    const c = this.curr;
    if (!c) return;
    const done = c.used >= c.r;
    if (done) {
      // request 用完：Eq. 13，下一個 request 從 ve + u/w 開始
      this.issue(c, this.v(c));
    }
    if (done || rq.clock >= c.qStart + this.tun.quantum) resched_task(rq);
  }

  snapshot(rq: Rq<PaperEntity>): EevdfSnapshot {
    this.update(rq);
    // 圓點畫在 ve（request 的 eligible time），線段到 vd：論文 Figure 1 的 (ve, vd)
    const view = (se: PaperEntity): EntityView => ({
      pid: se.task.pid,
      name: se.task.name,
      weight: se.weight,
      vruntime: se.ve,
      deadline: se.vd,
      vlag: Number.NaN,
      slice: se.r,
      eligible: this.eligible(se),
      sched_delayed: false,
      sum_exec_runtime: se.sum_exec_runtime,
    });
    const others = this.active.filter((se) => se !== this.curr).sort((a, b) => a.ve - b.ve);
    return {
      clock: rq.clock,
      min_vruntime: Math.min(...this.active.map((se) => se.ve), this.V),
      avg_vruntime: this.V,
      load: this.W,
      nr_running: this.active.length,
      curr: this.curr ? view(this.curr) : null,
      timeline: others.map(view),
    };
  }
}
