// O(n) 2.4.0：NICE_TO_TICKS、goodness()、counter 重算，以及成本隨 task 數線性成長。
import { describe, expect, it } from 'vitest';
import { NSEC_PER_MSEC as MS, NSEC_PER_SEC as SEC } from '../src/core/types.ts';
import { NICE_TO_TICKS, OnV2_4_0, goodness, type OnSnapshot } from '../src/sched/on-v2.4.0.ts';
import { RunRecorder } from '../src/ref/recorder.ts';
import { hog, run } from './helpers.ts';

const HZ = 100;

describe('常數', () => {
  it('NICE_TO_TICKS（HZ = 100）：nice −20 → 11、0 → 6、19 → 1', () => {
    expect(NICE_TO_TICKS(HZ, -20)).toBe(11);
    expect(NICE_TO_TICKS(HZ, 0)).toBe(6);
    expect(NICE_TO_TICKS(HZ, 19)).toBe(1);
    expect(NICE_TO_TICKS(1000, 0)).toBe(41);
  });
  it('goodness：counter 是 0 就是 0；否則 counter + 20 − nice，同 mm 再加 1', () => {
    expect(goodness(0, -20, 1, 1)).toBe(0);
    expect(goodness(6, 0, 1, 2)).toBe(26);
    expect(goodness(6, 0, 1, 1)).toBe(27);
    expect(goodness(1, 19, 1, null)).toBe(2);
  });
});

describe('排程行為', () => {
  it('CPU-bound 的 task 照 counter（時間片）分', () => {
    const { summary } = run(new OnV2_4_0(), [hog('a', -5), hog('b', 0), hog('c', 5)], { duration: 20 * SEC, hz: HZ });
    const total = 7 + 6 + 4;
    expect(summary.tasks[0]!.share).toBeCloseTo(7 / total, 2);
    expect(summary.tasks[1]!.share).toBeCloseTo(6 / total, 2);
    expect(summary.tasks[2]!.share).toBeCloseTo(4 / total, 2);
  });

  it('睡著的 task 重算後 counter 累積，上限約兩倍（c = c/2 + 6 的不動點是 11）', () => {
    const rec = new RunRecorder();
    run(new OnV2_4_0(), [hog('a'), hog('b'), { name: 's', nice: 0, arrival: 5 * MS, pattern: [{ run: 1 * MS, sleep: 10 * SEC }] }], {
      duration: 3 * SEC,
      hz: HZ,
      observers: [rec],
    });
    const s = rec.events.at(-1)!.snapshot as OnSnapshot;
    expect(s.recalcs).toBeGreaterThan(10);
    expect(s.sleepers.find((x) => x.pid === 3)!.counter).toBe(11);
  });

  it('每次挑選的成本和 task 數量成正比', () => {
    const cost = (n: number) =>
      run(
        new OnV2_4_0(),
        Array.from({ length: n }, (_, i) => hog(`t${i}`)),
        { duration: 2 * SEC, hz: HZ },
      ).summary.opsPerSchedule;
    // 每次 schedule() 掃 n + 1 次 goodness()（prev 先算一次），重算時再加 n
    expect(cost(64) / cost(8)).toBeGreaterThan(5);
    expect(cost(64)).toBeGreaterThan(64);
  });

  it('tick dodging：每 10ms 跑 9.4ms、在 tick 前睡著的 task 幾乎不被扣 counter', () => {
    const cheat = { name: 'cheat', nice: 0, pattern: [{ run: 9.4 * MS, sleep: 0.6 * MS }] };
    const { summary } = run(new OnV2_4_0(), [cheat, hog('a'), hog('b')], { duration: 2 * SEC, hz: HZ });
    expect(summary.tasks[0]!.share).toBeGreaterThan(0.8);
  });
});
