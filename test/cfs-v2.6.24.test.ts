// CFS v2.6.24 特有的行為。共通性質（nice 比例、不變式）在 common.test.ts。
import { describe, expect, it } from 'vitest';
import { NSEC_PER_MSEC as MS, NSEC_PER_SEC as SEC } from '../src/core/types.ts';
import { nice_to_static_prio, set_load_weight } from '../src/core/weights.ts';
import { CfsV2_6_24, calc_delta_fair } from '../src/sched/cfs-v2.6.24.ts';
import { hog, run } from './helpers.ts';

describe('calc_delta_fair（kernel/sched.c:752 的定點運算）', () => {
  it('nice 0 不變', () => {
    expect(calc_delta_fair(MS, set_load_weight(nice_to_static_prio(0)))).toBe(MS);
  });

  it('nice 5（weight 335）的虛擬時間約為實際時間 × 1024/335', () => {
    const v = calc_delta_fair(MS, set_load_weight(nice_to_static_prio(5)));
    expect(v).toBeCloseTo((MS * 1024) / 335, -3); // 誤差 < 1µs
  });

  it('超過 2^32 的乘積走另一條捨入路徑，結果仍接近精確值', () => {
    const delta = 50 * MS; // 50ms × 1024 > 2^32
    const v = calc_delta_fair(delta, set_load_weight(nice_to_static_prio(-5)));
    expect(v).toBeCloseTo((delta * 1024) / 3121, -4);
  });
});

describe('相鄰 nice', () => {
  it('相差約 1.25 倍', () => {
    const { summary } = run(new CfsV2_6_24(), [hog('a', 0), hog('b', 1)]);
    const [a, b] = summary.tasks;
    expect(a!.runtime / b!.runtime).toBeCloseTo(1024 / 820, 1);
  });
});

describe('slice 與 tick', () => {
  it('兩個 nice 0 的 hog：sched_slice = 20ms × 1024/2048 = 10ms', () => {
    const { sched, sim } = run(new CfsV2_6_24(), [hog('a'), hog('b')], { duration: SEC });
    expect(sched.sched_slice(sched.cfs_rq, sim.tasks[0]!.se)).toBe(10 * MS);
  });

  it('check_preempt_tick 用「>」比較，所以 HZ=1000 時每段實際跑 11ms', () => {
    const { summary } = run(new CfsV2_6_24(), [hog('a'), hog('b')], { duration: SEC });
    // 1s / 11ms ≈ 90 次切換（第一次從 idle 切入也算一次）
    expect(summary.nr_switches).toBeGreaterThanOrEqual(89);
    expect(summary.nr_switches).toBeLessThanOrEqual(92);
  });

  it('task 多於 sched_nr_latency(5) 時，period 按比例拉長', () => {
    const sched = new CfsV2_6_24();
    expect(sched.__sched_period(5)).toBe(20 * MS);
    expect(sched.__sched_period(10)).toBe(40 * MS);
  });
});

describe('互動型 + 批次型：睡眠補償', () => {
  it('跑 1ms 睡 9ms 的 task 拿到自己要的 ~10%，且喚醒延遲低', () => {
    const { summary } = run(new CfsV2_6_24(), [
      hog('compile'),
      { name: 'editor', nice: 0, pattern: [{ run: MS, sleep: 9 * MS }] },
    ]);
    const editor = summary.tasks[1]!;
    expect(editor.share).toBeGreaterThan(0.095);
    expect(editor.share).toBeLessThan(0.105);
    // 睡醒時 vruntime 遠小於 compile，超過 wakeup_granularity → 立即搶佔
    expect(editor.wakeupLatencyP99).toBe(0);
  });

  it('需求低於公平份額（50%）時，需求全部滿足：睡眠補償讓 burst 一次跑完', () => {
    const run_ = 2.2 * MS;
    const sleep = 3.13 * MS;
    const { summary } = run(new CfsV2_6_24(), [
      hog('compile'),
      { name: 'editor', nice: 0, arrival: 0.123 * MS, pattern: [{ run: run_, sleep }] },
    ]);
    expect(summary.tasks[1]!.share).toBeCloseTo(run_ / (run_ + sleep), 2);
  });
});
