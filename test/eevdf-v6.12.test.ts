// EEVDF v6.12 選項：custom_slice、PREEMPT_SHORT、DELAY_DEQUEUE / DELAY_ZERO、fork 的 ENQUEUE_INITIAL。
import { describe, expect, it } from 'vitest';
import { NSEC_PER_MSEC as MS, NSEC_PER_SEC as SEC, NSEC_PER_USEC as US, type TaskSpec } from '../src/core/types.ts';
import { GpsShadow, simulateGps } from '../src/ref/gps.ts';
import { EevdfV6_6 } from '../src/sched/eevdf-v6.6.ts';
import { EevdfV6_12, SLICE_MAX, SLICE_MIN, defaultTunablesV6_12 as d } from '../src/sched/eevdf-v6.12.ts';
import { hog, run } from './helpers.ts';

// 比較情境 4：低延遲的 audio（時間不對齊 tick）+ 兩個 compile
const audio = (slice?: number): TaskSpec => ({ name: 'audio', nice: 0, slice, pattern: [{ run: 310 * US, sleep: 4730 * US }] });
const scenario4 = (a: TaskSpec) => [a, hog('cc1'), hog('cc2')];
const without = (f: 'DELAY_DEQUEUE' | 'PREEMPT_SHORT' | 'DELAY_ZERO') => ({ ...d, features: { ...d.features, [f]: false } });

describe('custom_slice（__setscheduler_params）', () => {
  it.each([
    [undefined, 750 * US, false],
    [300 * US, 300 * US, true],
    [10 * US, SLICE_MIN, true],
    [SEC, SLICE_MAX, true],
  ])('sched_runtime = %s → slice %d，custom_slice = %s', (req, slice, custom) => {
    const { sim } = run(new EevdfV6_12(), [{ ...hog('a'), slice: req }], { duration: 10 * MS });
    expect(sim.tasks[0]!.se.slice).toBe(slice);
    expect(sim.tasks[0]!.se.custom_slice).toBe(custom);
  });

  it('v6.6 忽略 slice 欄位', () => {
    const { sim } = run(new EevdfV6_6(), [{ ...hog('a'), slice: 300 * US }], { duration: 10 * MS });
    expect(sim.tasks[0]!.se.slice).toBe(750 * US);
  });
});

describe('比較情境 4：短 slice 的低延遲', () => {
  const lat = (make: () => EevdfV6_6, a: TaskSpec) => run(make(), scenario4(a), { duration: 2 * SEC }).summary.tasks[0]!;

  it('v6.6 無法表達：audio 平均要等 > 0.4ms（等 tick，或等 lag 回到 0）', () => {
    expect(lat(() => new EevdfV6_6(), audio()).wakeupLatencyAvg).toBeGreaterThan(400 * US);
  });

  it('v6.12 + slice 0.3ms：醒來幾乎馬上上 CPU', () => {
    const t = lat(() => new EevdfV6_12(), audio(300 * US));
    expect(t.wakeupLatencyAvg).toBeLessThan(50 * US);
    expect(t.wakeupLatencyP99).toBeLessThan(100 * US);
  });

  it('v6.12 但沒設 slice：和 v6.6 一樣慢（延遲要靠 custom_slice 表達）', () => {
    expect(lat(() => new EevdfV6_12(), audio()).wakeupLatencyAvg).toBeGreaterThan(400 * US);
  });

  it('關掉 DELAY_DEQUEUE：短 slice 失效。audio 帶著負 lag 醒來、不 eligible，PREEMPT_SHORT 不成立', () => {
    expect(lat(() => new EevdfV6_12(without('DELAY_DEQUEUE')), audio(300 * US)).wakeupLatencyAvg).toBeGreaterThan(400 * US);
  });

  it('關掉 PREEMPT_SHORT：被 curr 的 RUN_TO_PARITY 保護擋住', () => {
    expect(lat(() => new EevdfV6_12(without('PREEMPT_SHORT')), audio(300 * US)).wakeupLatencyAvg).toBeGreaterThan(200 * US);
  });
});

describe('DELAY_DEQUEUE / DELAY_ZERO', () => {
  it('被延後的 entity 被選中時一定已經 eligible，DELAY_ZERO 後 vlag 剛好是 0', () => {
    const { result } = run(new EevdfV6_12(), scenario4(audio(300 * US)), { duration: SEC, trace: true });
    const delayed = result.trace.events.filter((e) => e.fn === 'dequeue_entity' && e.data?.delayed);
    const finished = result.trace.events.filter((e) => e.fn === 'finish_delayed_dequeue_entity');
    expect(delayed.length).toBeGreaterThan(100);
    expect(finished.length).toBeGreaterThan(100);
    for (const e of finished) expect(e.data!.vlag).toBe(0);
  });

  it('PREEMPT_SHORT 確實觸發', () => {
    const { result } = run(new EevdfV6_12(), scenario4(audio(300 * US)), { duration: SEC, trace: true });
    expect(result.trace.events.filter((e) => e.fn === 'do_preempt_short').length).toBeGreaterThan(100);
  });

  it('理論與實作的差異：睡眠中還掉的負 lag，以 GPS（睡眠時 lag 凍結）來看等於被原諒', () => {
    const sh = new GpsShadow();
    const { summary } = run(new EevdfV6_12(), scenario4(audio(300 * US)), { duration: 2 * SEC, observers: [sh] });
    const gpsShare = simulateGps(scenario4(audio()), { duration: 2 * SEC }).tasks[0]!.runtime / (2 * SEC);
    // audio 拿到全部需求 310 / (310 + 4730) ≈ 6.15%，GPS 只給 5.49%
    expect(summary.tasks[0]!.share).toBeCloseTo(310 / 5040, 3);
    expect(summary.tasks[0]!.share).toBeGreaterThan(gpsShare + 0.005);
    expect(sh.states[0]!.lagMin).toBeLessThan(-50 * MS);
  });
});

describe('fork：ENQUEUE_INITIAL', () => {
  // 晚到的 task 最後一次 place_entity 的 deadline − vruntime
  const forkVslice = (make: () => EevdfV6_6) => {
    const { result } = run(make(), [hog('a'), hog('b', 0, 10.3 * MS)], { duration: 20 * MS, trace: true });
    const places = result.trace.events.filter((e) => e.fn === 'place_entity' && e.pid === 2);
    const last = places.at(-1)!.data!;
    return (last.deadline as number) - (last.vruntime as number);
  };

  it('v6.6：第二次 place_entity 覆蓋成完整 slice', () => expect(forkVslice(() => new EevdfV6_6())).toBe(750 * US));
  it('v6.12：保留半個 slice', () => expect(forkVslice(() => new EevdfV6_12())).toBe(375 * US));
});
