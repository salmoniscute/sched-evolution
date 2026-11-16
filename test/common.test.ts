// 每個排程器都必須滿足的性質。
import { describe, expect, it } from 'vitest';
import { theoreticalShares } from '../src/core/metrics.ts';
import { NSEC_PER_MSEC as MS, NSEC_PER_SEC as SEC } from '../src/core/types.ts';
import { hog, run, schedulers } from './helpers.ts';

describe.each(schedulers)('%s', (_id, make) => {
  describe('比較情境 5：不同 nice 的 CPU 分配比例', () => {
    it.each([[[0, 0]], [[-5, 0, 5]], [[0, 1]], [[-10, 0, 10, 19]]])(
      'nice %j 的實際比例接近 w_i / Σw',
      (nices) => {
        const { summary } = run(make(), nices.map((n, i) => hog(`t${i}`, n)));
        const theory = theoreticalShares(nices);
        summary.tasks.forEach((t, i) => {
          expect(Math.abs(t.share - theory[i]!)).toBeLessThan(0.005);
        });
        expect(summary.idleShare).toBe(0);
      },
    );
  });

  describe('不變式', () => {
    it('min_vruntime 單調遞增', () => {
      const { result } = run(
        make(),
        [hog('a', -3), hog('b', 2), { name: 'c', nice: 0, pattern: [{ run: 3 * MS, sleep: 5 * MS }] }],
        { duration: SEC, trace: true },
      );
      const mins = result.trace.events
        .filter((e) => e.fn === 'update_curr')
        .map((e) => e.data!.min_vruntime as number);
      expect(mins.length).toBeGreaterThan(100);
      for (let i = 1; i < mins.length; i++) expect(mins[i]!).toBeGreaterThanOrEqual(mins[i - 1]!);
    });

    it('所有 task 的 runtime + idle = 總時間', () => {
      const { result } = run(
        make(),
        [
          { name: 'a', nice: 0, pattern: [{ run: 2 * MS, sleep: 7 * MS }] },
          { name: 'b', nice: 5, arrival: 30 * MS, pattern: [{ run: 5 * MS, sleep: 3 * MS }] },
        ],
        { duration: SEC },
      );
      const used = result.tasks.reduce((s, t) => s + t.runtime, 0);
      expect(used + result.idleTime).toBe(result.duration);
    });

    it('同樣輸入結果相同（可重現）', () => {
      const specs = [hog('a', 0), hog('b', 3), { name: 'c', nice: -2, pattern: [{ run: MS, sleep: 4 * MS }] }];
      expect(run(make(), specs, { duration: SEC }).summary).toEqual(run(make(), specs, { duration: SEC }).summary);
    });

    it('只有一個 task 時不會切換，也不會 idle', () => {
      const { summary } = run(make(), [hog('only')], { duration: SEC });
      expect(summary.nr_switches).toBe(1); // 從 idle 切入那一次
      expect(summary.tasks[0]!.share).toBe(1);
    });
  });
});
