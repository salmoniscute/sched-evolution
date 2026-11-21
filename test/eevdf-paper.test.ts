// 論文版 EEVDF（src/sched/eevdf-paper.ts）對照 Stoica & Abdel-Wahab 1995 的定義與定理。
import { describe, expect, test } from 'vitest';
import { NSEC_PER_MSEC as MS, NSEC_PER_SEC as SEC, NSEC_PER_USEC as US, type Rq, type Task, type TaskSpec } from '../src/core/types.ts';
import { EevdfV6_6 } from '../src/sched/eevdf-v6.6.ts';
import { EevdfPaper, defaultTunables, type PaperEntity, type PaperTunables } from '../src/sched/eevdf-paper.ts';
import { scenarios } from '../src/scenarios.ts';
import { hog, run } from './helpers.ts';

/** 每次分配與計時器到期時檢查不變式 */
class Probe extends EevdfPaper {
  maxAbsSum = 0;
  lagMin = new Map<number, number>();
  lagMax = new Map<number, number>();
  constructor(tun: Partial<PaperTunables> = {}) {
    super({ ...defaultTunables, ...tun });
  }
  private check(): void {
    let sum = 0;
    for (const se of this.entities()) {
      const lag = this.lagOf(se);
      sum += lag;
      const pid = se.task.pid;
      this.lagMin.set(pid, Math.min(this.lagMin.get(pid) ?? 0, lag));
      this.lagMax.set(pid, Math.max(this.lagMax.get(pid) ?? 0, lag));
    }
    this.maxAbsSum = Math.max(this.maxAbsSum, Math.abs(sum));
  }
  override pick_next_task(rq: Rq<PaperEntity>): Task<PaperEntity> | null {
    const r = super.pick_next_task(rq);
    this.check();
    return r;
  }
  override timer_fire(rq: Rq<PaperEntity>): void {
    this.check();
    super.timer_fire(rq);
  }
}

describe('論文 Figure 1：兩個權重相同的 client，request 長度 2 和 1，q = 1', () => {
  // 論文的權重是 2、2；這裡用 nice 0（1024），V 的單位放大 1024/2 倍再換成 ms，所以除以 2 對回論文的數字
  const specs: TaskSpec[] = [
    { name: 'c1', nice: 0, slice: 2 * MS, pattern: [{ run: Infinity, sleep: 0 }] },
    { name: 'c2', nice: 0, slice: 1 * MS, arrival: 1 * MS, pattern: [{ run: Infinity, sleep: 0 }] },
  ];
  const s = new EevdfPaper({ ...defaultTunables, quantum: 1 * MS, record: true });
  // client 1 的第三個 request 在 t = 7 發出，所以跑到 7.5
  const { result } = run(s, specs, { duration: 7.5 * MS, trace: true });
  const pairs = (pid: number) => s.requests.filter((r) => r.pid === pid).map((r) => [r.ve / MS / 2, r.vd / MS / 2]);

  test('每個 request 的 (ve, vd) 和圖上一樣', () => {
    expect(pairs(1)).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(pairs(2)).toEqual([
      [0.5, 1],
      [1, 1.5],
      [1.5, 2],
      [2, 2.5],
    ]);
  });

  test('七個 quantum 依序分給 1、2、1、2、1、2、1（兩次 deadline 平手都和圖一樣給 client 2）', () => {
    const order = [0, 1, 2, 3, 4, 5, 6].map((k) => {
      const ds = result.trace.events.filter((e) => e.fn === 'EEVDF_dispatch' && e.t === k * MS);
      return ds.at(-1)?.pid;
    });
    expect(order).toEqual([1, 2, 1, 2, 1, 2, 1]);
  });
});

describe('§4：加入與離開時調整 V，lag 總和維持 0', () => {
  test.each(scenarios.map((sc) => sc.id))('情境 %s', (id) => {
    const sc = scenarios.find((s) => s.id === id)!;
    const p = new Probe();
    run(p, sc.tasks, { duration: 2 * SEC });
    // Σ lag = 0 ⇔ V 等於 Σ w_i·v_i / W，也就是 kernel 的 avg_vruntime
    expect(p.maxAbsSum).toBeLessThan(1);
    expect(p.joins.length).toBeGreaterThan(0);
  });

  test('帶著 lag ℓ 加入，實際只帶回 ℓ·W/(W + w)（kernel v6.6 會把 lag 放大抵銷這一份）', () => {
    const sc = scenarios.find((s) => s.id === 'latency')!;
    const p = new Probe();
    run(p, sc.tasks, { duration: 200 * MS });
    const rejoin = p.joins.filter((j) => j.lag !== 0);
    expect(rejoin.length).toBeGreaterThan(10);
    // audio、cc1、cc2 都是 nice 0：audio 醒來時 W = 2 份，加入後 3 份
    for (const j of rejoin) expect(j.effective).toBeCloseTo((j.lag * 2) / 3, 6);
  });

  test('strategy 2：重新加入一律從 lag = 0 開始', () => {
    const sc = scenarios.find((s) => s.id === 'latency')!;
    const p = new Probe({ keep_lag: false });
    run(p, sc.tasks, { duration: 200 * MS });
    for (const j of p.joins) expect(j.effective).toBe(0);
    expect(p.maxAbsSum).toBeLessThan(1);
  });
});

describe('§6 Theorem：穩定系統中 −r_max < lag < max(r_max, q)', () => {
  test.each([
    ['nice −5/0/5，r 都是 0.75ms', [hog('a', -5), hog('b', 0), hog('c', 5)]],
    [
      'r 不同（0.3ms、2ms、0.75ms）',
      [
        { ...hog('short'), slice: 300 * US },
        { ...hog('long'), slice: 2 * MS },
        hog('base', 3),
      ],
    ],
  ] as [string, TaskSpec[]][])('%s', (_name, specs) => {
    const p = new Probe();
    run(p, specs, { duration: 2 * SEC });
    specs.forEach((spec, i) => {
      const r = spec.slice ?? defaultTunables.base_slice;
      expect(p.lagMin.get(i + 1)!).toBeGreaterThan(-r);
      expect(p.lagMax.get(i + 1)!).toBeLessThan(Math.max(r, defaultTunables.quantum));
    });
  });
});

describe('和 kernel 的差別', () => {
  const sc = scenarios.find((s) => s.id === 'latency')!;
  const audio = (sched: EevdfPaper | EevdfV6_6) => run(sched, sc.tasks, { duration: 2 * SEC }).summary.tasks[0]!;

  test('情境 4：audio 帶著負 lag 醒來，論文只帶回 2/3，等待比 kernel v6.6 短', () => {
    // 睡前 lag ≈ −0.21ms；論文：−0.21 × 2/3 ÷ (1/3) = 0.42ms；kernel 放大保留：−0.21 ÷ (1/3) = 0.62ms
    const paper = audio(new EevdfPaper());
    const kernel = audio(new EevdfV6_6());
    expect(paper.wakeupLatencyMax).toBe(420 * US);
    expect(kernel.wakeupLatencyMax).toBeGreaterThan(paper.wakeupLatencyMax);
  });

  test('醒來不搶佔：lag 為 0 的 request 也要等到 quantum 結束（最多 q）', () => {
    const p = new EevdfPaper({ ...defaultTunables, keep_lag: false });
    const a = run(p, sc.tasks, { duration: 2 * SEC }).summary.tasks[0]!;
    expect(a.wakeupLatencyAvg).toBeGreaterThan(0);
  });
});
