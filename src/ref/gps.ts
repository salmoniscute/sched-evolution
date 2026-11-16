// GPS（Generalized Processor Sharing）流體模型：比例分享排程的理想參考。
//
// 理論：CPU 像流體一樣，同時分給所有可執行的 task，task i 拿到的速率是
//
//   dS_i/dt = w_i / W(t)，   W(t) = Σ_{j ∈ runnable(t)} w_j
//
// 虛擬時間 V 以 nice 0 的 task 為單位前進：dV/dt = NICE_0_LOAD / W(t)。
// 所以 runnable 的 task 都滿足 dS_i = (w_i / NICE_0_LOAD) · dV，和 vruntime 的換算相同。
//
// 真實排程器一次只能讓一個 task 跑，和 GPS 的差就是 lag：
//
//   lag_i = S_i − s_i     （應得 − 實得；> 0 表示被虧欠）
//
// 這正是 v6.6 kernel/sched/fair.c 註解裡的 lag_i = S − s_i = w_i · (V − v_i)。
//
// 這個檔案提供兩種參考：
//   GpsShadow   ── 跟著真實模擬跑：依照真實排程器每個時刻的 runnable 集合算 S_i，得到 lag。
//   simulateGps ── 獨立的流體模擬：同一組工作負載在理想 GPS 下會怎麼跑（burst 的完成時間也跟著變）。
//
// 時間在這裡是實數（流體模型），不像引擎一律是整數 ns。

import type { SimObserver } from '../core/engine.ts';
import { weight_of_nice } from '../core/metrics.ts';
import type { Ns, Task, TaskSpec } from '../core/types.ts';
import { NICE_0_LOAD } from '../core/weights.ts';

// ---------------------------------------------------------------------------
// GpsShadow：真實排程器相對於 GPS 的 lag
// ---------------------------------------------------------------------------

export interface ShadowTaskState {
  pid: number;
  name: string;
  weight: number;
  /** GPS 下應得的服務 S_i */
  S: number;
  /** 實際拿到的服務 s_i */
  s: number;
  /** 觀察期間 lag 的最小值 / 最大值（ns） */
  lagMin: number;
  lagMax: number;
}

export interface ShadowSample {
  t: Ns;
  /** GPS 的虛擬時間 */
  V: number;
  /** 依 pid 排列（index = pid − 1）；尚未出現的 task 為 0 */
  lag: number[];
}

/**
 * 影子 GPS。task 不在 runnable 集合時（睡眠中、尚未建立）不累積 S_i，lag 凍結。
 * 這等於假設「離開時帶走 lag、回來時帶回 lag」，和 v6.6 保留 se->vlag 的語意相同；
 * 論文另外討論了離開時丟棄 lag 的策略，這裡不採用。
 *
 * lag 是分段線性的函數，極值只會出現在事件邊界，所以 lagMin / lagMax 是精確值。
 */
export class GpsShadow implements SimObserver {
  /** GPS 虛擬時間 */
  V = 0;
  readonly samples: ShadowSample[] = [];
  private readonly tasks = new Map<number, ShadowTaskState>();

  constructor(private readonly opts: { record?: boolean } = {}) {}

  onAdvance(t0: Ns, t1: Ns, curr: Task<unknown> | null, runnable: readonly Task<unknown>[]): void {
    const dt = t1 - t0;
    for (const p of runnable) this.state(p);
    if (curr) this.state(curr).s += dt;

    const W = runnable.reduce((sum, p) => sum + this.state(p).weight, 0);
    if (W > 0) {
      this.V += (dt * NICE_0_LOAD) / W;
      for (const p of runnable) {
        const st = this.state(p);
        st.S += (dt * st.weight) / W;
      }
    }

    for (const st of this.tasks.values()) {
      const lag = st.S - st.s;
      if (lag < st.lagMin) st.lagMin = lag;
      if (lag > st.lagMax) st.lagMax = lag;
    }
    if (this.opts.record) {
      const lag: number[] = [];
      for (const st of this.tasks.values()) lag[st.pid - 1] = st.S - st.s;
      for (let i = 0; i < lag.length; i++) lag[i] ??= 0;
      this.samples.push({ t: t1, V: this.V, lag });
    }
  }

  /** lag_i = S_i − s_i（ns，服務時間） */
  lag(pid: number): number {
    const st = this.tasks.get(pid);
    return st ? st.S - st.s : 0;
  }

  /** 虛擬 lag：lag_i · NICE_0_LOAD / w_i，可以直接和 kernel 的 se->vlag（V − v_i）比較 */
  vlag(pid: number): number {
    const st = this.tasks.get(pid);
    return st ? ((st.S - st.s) * NICE_0_LOAD) / st.weight : 0;
  }

  /** 依 pid 排序的狀態 */
  get states(): ShadowTaskState[] {
    return [...this.tasks.values()].sort((a, b) => a.pid - b.pid);
  }

  private state(p: Task<unknown>): ShadowTaskState {
    let st = this.tasks.get(p.pid);
    if (!st) {
      st = { pid: p.pid, name: p.name, weight: weight_of_nice(p.nice), S: 0, s: 0, lagMin: 0, lagMax: 0 };
      this.tasks.set(p.pid, st);
    }
    return st;
  }
}

// ---------------------------------------------------------------------------
// simulateGps：同一組工作負載在理想 GPS 下的結果
// ---------------------------------------------------------------------------

export interface GpsTaskStats {
  pid: number;
  name: string;
  nice: number;
  runtime: number;
  /**
   * 每段 burst 的回應時間：從開始可執行（建立 / 喚醒 / 前一段結束）到這段 burst 跑完。
   * GPS 沒有「等 CPU」這件事（喚醒延遲恆為 0），所以用回應時間來比較。
   */
  burstResponse: number[];
}

export interface GpsResult {
  duration: Ns;
  idleTime: number;
  /** 模擬結束時的虛擬時間 */
  V: number;
  tasks: GpsTaskStats[];
}

interface FluidTask {
  spec: TaskSpec;
  stats: GpsTaskStats;
  weight: number;
  state: 'NEW' | 'RUNNING' | 'SLEEPING';
  burstIdx: number;
  left: number;
  burstStart: number;
  wakeAt: number;
}

/** 剩餘量小於這個值（ns）就視為跑完，吸收浮點誤差 */
const EPS = 1e-3;

export function simulateGps(specs: readonly TaskSpec[], cfg: { duration: Ns }): GpsResult {
  const end = cfg.duration;
  const tasks: FluidTask[] = specs.map((spec, i) => {
    if (spec.pattern.length === 0) throw new Error(`task ${spec.name}: empty pattern`);
    return {
      spec,
      stats: { pid: i + 1, name: spec.name, nice: spec.nice, runtime: 0, burstResponse: [] },
      weight: weight_of_nice(spec.nice),
      state: 'NEW',
      burstIdx: 0,
      left: 0,
      burstStart: 0,
      wakeAt: Infinity,
    };
  });

  let t = 0;
  let V = 0;
  let idleTime = 0;

  const startBurst = (ft: FluidTask, now: number) => {
    ft.state = 'RUNNING';
    ft.left = ft.spec.pattern[ft.burstIdx]!.run;
    ft.burstStart = now;
    ft.wakeAt = Infinity;
  };

  // 和引擎相同的事件順序：burst 結束 → 新 task → 喚醒
  const handleEvents = () => {
    for (const ft of tasks) {
      if (ft.state !== 'RUNNING' || ft.left > EPS) continue;
      ft.stats.burstResponse.push(t - ft.burstStart);
      const { sleep } = ft.spec.pattern[ft.burstIdx]!;
      ft.burstIdx = (ft.burstIdx + 1) % ft.spec.pattern.length;
      if (sleep > 0) {
        ft.state = 'SLEEPING';
        ft.wakeAt = t + sleep;
      } else {
        startBurst(ft, t);
      }
    }
    for (const ft of tasks) {
      if (ft.state === 'NEW' && (ft.spec.arrival ?? 0) <= t) startBurst(ft, t);
    }
    for (const ft of tasks) {
      if (ft.state === 'SLEEPING' && ft.wakeAt <= t) startBurst(ft, t);
    }
  };

  handleEvents();
  while (t < end) {
    const runnable = tasks.filter((ft) => ft.state === 'RUNNING');
    const W = runnable.reduce((sum, ft) => sum + ft.weight, 0);

    let next = end;
    let finisher: FluidTask | null = null;
    let finisherDone = Infinity;
    for (const ft of runnable) {
      // 以速率 w_i / W 消耗剩餘的 burst
      const done = t + (ft.left * W) / ft.weight;
      if (done < finisherDone) {
        finisherDone = done;
        finisher = ft;
      }
    }
    next = Math.min(next, finisherDone);
    for (const ft of tasks) {
      if (ft.state === 'NEW') next = Math.min(next, ft.spec.arrival ?? 0);
      else if (ft.state === 'SLEEPING') next = Math.min(next, ft.wakeAt);
    }

    const dt = next - t;
    if (W > 0) {
      V += (dt * NICE_0_LOAD) / W;
      for (const ft of runnable) {
        const served = (dt * ft.weight) / W;
        ft.stats.runtime += served;
        ft.left -= served;
      }
    } else {
      idleTime += dt;
    }
    t = next;
    // 決定下一個事件的那個 task 一定跑完（避免浮點誤差讓它多出一點點）
    if (finisher && finisherDone <= next) finisher.left = 0;
    if (t >= end) break;
    handleEvents();
  }

  return { duration: end, idleTime, V, tasks: tasks.map((ft) => ft.stats) };
}
