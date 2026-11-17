// 記錄「誰在 CPU 上」的時間段，給時間軸畫圖用。
import type { SimObserver } from '../core/engine.ts';
import type { Ns, Task } from '../core/types.ts';

export interface RunSegment {
  t0: Ns;
  t1: Ns;
  /** null = idle */
  pid: number | null;
}

/** 每個 task 可執行（在等或在跑）的時間段 */
export interface RunnableSegment {
  t0: Ns;
  t1: Ns;
  pid: number;
}

export class RunRecorder implements SimObserver {
  readonly segments: RunSegment[] = [];
  readonly runnable: RunnableSegment[] = [];
  private readonly open = new Map<number, RunnableSegment>();

  onAdvance(t0: Ns, t1: Ns, curr: Task<unknown> | null, runnable: readonly Task<unknown>[]): void {
    const pid = curr?.pid ?? null;
    const last = this.segments.at(-1);
    if (last && last.pid === pid && last.t1 === t0) last.t1 = t1;
    else this.segments.push({ t0, t1, pid });

    const seen = new Set<number>();
    for (const p of runnable) {
      seen.add(p.pid);
      const seg = this.open.get(p.pid);
      if (seg && seg.t1 === t0) seg.t1 = t1;
      else {
        const s = { t0, t1, pid: p.pid };
        this.runnable.push(s);
        this.open.set(p.pid, s);
      }
    }
    for (const pid of [...this.open.keys()]) if (!seen.has(pid)) this.open.delete(pid);
  }
}
