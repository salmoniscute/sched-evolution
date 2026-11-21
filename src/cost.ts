// 比較情境 1：task 一多，每次 schedule() 要花多少。工作負載是 N 個 nice 0 的 CPU-bound task，
// 成本用 Rq.ops 的模型（比較／走訪節點的次數），只算 schedule() 本身（見 Summary.opsPerSchedule）。
// 學習路線第 4 章的小圖與 test/cost.test.ts 共用。
import { Simulator } from './core/engine.ts';
import { summarize } from './core/metrics.ts';
import { NSEC_PER_SEC, type OpKind, type TaskSpec } from './core/types.ts';
import { defaultFlags, variants } from './variants.ts';

export const COST_NS = [1, 2, 4, 8, 16, 32, 64, 128, 256];

/** 畫在圖上的排程器；v6.12 的成本和 v6.6 相同，不另外畫 */
export const COST_VARIANTS = ['on-v2.4.0', 'o1-v2.6.0', 'cfs-v2.6.24', 'eevdf-v6.6'];

export interface CostPoint {
  n: number;
  total: number;
  by: Record<OpKind, number>;
  /** 這段時間內的 context switch 次數 */
  nr_switches: number;
}

export const hogs = (n: number): TaskSpec[] =>
  Array.from({ length: n }, (_, i) => ({ name: `t${i + 1}`, nice: 0, pattern: [{ run: Infinity, sleep: 0 }] }));

export function costAt(variantId: string, n: number, duration = 2 * NSEC_PER_SEC): CostPoint {
  const def = variants.find((v) => v.id === variantId);
  if (!def) throw new Error(`沒有排程器 ${variantId}`);
  const flags = defaultFlags(def);
  const s = summarize(new Simulator(def.make(flags), def.tasks(hogs(n), flags), { duration, hz: def.hz }).run());
  return { n, total: s.opsPerSchedule, by: s.opsPerScheduleBy, nr_switches: s.nr_switches };
}

export function costCurves(ns = COST_NS, ids = COST_VARIANTS): Map<string, CostPoint[]> {
  return new Map(ids.map((id) => [id, ns.map((n) => costAt(id, n))]));
}
