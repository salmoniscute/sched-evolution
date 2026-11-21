// CLAUDE.md 列的指標：CPU 分配比例、等待時間、喚醒延遲（含 p99）、context switch 次數、決策成本。

import type { SimResult } from './engine.ts';
import type { Ns, OpKind } from './types.ts';
import { nice_to_static_prio, prio_to_weight, MAX_RT_PRIO } from './weights.ts';

export function weight_of_nice(nice: number): number {
  return prio_to_weight[nice_to_static_prio(nice) - MAX_RT_PRIO]!;
}

/** 全部 task 都一直可執行時，按權重分配的理論比例 w_i / Σw */
export function theoreticalShares(nices: readonly number[]): number[] {
  const ws = nices.map(weight_of_nice);
  const total = ws.reduce((a, b) => a + b, 0);
  return ws.map((w) => w / total);
}

/** 最近排名法的百分位數；空陣列回傳 NaN */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export interface TaskSummary {
  pid: number;
  name: string;
  nice: number;
  /** runtime / 總模擬時間 */
  share: number;
  runtime: Ns;
  waitTime: Ns;
  wakeups: number;
  wakeupLatencyAvg: Ns;
  wakeupLatencyP99: Ns;
  wakeupLatencyMax: Ns;
  nvcsw: number;
  nivcsw: number;
}

export interface Summary {
  tasks: TaskSummary[];
  idleShare: number;
  nr_switches: number;
  /**
   * 每次 schedule() 本身平均的資料結構操作成本（deactivate / put_prev / pick_next，含 O(n) 的重算）。
   * tick 與喚醒時的成本不算在內：它們不是「挑下一個」的決策，而且會隨 HZ 與 slice 長度變，
   * 混進來除以 schedule() 次數，task 少、很少切換時數字會被灌大。
   */
  opsPerSchedule: number;
  /** 同上，依用途分開（挑選、進出佇列、重算） */
  opsPerScheduleBy: Record<OpKind, number>;
  /** 整段模擬的總成本（含 tick 與喚醒），除以模擬秒數 */
  opsPerSec: number;
}

export function summarize(r: SimResult): Summary {
  return {
    tasks: r.tasks.map((t) => {
      const lat = t.wakeupLatencies;
      return {
        pid: t.pid,
        name: t.name,
        nice: t.nice,
        share: t.runtime / r.duration,
        runtime: t.runtime,
        waitTime: t.waitTime,
        wakeups: lat.length,
        wakeupLatencyAvg: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : Number.NaN,
        wakeupLatencyP99: percentile(lat, 99),
        wakeupLatencyMax: lat.length ? Math.max(...lat) : Number.NaN,
        nvcsw: t.nvcsw,
        nivcsw: t.nivcsw,
      };
    }),
    idleShare: r.idleTime / r.duration,
    nr_switches: r.nr_switches,
    opsPerSchedule: r.nr_schedule ? (r.schedOpsBy.pick + r.schedOpsBy.queue + r.schedOpsBy.recalc) / r.nr_schedule : 0,
    opsPerScheduleBy: {
      pick: r.nr_schedule ? r.schedOpsBy.pick / r.nr_schedule : 0,
      queue: r.nr_schedule ? r.schedOpsBy.queue / r.nr_schedule : 0,
      recalc: r.nr_schedule ? r.schedOpsBy.recalc / r.nr_schedule : 0,
    },
    opsPerSec: r.ops / (r.duration / 1e9),
  };
}
