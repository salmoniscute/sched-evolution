// 排程事件（SchedEvent）與決策說明：快照要和實際的排程結果一致，說明不能退回中性敘述太多次。
import { describe, expect, test } from 'vitest';
import { Simulator } from '../src/core/engine.ts';
import { summarize } from '../src/core/metrics.ts';
import { NSEC_PER_SEC, NSEC_PER_USEC as US } from '../src/core/types.ts';
import { RunRecorder } from '../src/ref/recorder.ts';
import { scenarios } from '../src/scenarios.ts';
import type { O1Snapshot } from '../src/sched/o1-v2.6.0.ts';
import type { OnSnapshot } from '../src/sched/on-v2.4.0.ts';
import { explain, latestAtOrBefore, latestForPid, rowsOf, type InspectCtx } from '../src/ui/inspect.ts';
import { changedFlags, defaultFlags, variants, type Flags, type SchedVariant } from '../src/variants.ts';

const DURATION = 2 * NSEC_PER_SEC;

function runWith(v: SchedVariant, flags: Flags, scenarioId: string) {
  const sc = scenarios.find((s) => s.id === scenarioId)!;
  const rec = new RunRecorder();
  const result = new Simulator(v.make(flags), v.tasks(sc.tasks, flags), { duration: DURATION, hz: v.hz, observers: [rec] }).run();
  const ctx: InspectCtx = { family: v.family, names: sc.tasks.map((t) => t.name), color: () => '', flags, events: rec.events };
  return { rec, ctx, summary: summarize(result), result };
}

/** 每個排程器：預設值，加上每個開關各關一次 */
const cases = variants.flatMap((v) =>
  [defaultFlags(v), ...v.features.map((f) => ({ ...defaultFlags(v), [f.key]: false }))].map(
    (flags) => [`${v.id} ${changedFlags(v, flags).map((k) => '−' + k).join(' ') || '預設'}`, v, flags] as const,
  ),
);

describe.each(scenarios.map((s) => s.id))('情境 %s', (id) => {
  test.each(cases)('%s：事件和時間軸一致', (_name, v, flags) => {
    const { rec, result } = runWith(v, flags, id);
    const picks = rec.events.filter((e) => e.kind === 'pick');
    expect(picks.length).toBe(result.nr_schedule);
    for (let i = 1; i < rec.events.length; i++) expect(rec.events[i]!.t).toBeGreaterThanOrEqual(rec.events[i - 1]!.t);

    // 每次挑選之後，時間軸上從那一刻開始跑的就是 next
    const startAt = new Map(rec.segments.map((s) => [s.t0, s.pid]));
    for (const e of picks) {
      if (e.prev === e.next || e.t >= DURATION) continue;
      // 同一時刻連續兩次 schedule() 時只有最後一次算數
      const last = rec.events.filter((x) => x.kind === 'pick' && x.t === e.t).at(-1)!;
      if (last === e) expect(startAt.get(e.t)).toBe(e.next);
    }
    // 沒有搶佔的喚醒：curr 不變
    for (const e of rec.events) if (e.kind === 'wakeup') expect(e.prev).toBe(e.next);
  });

  test.each(cases)('%s：挑選符合快照（O(n) goodness 最大；O(1) active 裡 prio 最好；CFS 最左邊；EEVDF eligible 中 deadline 最早）', (_name, v, flags) => {
    const { rec } = runWith(v, flags, id);
    for (const e of rec.events) {
      if (e.kind !== 'pick' || e.next === null) continue;
      if (v.family === 'on') {
        const s = e.snapshot as OnSnapshot;
        const chosen = s.tasks.find((x) => x.pid === e.next)!;
        expect(chosen.curr).toBe(true);
        expect(chosen.goodness).toBeGreaterThan(0);
        expect(Math.max(...s.tasks.map((x) => x.goodness))).toBe(chosen.goodness);
        continue;
      }
      if (v.family === 'o1') {
        const s = e.snapshot as O1Snapshot;
        const chosen = s.tasks.find((x) => x.pid === e.next)!;
        expect(chosen.curr).toBe(true);
        expect(chosen.array).toBe('active');
        expect(Math.min(...s.tasks.filter((x) => x.array === 'active').map((x) => x.prio))).toBe(chosen.prio);
        continue;
      }
      const rows = rowsOf(e.snapshot);
      const chosen = rows.find((r) => r.pid === e.next)!;
      expect(chosen.curr).toBe(true);
      if (v.family === 'cfs') {
        expect(Math.min(...rows.map((r) => r.rel))).toBe(chosen.rel);
      } else {
        expect(chosen.eligible).toBe(true);
        expect(Math.min(...rows.filter((r) => r.eligible).map((r) => r.dl!))).toBe(chosen.dl);
      }
    }
  });

  test.each(cases)('%s：每個事件都有具體的說明', (_name, v, flags) => {
    const { ctx } = runWith(v, flags, id);
    const vague = ['觸發重新排程。', 'tick 時要求重新排程。', '試挑的結果不是它', '沒有觸發重新排程。'];
    let n = 0;
    ctx.events.forEach((e, i) => {
      const x = explain(ctx, i);
      expect(x.why.length).toBeGreaterThan(0);
      expect(x.why.join('')).not.toMatch(/NaN|undefined/);
      expect(x.plain).toMatch(/。$/);
      expect(x.plain).not.toMatch(/NaN|undefined|^排程器重新挑選/);
      if (x.why.some((s) => vague.some((p) => s.endsWith(p) || s.includes(p))) || x.why.some((s) => /^選中 .+。$/.test(s))) n++;
      void e;
    });
    // 退回中性敘述的比例要很低
    expect(n / ctx.events.length).toBeLessThan(0.02);
  });
});

test('開關確實改變結果（比較情境 4）', () => {
  const lat = (v: SchedVariant, off: string[]) => {
    const flags = { ...defaultFlags(v), ...Object.fromEntries(off.map((k) => [k, false])) };
    return runWith(v, flags, 'latency').summary.tasks[0]!.wakeupLatencyAvg;
  };
  const cfs = variants.find((v) => v.id === 'cfs-v2.6.24')!;
  const v612 = variants.find((v) => v.id === 'eevdf-v6.12-slice')!;
  // CFS 的低延遲靠喚醒補償
  expect(lat(cfs, [])).toBeLessThan(50 * US);
  expect(lat(cfs, ['NEW_FAIR_SLEEPERS'])).toBeGreaterThan(5000 * US);
  // v6.12 的短 slice 三樣缺一不可
  expect(lat(v612, [])).toBeLessThan(50 * US);
  for (const k of ['custom_slice', 'PREEMPT_SHORT', 'DELAY_DEQUEUE']) expect(lat(v612, [k])).toBeGreaterThan(500 * US);
});

test('latestForPid：點在等待中的程式，回到它開始排隊的事件', () => {
  const v = variants.find((d) => d.id === 'eevdf-v6.6')!; // audio 醒來常常搶不到
  const { rec } = runWith(v, defaultFlags(v), 'latency');
  const wake = rec.events.find((e) => e.kind === 'wakeup' && e.causePid === 1 && e.t > 100e6)!;
  const idx = latestForPid(rec.events, wake.t + 100 * US, 1);
  expect(rec.events[idx]).toBe(wake);
  expect(latestAtOrBefore(rec.events, -1)).toBe(-1);
});

describe('開關的情境說明', () => {
  const all = scenarios.flatMap((sc) => sc.featNotes.map((x) => [`${sc.id} ${x.variant} ${x.key}`, sc, x] as const));
  test.each(all)('%s：開關存在；寫「完全不變」的真的完全不變，其他的真的有變', (_name, sc, x) => {
    expect(sc.tasks[x.task]).toBeDefined();
    const v = variants.find((d) => d.id === x.variant)!;
    expect(v).toBeDefined();
    expect(v.features.map((f) => f.key)).toContain(x.key);
    const a = runWith(v, defaultFlags(v), sc.id).summary;
    const b = runWith(v, { ...defaultFlags(v), [x.key]: false }, sc.id).summary;
    const same = JSON.stringify(a) === JSON.stringify(b);
    expect(same).toBe(/完全不變/.test(x.note));
  });
  test.each(scenarios.map((sc) => [sc.id, sc] as const))('%s：同一個開關只有一則說明', (_id, sc) => {
    const keys = sc.featNotes.map((x) => `${x.variant}/${x.key}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
