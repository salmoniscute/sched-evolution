// O(1) 2.6.0：巨集換算出來的常數、prio_array 的行為、sleep_avg 的互動性估計。
import { describe, expect, it } from 'vitest';
import { NSEC_PER_MSEC as MS, NSEC_PER_SEC as SEC } from '../src/core/types.ts';
import { O1Params, O1V2_6_0, defaultTunables, type O1Snapshot } from '../src/sched/o1-v2.6.0.ts';
import { RunRecorder } from '../src/ref/recorder.ts';
import { scenarios } from '../src/scenarios.ts';
import { hog, run } from './helpers.ts';

const P = new O1Params(1000);
const prio = (nice: number) => 120 + nice;

describe('常數（HZ = 1000）', () => {
  it('時間片：nice −20 → 200ms、0 → 102ms、19 → 10ms', () => {
    expect(P.task_timeslice(prio(-20))).toBe(200);
    expect(P.task_timeslice(prio(0))).toBe(102);
    expect(P.task_timeslice(prio(19))).toBe(10);
    expect(P.task_timeslice(prio(-5))).toBe(126);
    expect(P.task_timeslice(prio(5))).toBe(78);
  });
  it('MAX_SLEEP_AVG = AVG_TIMESLICE × MAX_BONUS = 1020 jiffies', () => {
    expect(P.AVG_TIMESLICE).toBe(102);
    expect(P.MAX_SLEEP_AVG).toBe(1020);
    expect(P.NS_MAX_SLEEP_AVG).toBe(1020 * MS);
  });
  it('DELTA 與 TASK_INTERACTIVE 的門檻（:105 的註解表格）', () => {
    expect(P.DELTA(prio(-20))).toBe(-3);
    expect(P.DELTA(prio(0))).toBe(2);
    expect(P.DELTA(prio(19))).toBe(6);
    // nice 0：bonus ≥ +2 才算互動型
    expect(P.JUST_INTERACTIVE_SLEEP(prio(0))).toBe(815 * MS);
  });
  it('CURRENT_BONUS 與 TIMESLICE_GRANULARITY', () => {
    expect(P.CURRENT_BONUS(0)).toBe(0);
    expect(P.CURRENT_BONUS(1020 * MS)).toBe(10);
    expect(P.TIMESLICE_GRANULARITY(1020 * MS)).toBe(10);
    expect(P.TIMESLICE_GRANULARITY(816 * MS)).toBe(20); // bonus 8
    expect(P.TIMESLICE_GRANULARITY(714 * MS)).toBe(40); // bonus 7
  });
});

describe('排程行為', () => {
  it('CPU-bound 的 task 長期照時間片長度分（不是權重）', () => {
    const { summary } = run(new O1V2_6_0({ ...defaultTunables, parent_sleep_avg: 0 }), [hog('a', -5), hog('b', 0), hog('c', 5)], {
      duration: 20 * SEC,
    });
    const total = 126 + 102 + 78;
    expect(summary.tasks[0]!.share).toBeCloseTo(126 / total, 2);
    expect(summary.tasks[1]!.share).toBeCloseTo(102 / total, 2);
    expect(summary.tasks[2]!.share).toBeCloseTo(78 / total, 2);
  });

  it('沒有互動型 task 時，active 用完才和 expired 交換', () => {
    const rec = new RunRecorder();
    run(new O1V2_6_0({ ...defaultTunables, parent_sleep_avg: 0 }), [hog('a'), hog('b')], { duration: SEC, observers: [rec] });
    const last = rec.events.at(-1)!.snapshot as O1Snapshot;
    // 每 204ms（兩個 102ms 時間片）交換一次
    expect(last.swaps).toBeGreaterThanOrEqual(4);
    // 每次挑選時，被選中的都在 active
    for (const e of rec.events) {
      if (e.kind !== 'pick' || e.next === null) continue;
      const s = e.snapshot as O1Snapshot;
      expect(s.tasks.find((t) => t.pid === e.next)!.array).toBe('active');
    }
  });

  it('fork 時從 shell 繼承 sleep_avg：時間片是一半，bonus +4', () => {
    const rec = new RunRecorder();
    run(new O1V2_6_0(), [hog('a')], { duration: 10 * MS, observers: [rec] });
    const s = rec.events[0]!.snapshot as O1Snapshot;
    expect(s.tasks[0]!.time_slice).toBe(51);
    expect(s.tasks[0]!.sleep_avg).toBe(918 * MS);
    expect(s.tasks[0]!.prio).toBe(116);
  });

  it('i386 的 32 位元 unsigned long：sleep_avg 低、睡得久時 recalc_task_prio() 溢位', () => {
    // sleep_avg 從 0 開始，睡 500ms（< JUST_INTERACTIVE_SLEEP 的 815ms）：500ms × 10 = 5e9 ns > 2^32
    const specs = [{ name: 'a', nice: 0, pattern: [{ run: 0.5 * MS, sleep: 500 * MS }] }];
    const sleepAvg = (bits: 32 | 64) => {
      const s = new O1V2_6_0({ ...defaultTunables, parent_sleep_avg: 0, bits_per_long: bits });
      const r = run(s, specs, { duration: 600 * MS, trace: true });
      const e = r.result.trace.events.find((x) => x.fn === 'recalc_task_prio' && x.data!.path === 'accumulate')!;
      return e.data!.sleep_avg as number;
    };
    expect(sleepAvg(64)).toBe(1020 * MS); // 截在 NS_MAX_SLEEP_AVG
    expect(sleepAvg(32)).toBe(5000 * MS - 2 ** 32); // 約 705ms，比 64 位元少
  });

  it('比較情境 3：cheat 被當成互動型，拿走一半以上的 CPU；關掉 TASK_INTERACTIVE 就回到約三分之一', () => {
    const sc = scenarios.find((s) => s.id === 'cheat')!;
    const share = (f: Partial<typeof defaultTunables.features>) =>
      run(new O1V2_6_0({ ...defaultTunables, features: { ...defaultTunables.features, ...f } }), sc.tasks, { duration: 2 * SEC }).summary.tasks[0]!
        .share;
    expect(share({})).toBeGreaterThan(0.6);
    expect(share({ TASK_INTERACTIVE: false })).toBeLessThan(0.4);
  });

  it('每次挑選的成本和 task 數量無關', () => {
    const cost = (n: number) =>
      run(
        new O1V2_6_0(),
        Array.from({ length: n }, (_, i) => hog(`t${i}`)),
        { duration: 2 * SEC },
      ).summary.opsPerSchedule;
    expect(cost(32)).toBeLessThan(cost(2) * 1.5);
  });
});
