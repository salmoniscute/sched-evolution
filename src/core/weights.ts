// nice → 權重。數值對照 v2.6.24 kernel/sched.c:813（prio_to_weight[]）與 :829（prio_to_wmult[]）。
// v6.6 的 sched_prio_to_weight[]（kernel/sched/core.c:11542）數值相同。

export const MAX_RT_PRIO = 100;
export const NICE_0_LOAD = 1024;

// prettier-ignore
export const prio_to_weight: readonly number[] = [
  /* -20 */ 88761, 71755, 56483, 46273, 36291,
  /* -15 */ 29154, 23254, 18705, 14949, 11916,
  /* -10 */  9548,  7620,  6100,  4904,  3906,
  /*  -5 */  3121,  2501,  1991,  1586,  1277,
  /*   0 */  1024,   820,   655,   526,   423,
  /*   5 */   335,   272,   215,   172,   137,
  /*  10 */   110,    87,    70,    56,    45,
  /*  15 */    36,    29,    23,    18,    15,
];

// prettier-ignore
export const prio_to_wmult: readonly number[] = [
  /* -20 */     48388,     59856,     76040,     92818,    118348,
  /* -15 */    147320,    184698,    229616,    287308,    360437,
  /* -10 */    449829,    563644,    704093,    875809,   1099582,
  /*  -5 */   1376151,   1717300,   2157191,   2708050,   3363326,
  /*   0 */   4194304,   5237765,   6557202,   8165337,  10153587,
  /*   5 */  12820798,  15790321,  19976592,  24970740,  31350126,
  /*  10 */  39045157,  49367440,  61356676,  76695844,  95443717,
  /*  15 */ 119304647, 148102320, 186737708, 238609294, 286331153,
];

export function nice_to_static_prio(nice: number): number {
  if (!Number.isInteger(nice) || nice < -20 || nice > 19) {
    throw new RangeError(`nice must be an integer in -20..19, got ${nice}`);
  }
  return MAX_RT_PRIO + 20 + nice;
}

/** struct load_weight */
export interface LoadWeight {
  weight: number;
  inv_weight: number;
}

/** set_load_weight()（v2.6.24 kernel/sched.c:921），只處理 SCHED_NORMAL */
export function set_load_weight(static_prio: number): LoadWeight {
  const idx = static_prio - MAX_RT_PRIO;
  return { weight: prio_to_weight[idx]!, inv_weight: prio_to_wmult[idx]! };
}
