// GPS 流體參考：理想模型本身的正確性，以及各排程器相對於 GPS 的 lag。
import { describe, expect, it } from 'vitest';
import { theoreticalShares } from '../src/core/metrics.ts';
import { NSEC_PER_MSEC as MS, NSEC_PER_SEC as SEC, type TaskSpec } from '../src/core/types.ts';
import { GpsShadow, simulateGps } from '../src/ref/gps.ts';
import { CfsV2_6_24 } from '../src/sched/cfs-v2.6.24.ts';
import { EevdfV6_6 } from '../src/sched/eevdf-v6.6.ts';
import { hog, run, schedulers } from './helpers.ts';

// 時間刻意不對齊 tick（見 CLAUDE.md 比較情境的注意事項）
const editor: TaskSpec = { name: 'editor', nice: 0, pattern: [{ run: 1.3 * MS, sleep: 8.7 * MS }] };

describe('simulateGps：理想流體模型', () => {
  it.each([[[0, 0]], [[-5, 0, 5]], [[-10, 0, 10, 19]]])('全是 hog 時比例精確等於 w_i / Σw（nice %j）', (nices) => {
    const g = simulateGps(nices.map((n, i) => hog(`t${i}`, n)), { duration: SEC });
    const theory = theoreticalShares(nices);
    g.tasks.forEach((t, i) => expect(t.runtime / SEC).toBeCloseTo(theory[i]!, 9));
    expect(g.idleTime).toBe(0);
  });

  it('editor + 2 個 compile：editor 醒來只拿 1/3 的速率，1.3ms 的 burst 要 3.9ms 才跑完', () => {
    const g = simulateGps([editor, hog('cc1'), hog('cc2')], { duration: SEC });
    const ed = g.tasks[0]!;
    for (const r of ed.burstResponse) expect(r).toBeCloseTo(3.9 * MS, 3);
    // 週期 3.9 + 8.7 = 12.6ms，1 秒內 80 段 burst 都跑完（第 80 段在 999.3ms 結束）
    expect(ed.burstResponse).toHaveLength(80);
    expect(ed.runtime).toBeCloseTo(80 * 1.3 * MS, 3);
  });

  it('有 idle 時：runtime 總和 + idle = 總時間，晚到的 task 從 arrival 開始', () => {
    const specs: TaskSpec[] = [
      { name: 'a', nice: 0, pattern: [{ run: 2 * MS, sleep: 7 * MS }] },
      { name: 'b', nice: 5, arrival: 30 * MS, pattern: [{ run: 5 * MS, sleep: 3 * MS }] },
    ];
    const g = simulateGps(specs, { duration: SEC });
    const used = g.tasks.reduce((s, t) => s + t.runtime, 0);
    expect(used + g.idleTime).toBeCloseTo(SEC, 3);
    expect(g.idleTime).toBeGreaterThan(0);
    // 只有一個 task 可執行時，它拿到全部 CPU：a 的前幾段 burst 剛好 2ms
    expect(g.tasks[0]!.burstResponse[0]).toBeCloseTo(2 * MS, 6);
  });
});

describe.each(schedulers)('GpsShadow 跟著 %s', (_id, make) => {
  const mixed = [editor, hog('cc1', 0), hog('cc2', 5)];

  it('s_i 等於引擎記錄的 runtime；Σ lag_i = 0（工作守恆）', () => {
    const sh = new GpsShadow();
    const { result } = run(make(), mixed, { duration: SEC, observers: [sh] });
    sh.states.forEach((st, i) => expect(st.s).toBe(result.tasks[i]!.runtime));
    const sum = sh.states.reduce((a, st) => a + (st.S - st.s), 0);
    expect(Math.abs(sum)).toBeLessThan(1e-3);
  });

  it('只有一個 task 時 lag 恆為 0', () => {
    const sh = new GpsShadow();
    run(make(), [hog('only')], { duration: SEC, observers: [sh] });
    expect(sh.states[0]!.lagMin).toBe(0);
    expect(sh.states[0]!.lagMax).toBe(0);
  });

  it('record 模式的樣本：V 單調遞增，最後一筆 lag 和 lag() 一致', () => {
    const sh = new GpsShadow({ record: true });
    run(make(), mixed, { duration: 200 * MS, observers: [sh] });
    for (let i = 1; i < sh.samples.length; i++) expect(sh.samples[i]!.V).toBeGreaterThanOrEqual(sh.samples[i - 1]!.V);
    const last = sh.samples.at(-1)!;
    last.lag.forEach((l, i) => expect(l).toBeCloseTo(sh.lag(i + 1), 6));
  });
});

describe('理論與實作的差異（用 GPS lag 量化）', () => {
  it('EEVDF v6.6：lag 落在論文的上下界內，但 request 大小要用「被 tick 放大後」的值', () => {
    // 論文：−r_max < lag < max(r_max, q)。slice 是 0.75ms，但沒有 HRTICK 時
    // 只能在 tick（1ms）發現 slice 用完，實際的 request 變成 1ms。
    const rEff = Math.max(750_000, MS);
    let exceedsNominal = false;
    for (const specs of [[hog('a'), hog('b')], [hog('a', -5), hog('b'), hog('c', 5)], [editor, hog('cc1'), hog('cc2')]]) {
      const sh = new GpsShadow();
      run(new EevdfV6_6(), specs, { duration: 2 * SEC, observers: [sh] });
      for (const st of sh.states) {
        expect(st.lagMin).toBeGreaterThan(-rEff);
        expect(st.lagMax).toBeLessThan(rEff);
        if (st.lagMin < -750_000) exceedsNominal = true;
      }
    }
    // 用名目 slice 0.75ms 當 r_max 的話，下界會被打破
    expect(exceedsNominal).toBe(true);
  });

  it('CFS v2.6.24：喚醒補償讓互動型 task 的 lag 一路變負（拿得比 GPS 多），EEVDF 則有界', () => {
    const lagOf = (make: () => CfsV2_6_24 | EevdfV6_6, duration: number) => {
      const sh = new GpsShadow();
      const { summary } = run(make(), [editor, hog('cc1'), hog('cc2')], { duration, observers: [sh] });
      return { lagMin: sh.states[0]!.lagMin, share: summary.tasks[0]!.share };
    };
    const gpsShare = simulateGps([editor, hog('cc1'), hog('cc2')], { duration: SEC }).tasks[0]!.runtime / SEC;

    const cfs1 = lagOf(() => new CfsV2_6_24(), SEC);
    const cfs2 = lagOf(() => new CfsV2_6_24(), 2 * SEC);
    expect(cfs1.share).toBeGreaterThan(gpsShare + 0.01);
    // 每個週期都多拿一點，lag 隨時間線性累積
    expect(cfs2.lagMin).toBeLessThan(1.8 * cfs1.lagMin);
    expect(cfs1.lagMin).toBeLessThan(-50 * MS);

    const eevdf2 = lagOf(() => new EevdfV6_6(), 2 * SEC);
    expect(eevdf2.lagMin).toBeGreaterThan(-MS);
    expect(Math.abs(eevdf2.share - gpsShare)).toBeLessThan(0.002);
  });
});
