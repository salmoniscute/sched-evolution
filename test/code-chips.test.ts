import { describe, expect, it } from 'vitest';
import { classifyCode, KERNEL_NAME } from '../src/ui/code-chips.ts';

describe('classifyCode', () => {
  it.each([
    ['place_entity()', 'fn'],
    ['prio_to_weight[]', 'data'],
    ['vlag', 'data'],
    ['cpu.weight', 'data'],
    ['DELAY_DEQUEUE', 'const'],
    ['kernel/sched/fair.c', 'path'],
    ['/proc/<pid>/schedstat', 'path'],
    ['perf sched latency', 'path'],
    ['make -j', 'path'],
    ['(s64)(a − b)', 'expr'],
    ['min_vruntime − sched_latency', 'expr'],
    ['max_vruntime(se->vruntime, vruntime)', 'expr'],
  ])('%s → %s', (text, kind) => expect(classifyCode(text)).toBe(kind));
});

describe('KERNEL_NAME', () => {
  const names = (s: string) => [...s.matchAll(KERNEL_NAME)].map((m) => m[0]);
  it('認出 kernel 名稱', () => {
    expect(names('這時 min_vruntime 是 3ms，NICE_0_LOAD 是 1024')).toEqual(['min_vruntime', 'NICE_0_LOAD']);
    expect(names('schedule() 要挑下一個，place_entity() 把它放在 V')).toEqual(['schedule()', 'place_entity()']);
    expect(names('透過 sched_attr.sched_runtime 指定')).toEqual(['sched_attr.sched_runtime']);
    expect(names('SCHED_IDLE 只補 min_granularity；沒有 HRTICK')).toEqual(['SCHED_IDLE', 'min_granularity', 'HRTICK']);
  });
  it('不碰概念詞、縮寫與路徑', () => {
    expect(names('CFS 的 vruntime 與 lag，GPS、HZ=1000、CPU')).toEqual([]);
    expect(names('kernel/sched_fair.c 與 notes/a_b')).toEqual([]);
    expect(names('max_vruntime(se->vruntime, vruntime)')).toEqual([]);
  });
});
