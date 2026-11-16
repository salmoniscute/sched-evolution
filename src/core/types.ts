// 模擬核心的共通型別。名稱盡量對齊 kernel（task_struct / rq / sched_class）。

/** 時間一律用整數 ns，和 kernel 的 rq->clock 一樣。 */
export type Ns = number;

export const NSEC_PER_USEC = 1_000;
export const NSEC_PER_MSEC = 1_000_000;
export const NSEC_PER_SEC = 1_000_000_000;

/** 一段行為：先跑 run ns，再睡 sleep ns。run = Infinity 表示純 CPU-bound。 */
export interface Burst {
  run: Ns;
  sleep: Ns;
}

/** 工作負載裡的一個 task。 */
export interface TaskSpec {
  name: string;
  /** -20..19 */
  nice: number;
  /** 何時被建立（fork），預設 0 */
  arrival?: Ns;
  /** 依序循環執行的 burst */
  pattern: Burst[];
  /** v6.12 的 sched_attr.sched_runtime（自訂 slice）；其他排程器忽略 */
  slice?: Ns;
}

export type TaskState = 'NEW' | 'RUNNING' | 'SLEEPING';

/** 對應 task_struct。`se` 的型別由各排程器決定。 */
export interface Task<SE> {
  pid: number;
  name: string;
  nice: number;
  /** MAX_RT_PRIO(100) + 20 + nice，和 kernel 相同 */
  static_prio: number;
  /** TASK_RUNNING 包含「可執行但在等 CPU」 */
  state: TaskState;
  se: SE;
  spec: TaskSpec;

  // ---- 以下是模擬器的簿記，不是 kernel 欄位 ----
  burstIdx: number;
  /** 目前 burst 還要跑多久 */
  burstLeft: Ns;
}

/** 一次排程器函式呼叫的紀錄，前端用來高亮原始碼。 */
export interface TraceEvent {
  t: Ns;
  /** kernel 函式名稱，例如 'update_curr' */
  fn: string;
  pid?: number;
  /** 呼叫當下的關鍵數值，給解說用 */
  data?: Record<string, number | string | boolean | null>;
}

export class Tracer {
  readonly events: TraceEvent[] = [];
  constructor(
    public enabled = false,
    private readonly limit = 200_000,
  ) {}

  log(t: Ns, fn: string, pid?: number, data?: TraceEvent['data']): void {
    if (!this.enabled || this.events.length >= this.limit) return;
    this.events.push({ t, fn, pid, data });
  }
}

/** 對應 struct rq（單核，只有一個）。 */
export interface Rq<SE> {
  /** rq->clock（ns） */
  clock: Ns;
  /** TICK_NSEC = NSEC_PER_SEC / HZ */
  readonly tick_nsec: Ns;
  /** rq->curr；null 代表 idle task 在跑 */
  curr: Task<SE> | null;
  /** rq->nr_running */
  nr_running: number;
  /** TIF_NEED_RESCHED */
  need_resched: boolean;
  trace: Tracer;
  /**
   * 排程決策成本的模型：資料結構操作中「比較 / 走訪節點」的次數。
   * rbtree 插入以 ⌈log2(n+1)⌉ 計，O(n) 掃描以 n 計。
   */
  ops: number;
}

/** resched_task(rq->curr) */
export function resched_task<SE>(rq: Rq<SE>): void {
  rq.need_resched = true;
}

/**
 * 對應 struct sched_class。單核、只有一個 class，所以省掉 class 之間的鏈結。
 * 參數名稱沿用各版本 kernel 的寫法（wakeup / sleep）。
 */
export interface SchedClass<SE> {
  /** 例如 'cfs-v2.6.24' */
  readonly id: string;
  /** sched_fork() 時建立 sched_entity */
  init_entity(p: Task<SE>): SE;
  /** wake_up_new_task() 的 class hook */
  task_new(rq: Rq<SE>, p: Task<SE>): void;
  enqueue_task(rq: Rq<SE>, p: Task<SE>, wakeup: boolean): void;
  dequeue_task(rq: Rq<SE>, p: Task<SE>, sleep: boolean): void;
  check_preempt_curr(rq: Rq<SE>, p: Task<SE>): void;
  pick_next_task(rq: Rq<SE>): Task<SE> | null;
  put_prev_task(rq: Rq<SE>, prev: Task<SE>): void;
  task_tick(rq: Rq<SE>, curr: Task<SE>): void;
  /** 給視覺化用：目前 runqueue 的狀態快照 */
  snapshot(rq: Rq<SE>): unknown;
}
