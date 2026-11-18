import { Simulator, type SimConfig } from '../src/core/engine.ts';
import { summarize } from '../src/core/metrics.ts';
import { NSEC_PER_SEC, type SchedClass, type TaskSpec } from '../src/core/types.ts';
import { CfsV2_6_24 } from '../src/sched/cfs-v2.6.24.ts';
import { EevdfV6_6 } from '../src/sched/eevdf-v6.6.ts';
import { EevdfV6_12 } from '../src/sched/eevdf-v6.12.ts';
import { O1V2_6_0 } from '../src/sched/o1-v2.6.0.ts';
import { OnV2_4_0 } from '../src/sched/on-v2.4.0.ts';

export const hog = (name: string, nice = 0, arrival = 0): TaskSpec => ({
  name,
  nice,
  arrival,
  pattern: [{ run: Infinity, sleep: 0 }],
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function run<S extends SchedClass<any>>(
  sched: S,
  specs: TaskSpec[],
  cfg: Partial<SimConfig> = {},
) {
  const sim = new Simulator(sched, specs, { duration: 10 * NSEC_PER_SEC, ...cfg });
  const result = sim.run();
  return { sched, sim, result, summary: summarize(result) };
}

/** 所有排程器都要通過的共通測試用 */
export const schedulers: [string, () => SchedClass<any>][] = [
  ['cfs-v2.6.24', () => new CfsV2_6_24()],
  ['eevdf-v6.6', () => new EevdfV6_6()],
  ['eevdf-v6.12-slice', () => new EevdfV6_12()],
];

/** O(n)、O(1)：沒有比例分享與 vruntime，只跑和這些無關的共通測試。第三欄是 HZ */
export const legacySchedulers: [string, () => SchedClass<any>, number][] = [
  ['on-v2.4.0', () => new OnV2_4_0(), 100],
  ['o1-v2.6.0', () => new O1V2_6_0(), 1000],
];
