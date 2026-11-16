// EEVDF v6.6 特有的行為。共通性質（nice 比例、不變式）在 common.test.ts。
import { describe, expect, it } from 'vitest';
import { NSEC_PER_MSEC as MS, NSEC_PER_SEC as SEC, NSEC_PER_USEC as US, type Rq, type Task } from '../src/core/types.ts';
import { nice_to_static_prio, set_load_weight } from '../src/core/weights.ts';
import { EevdfV6_6, __calc_delta, calc_delta_fair, type SchedEntity } from '../src/sched/eevdf-v6.6.ts';
import { hog, run } from './helpers.ts';

type R = Rq<SchedEntity>;
type T = Task<SchedEntity>;

/** 用定義直接算 V = Σ v_i·w_i / Σ w_i（向下取整），和增量維護的結果比對 */
function bruteV(s: EevdfV6_6): number {
  const c = s.cfs_rq;
  const all = [...c.tasks_timeline.toArray(), ...(c.curr?.on_rq ? [c.curr] : [])];
  const W = all.reduce((a, se) => a + se.load.weight, 0);
  const sum = all.reduce((a, se) => a + (se.vruntime - c.min_vruntime) * se.load.weight, 0);
  return c.min_vruntime + Math.floor(sum / W);
}

/** 在每個 hook 之後檢查不變式的 EEVDF */
class Checked extends EevdfV6_6 {
  readonly violations: string[] = [];
  /** 喚醒放置後，實際 lag 和 dequeue 時記下的 vlag 的差 */
  readonly lagErrors: number[] = [];

  private check(where: string, rq: R): void {
    const c = this.cfs_rq;
    if (c.nr_running === 0) return;
    const V = this.avg_vruntime(c);
    const B = bruteV(this);
    if (V !== B) this.violations.push(`${where}@${rq.clock}: avg_vruntime ${V} != brute ${B}`);
  }

  override task_tick(rq: R, curr: T): void {
    super.task_tick(rq, curr);
    this.check('tick', rq);
  }

  override enqueue_task(rq: R, p: T, wakeup: boolean): void {
    const vlag = p.se.vlag;
    const othersRunning = this.cfs_rq.nr_running > 0;
    super.enqueue_task(rq, p, wakeup);
    this.check('enqueue', rq);
    if (wakeup && othersRunning) this.lagErrors.push(this.avg_vruntime(this.cfs_rq) - p.se.vruntime - vlag);
  }

  override pick_next_task(rq: R): T | null {
    const p = super.pick_next_task(rq);
    // 被選中的一定 eligible（v_i ≤ V）
    if (p && !this.entity_eligible(this.cfs_rq, p.se)) {
      this.violations.push(`pick@${rq.clock}: picked non-eligible pid ${p.pid}`);
    }
    this.check('pick', rq);
    return p;
  }
}

describe('__calc_delta（:281 的定點運算）', () => {
  it('nice 0 不換算', () => {
    const se = { load: set_load_weight(nice_to_static_prio(0)) } as SchedEntity;
    expect(calc_delta_fair(MS, se)).toBe(MS);
  });

  it.each([5, -5, 19, -20])('nice %i：虛擬時間 ≈ 實際時間 × 1024 / w', (nice) => {
    const lw = set_load_weight(nice_to_static_prio(nice));
    const exact = (10 * MS * 1024) / lw.weight;
    // 誤差來源：inv_weight 表本身（相對 < 1e-6）+ 最後的截斷（< 1ns）。
    // nice -20 的結果只有 ~115µs，截斷的 0.98ns 換成相對誤差就有 8.5e-6，所以要看絕對值。
    expect(Math.abs(__calc_delta(10 * MS, 1024, lw) - exact)).toBeLessThan(1 + exact * 1e-6);
  });
});

describe('不變式（每次 tick / enqueue / pick 後檢查）', () => {
  const mixed = [
    hog('h0', 0),
    hog('h5', 5, 7 * MS),
    { name: 'i1', nice: -3, pattern: [{ run: 0.4 * MS, sleep: 2.7 * MS }] },
    { name: 'i2', nice: 2, arrival: 3.3 * MS, pattern: [{ run: 1.9 * MS, sleep: 0.6 * MS }, { run: 0.2 * MS, sleep: 11 * MS }] },
  ];

  it('增量維護的 avg_vruntime 和定義算出的 V 完全相同；被選中的 task 都 eligible', () => {
    const s = new Checked();
    run(s, mixed, { duration: 2 * SEC });
    expect(s.violations).toEqual([]);
  });

  it('place_entity 保留 lag：喚醒後 V − v_i 等於 dequeue 時記下的 vlag（誤差在整數捨入內）', () => {
    const s = new Checked();
    run(s, mixed, { duration: 2 * SEC });
    expect(s.lagErrors.length).toBeGreaterThan(100);
    // 補償公式 vl·(W+w)/W 有整數除法，V 也有取整，容許幾 ns
    for (const e of s.lagErrors) expect(Math.abs(e)).toBeLessThanOrEqual(4);
  });
});

describe('deadline 與 slice', () => {
  it('兩個 nice 0 的 hog：slice 0.75ms 但 tick 1ms，幾乎每個 tick 都切換', () => {
    const { summary } = run(new EevdfV6_6(), [hog('a'), hog('b')], { duration: SEC });
    expect(summary.nr_switches).toBeGreaterThanOrEqual(990);
    expect(summary.nr_switches).toBeLessThanOrEqual(1001);
  });

  it('發新 deadline 時 deadline − vruntime = slice 換成虛擬時間', () => {
    const { result } = run(new EevdfV6_6(), [hog('a', 0), hog('b', 7)], { duration: 50 * MS, trace: true });
    const ups = result.trace.events.filter((e) => e.fn === 'update_deadline');
    expect(ups.length).toBeGreaterThan(10);
    const w7 = set_load_weight(nice_to_static_prio(7));
    for (const e of ups) {
      const d = (e.data!.deadline as number) - (e.data!.vruntime as number);
      const expected = e.pid === 1 ? 750 * US : __calc_delta(750 * US, 1024, w7);
      expect(d).toBe(expected);
    }
  });
});

describe('v6.6 的 fork 放置', () => {
  it('ENQUEUE_INITIAL 的半個 slice 被 activate_task 時的第二次 place_entity 覆蓋', () => {
    const { result } = run(new EevdfV6_6(), [hog('a'), hog('b', 0, 2 * MS)], { duration: 3 * MS, trace: true });
    const places = result.trace.events.filter((e) => e.fn === 'place_entity' && e.pid === 2);
    expect(places.map((e) => e.data!.initial)).toEqual([true, false]);
    const last = places[1]!.data!;
    expect((last.deadline as number) - (last.vruntime as number)).toBe(750 * US); // 完整 slice
  });
});

describe('互動型 + 批次型：沒有睡眠補償', () => {
  const editor = (run_: number, sleep: number) => ({
    name: 'editor',
    nice: 0,
    arrival: 0.123 * MS,
    pattern: [{ run: run_, sleep }],
  });

  it('可執行時只能和 compile 對分 CPU：比例 ≈ run / (2·run + sleep)', () => {
    const r = 2.2 * MS;
    const s = 3.13 * MS;
    const { summary } = run(new EevdfV6_6(), [hog('compile'), editor(r, s)]);
    expect(summary.tasks[1]!.share).toBeCloseTo(r / (2 * r + s), 2);
  });

  it('喚醒延遲的上限很緊：最多約一個 tick 加零頭', () => {
    for (const [r, s] of [
      [1.037, 9.311],
      [0.3, 4.77],
      [2.2, 3.13],
    ] as const) {
      const { summary } = run(new EevdfV6_6(), [hog('compile'), editor(r * MS, s * MS)]);
      expect(summary.tasks[1]!.wakeupLatencyMax).toBeLessThan(1.5 * MS);
    }
  });
});
