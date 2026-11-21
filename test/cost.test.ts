// 比較情境 1：每次 schedule() 的成本隨 task 數怎麼長。數字對照各版的資料結構：
// 2.4 掃整條 runqueue、2.6.0 查 bitmap、v2.6.24 取快取的 rb_leftmost 但要進出紅黑樹、v6.6 往下走 augmented rbtree。
import { describe, expect, test } from 'vitest';
import { costAt, costCurves } from '../src/cost.ts';

const log2 = (n: number) => Math.ceil(Math.log2(n + 1));

describe('每次 schedule() 的成本', () => {
  test('O(n) 2.4：每次挑選算 n + 1 次 goodness()（prev 先算一次），重算之後再掃一輪', () => {
    for (const n of [8, 32, 128]) {
      const pick = costAt('on-v2.4.0', n).by.pick;
      // 全部 counter 用完時重算，接著再掃一次；大約每 n 次挑選發生一次，攤提後多出約 1 次
      expect(pick).toBeGreaterThan(n + 0.9); // 第一次 schedule() 的 prev 是 idle，少算一次
      expect(pick).toBeLessThan(n + 3);
    }
  });

  test('O(1) 2.6.0：一次 sched_find_first_bit()，和 n 無關；時間片用完的搬移在 scheduler_tick() 裡做', () => {
    for (const n of [1, 16, 256]) expect(costAt('o1-v2.6.0', n).total).toBe(1);
  });

  test('CFS v2.6.24：挑選是常數（rb_leftmost），成本在 put_prev / set_next 進出樹', () => {
    for (const n of [8, 64, 256]) {
      const c = costAt('cfs-v2.6.24', n);
      // 挑一次，加上 update_curr() 為了 min_vruntime 再看一次 leftmost
      expect(c.by.pick).toBeCloseTo(2, 1);
      // prev 插回 n − 1 個節點的樹、next 從 n 個節點的樹拿出來
      expect(c.by.queue).toBeCloseTo(log2(n - 1) + log2(n), 0);
    }
  });

  test('EEVDF v6.6：pick_eevdf() 本身就要往下走樹，隨 log n 成長', () => {
    const a = costAt('eevdf-v6.6', 8).by.pick;
    const b = costAt('eevdf-v6.6', 256).by.pick;
    expect(b - a).toBeGreaterThanOrEqual(4);
    expect(b).toBeLessThanOrEqual(log2(256) + 1);
  });

  test('v6.12 和 v6.6 的成本相同（圖上只畫一條）', () => {
    for (const n of [4, 64]) expect(costAt('eevdf-v6.12-slice', n)).toEqual(costAt('eevdf-v6.6', n));
  });

  test('task 一多，O(n) 遠遠超過其他三個', () => {
    const c = costCurves([128]);
    const on = c.get('on-v2.4.0')![0]!.total;
    for (const id of ['o1-v2.6.0', 'cfs-v2.6.24', 'eevdf-v6.6']) expect(on).toBeGreaterThan(4 * c.get(id)![0]!.total);
  });
});
