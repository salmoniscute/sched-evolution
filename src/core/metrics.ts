// CLAUDE.md 列的指標：CPU 分配比例、等待時間、喚醒延遲（含 p99）、context switch 次數、決策成本。

import type { SimResult } from './engine.ts';
import type { Ns } from './types.ts';
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
  /** 每次 schedule() 平均的資料結構操作成本 */
  opsPerSchedule: number;
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
    opsPerSchedule: r.nr_schedule ? r.ops / r.nr_schedule : 0,
  };
}
