// 網頁上並排比較的排程器，以及每個排程器可以開關的 sched_feat。
// 開關的預設值就是該版本 kernel 的預設值；關掉其中一個，是為了看「少了它會怎樣」。
import type { SchedClass, TaskSpec } from './core/types.ts';
import { tr } from './i18n.ts';
import { CfsV2_6_24, defaultTunables as cfsDefaults } from './sched/cfs-v2.6.24.ts';
import { EevdfV6_6, defaultTunables as eevdfDefaults } from './sched/eevdf-v6.6.ts';
import { EevdfV6_12, defaultTunablesV6_12 } from './sched/eevdf-v6.12.ts';
import { EevdfPaper, defaultTunables as paperDefaults } from './sched/eevdf-paper.ts';
import { O1V2_6_0, defaultTunables as o1Defaults } from './sched/o1-v2.6.0.ts';
import { OnV2_4_0, defaultTunables as onDefaults } from './sched/on-v2.4.0.ts';

export interface Feature {
  /** kernel 的 sched_feat 名稱（custom_slice 不是 sched_feat，是 sched_attr 的欄位） */
  key: string;
  /** 一句話：開著的時候它做什麼 */
  on: string;
  /** 一句話：關掉之後變成怎樣 */
  off: string;
  /** 這一版 kernel 沒有 sched_feat，這是模擬器為了比較加的開關 */
  sim?: boolean;
}

export type Flags = Record<string, boolean>;

/** paper：論文版的 EEVDF，不是 kernel */
export type Family = 'on' | 'o1' | 'cfs' | 'eevdf' | 'paper';

export interface SchedVariant {
  id: string;
  title: string;
  /** 選擇比較對象時的短名稱 */
  short: string;
  note: string;
  family: Family;
  /** CONFIG_HZ：2.4 i386 是 100，之後是 1000 */
  hz: number;
  features: Feature[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  make(flags: Flags): SchedClass<any>;
  /** 這個排程器實際看到的工作負載（custom_slice 關掉時拿掉 slice） */
  tasks(specs: TaskSpec[], flags: Flags): TaskSpec[];
}

const RUN_TO_PARITY: Feature = {
  key: 'RUN_TO_PARITY',
  on: tr(
    '被選中的程式一路跑到這次的 slice 用完（或拿得比應得的多、不再 eligible），中途有人醒來也不重新比 deadline。',
    'The picked task runs until its current slice is used up (or until it has taken more than its share and is no longer eligible). A task waking up in the meantime does not trigger a new deadline comparison.',
  ),
  off: tr(
    '每次有人醒來都重新比一次 deadline，deadline 較早又 eligible 的可以立刻搶佔。',
    'Every wakeup compares deadlines again; an eligible task with an earlier deadline can preempt right away.',
  ),
};
const PLACE_LAG: Feature = {
  key: 'PLACE_LAG',
  on: tr(
    '睡前把 lag（應得 − 實得）存起來（vlag），醒來照樣帶回去：之前多拿的要先還，被欠的可以先跑。',
    'Before sleeping, the task saves its lag (entitled − received) in vlag and brings it back on wakeup: a task that took too much pays it back first, a task that was owed runs earlier.',
  ),
  off: tr('醒來一律當作不欠也不多（lag = 0），睡前的帳不算了。', 'Every wakeup starts at lag = 0; whatever was owed or overdrawn before sleeping is forgotten.'),
};

const same = (specs: TaskSpec[]) => specs;
const flag = (flags: Flags, key: string) => flags[key] ?? true;

export const variants: SchedVariant[] = [
  {
    id: 'on-v2.4.0',
    title: 'O(n) 2.4.0',
    short: 'O(n) 2.4',
    note: tr(
      '每次排程都掃過所有想跑的 task，替每個算一個分數 goodness（大致是剩下的時間片 counter + 20 − nice），選最高的；所有人的時間片都用完，才一起重發。HZ = 100，一個 tick 10ms。沒有比例分享的目標，GPS 只是拿來量距離。簡化：fork 時假設 parent 的時間片是滿的。',
      'Every schedule() walks all runnable tasks, gives each a score with goodness() (roughly the remaining time slice, counter, + 20 − nice) and picks the highest; time slices are handed out again only after everyone has used theirs up. HZ = 100, so a tick is 10ms. There is no proportional-share goal; GPS is only used to measure the distance. Simplification: at fork the parent is assumed to have a full time slice.',
    ),
    family: 'on',
    hz: onDefaults.hz,
    features: [
      {
        key: 'for_each_task',
        sim: true,
        on: tr(
          '重發時間片（counter）時，連睡著的 task 也一起發：沒用完的留一半再加一份新的，常睡的 task 時間片越積越多（最多約兩倍），醒來分數比較高、容易插隊。',
          'When time slices (counter) are handed out again, sleeping tasks get one too: half of what is left is kept and a fresh slice is added, so tasks that sleep a lot build up a larger slice (up to about twice the normal one), score higher on wakeup, and preempt more easily.',
        ),
        off: tr(
          '只重發給想跑的 task，睡著的不加。這不是 kernel 的設定，是為了看 2.4 的互動性從哪裡來。',
          'Only runnable tasks get a new slice; sleeping ones get nothing. This is not a kernel setting; it exists to show where 2.4 gets its interactivity from.',
        ),
      },
    ],
    make: (f) => new OnV2_4_0({ ...onDefaults, features: { for_each_task: flag(f, 'for_each_task') } }),
    tasks: same,
  },
  {
    id: 'o1-v2.6.0',
    title: 'O(1) 2.6.0',
    short: 'O(1) 2.6.0',
    note: tr(
      '每個優先權一條佇列，共 140 條，用 bitmap 直接找到最高優先權那一條、取第一個，不用掃過所有 task。佇列分兩組：這一輪還有時間片的（active），和用完時間片、等下一輪的（expired）；active 空了，兩組對調，下一輪開始。sleep_avg 讓常睡的 task 優先權最多 +5。沒有比例分享的目標，GPS 只是拿來量距離。簡化：fork 時假設 parent 是 sleep_avg 滿的 shell，新 task 一開始 bonus +4，前一秒左右會受影響。',
      'One queue per priority, 140 in total; a bitmap finds the highest-priority non-empty queue and the first task in it is taken, without walking every task. The queues come in two sets: tasks that still have time slice left in this round (active), and tasks that used theirs up and wait for the next round (expired). When active is empty the two are swapped and the next round begins. sleep_avg raises the priority of tasks that sleep a lot by up to 5 levels. There is no proportional-share goal; GPS is only used to measure the distance. Simplification: at fork the parent is assumed to be a shell with a full sleep_avg, so new tasks start with bonus +4, which affects roughly the first second.',
    ),
    family: 'o1',
    hz: o1Defaults.hz,
    features: [
      {
        key: 'sleep_avg',
        sim: true,
        on: tr(
          '依最近睡了多久（sleep_avg）把優先權調高或調低最多 5 級（bonus）：睡得多的優先權高。',
          'Priority moves up or down by up to 5 levels (the bonus) depending on how much the task has slept recently (sleep_avg): tasks that sleep more get a higher priority.',
        ),
        off: tr('優先權只看 nice，睡多睡少都一樣，沒有互動性加分。', 'Priority depends on nice only; sleeping more or less makes no difference and there is no interactivity bonus.'),
      },
      {
        key: 'TASK_INTERACTIVE',
        sim: true,
        on: tr(
          '被認定是互動型的 task 用完時間片後，排回這一輪（active）的隊伍尾端，不用等下一輪。',
          'A task judged interactive goes back to the end of this round\'s queue (active) when its time slice runs out, instead of waiting for the next round.',
        ),
        off: tr(
          '用完時間片一律排到下一輪（expired），要等這一輪的 task 都用完時間片才輪得到。',
          'Every task that uses up its time slice moves to the next round (expired) and waits until all tasks in this round have used theirs.',
        ),
      },
      {
        key: 'EXPIRED_STARVING',
        sim: true,
        on: tr(
          '排到下一輪（expired）的 task 等太久時，互動型的 task 用完時間片也不能再留在這一輪，避免下一輪的 task 永遠輪不到（starvation）。',
          'Once tasks in the next round (expired) have waited too long, interactive tasks can no longer stay in this round when their slice runs out, so the waiting tasks are not starved forever (starvation).',
        ),
        off: tr('互動型的 task 可以一直留在這一輪，排到下一輪的 task 可能一直等。', 'Interactive tasks can stay in this round indefinitely, and tasks in the next round may wait forever.'),
      },
      {
        key: 'TIMESLICE_GRANULARITY',
        sim: true,
        on: tr(
          '互動型 task 的長時間片切成小段（10ms 起），每段跑完就排到同優先權隊伍的尾端，讓同優先權的 task 輪流。',
          'An interactive task\'s long time slice is cut into pieces (10ms and up); after each piece it goes to the end of its priority queue, so tasks with the same priority take turns.',
        ),
        off: tr('互動型 task 一次跑完整個時間片，同優先權的其他 task 要等。', 'An interactive task runs its whole time slice in one go; other tasks at the same priority have to wait.'),
      },
    ],
    make: (f) =>
      new O1V2_6_0({
        ...o1Defaults,
        features: {
          sleep_avg: flag(f, 'sleep_avg'),
          TASK_INTERACTIVE: flag(f, 'TASK_INTERACTIVE'),
          EXPIRED_STARVING: flag(f, 'EXPIRED_STARVING'),
          TIMESLICE_GRANULARITY: flag(f, 'TIMESLICE_GRANULARITY'),
        },
      }),
    tasks: same,
  },
  {
    id: 'cfs-v2.6.24',
    title: 'CFS v2.6.24',
    short: 'CFS 2.6.24',
    hz: 1000,
    note: tr(
      '每個程式記一個 vruntime（依權重換算過的已執行時間），最小的先跑；睡醒的程式最多補償 20ms（sched_latency），讓它比較早輪到。',
      'Each task keeps a vruntime (time it has run, scaled by its weight) and the smallest runs first; a task waking from sleep gets up to 20ms of credit (sched_latency) so its turn comes sooner.',
    ),
    family: 'cfs',
    features: [
      {
        key: 'NEW_FAIR_SLEEPERS',
        on: tr(
          '喚醒補償：睡醒的程式 vruntime 設成目前最小值（min_vruntime）再減 20ms，比別人早輪到；但不會比它睡前的 vruntime 更小。',
          'Sleeper credit: a waking task\'s vruntime is set to the current minimum (min_vruntime) minus 20ms, so its turn comes before the others; it is never set below the vruntime it had before sleeping.',
        ),
        off: tr('睡醒的程式 vruntime 設成目前最小值（min_vruntime），沒有額外的補償。', 'A waking task\'s vruntime is set to the current minimum (min_vruntime), with no extra credit.'),
      },
      {
        key: 'WAKEUP_PREEMPT',
        on: tr(
          '醒來的程式 vruntime 比正在跑的程式（curr）小超過 10ms（wakeup_granularity），就立刻搶佔。',
          'If a waking task\'s vruntime is more than 10ms (wakeup_granularity) below the running task (curr), it preempts immediately.',
        ),
        off: tr(
          '醒來不搶佔，要等正在跑的程式在 tick 時用完它這一輪分到的時間（sched_slice）。',
          'Wakeups never preempt; the waking task waits until the running task uses up its share for this round (sched_slice) at a tick.',
        ),
      },
      {
        key: 'START_DEBIT',
        on: tr(
          '新程式的 vruntime 設在目前最小值（min_vruntime）後面一段，這一段是它一輪該分到的時間換算成 vruntime，等於先欠一輪。',
          'A new task\'s vruntime is placed after the current minimum (min_vruntime) by one round\'s share converted to vruntime, so it starts one round in debt.',
        ),
        off: tr('新程式的 vruntime 直接設成目前最小值（min_vruntime）。', 'A new task\'s vruntime is set to the current minimum (min_vruntime).'),
      },
    ],
    make: (f) =>
      new CfsV2_6_24({
        ...cfsDefaults,
        features: {
          NEW_FAIR_SLEEPERS: flag(f, 'NEW_FAIR_SLEEPERS'),
          WAKEUP_PREEMPT: flag(f, 'WAKEUP_PREEMPT'),
          START_DEBIT: flag(f, 'START_DEBIT'),
        },
      }),
    tasks: same,
  },
  {
    id: 'eevdf-v6.6',
    title: 'EEVDF v6.6',
    short: 'EEVDF 6.6',
    hz: 1000,
    note: tr(
      '只在沒有多拿的程式（eligible，lag ≥ 0）裡挑，選 deadline 最早的；每次跑的長度（slice）一律 0.75ms，不管程式要求多少。',
      'Picks only among tasks that have not taken more than their share (eligible, lag ≥ 0), choosing the earliest deadline; every run length (slice) is 0.75ms, whatever the task asks for.',
    ),
    family: 'eevdf',
    features: [RUN_TO_PARITY, PLACE_LAG],
    make: (f) =>
      new EevdfV6_6({
        ...eevdfDefaults,
        features: { ...eevdfDefaults.features, RUN_TO_PARITY: flag(f, 'RUN_TO_PARITY'), PLACE_LAG: flag(f, 'PLACE_LAG') },
      }),
    tasks: same,
  },
  {
    id: 'eevdf-v6.12-slice',
    title: tr('EEVDF v6.12（slice 選項）', 'EEVDF v6.12 (slice options)'),
    short: 'EEVDF 6.12',
    hz: 1000,
    note: tr(
      '比 v6.6 多三件事：程式可以要求自己的 slice（custom_slice）；slice 短的程式醒來可以打斷正在跑的（PREEMPT_SHORT）；多拿的程式去睡時，先把多拿的還完才離開佇列（DELAY_DEQUEUE）。其餘沿用 v6.6（簡化）。',
      'Three additions over v6.6: a task can request its own slice (custom_slice); a task with a shorter slice can interrupt the running one when it wakes (PREEMPT_SHORT); a task that took too much stays on the queue after going to sleep until it has paid it back (DELAY_DEQUEUE). Everything else follows v6.6 (simplified).',
    ),
    family: 'eevdf',
    features: [
      {
        key: 'custom_slice',
        on: tr(
          '程式透過 sched_setattr()（sched_attr.sched_runtime 欄位）指定自己每次要跑多久；slice 短，deadline 就早，比較快輪到。',
          'A task states how long it wants to run each time through sched_setattr() (the sched_attr.sched_runtime field); a shorter slice means an earlier deadline and a quicker turn.',
        ),
        off: tr('忽略程式的要求，所有人都用 0.75ms。', 'Requests are ignored; everyone uses 0.75ms.'),
      },
      {
        key: 'PREEMPT_SHORT',
        on: tr(
          'slice 比正在跑的程式（curr）短的程式醒來時，可以取消 curr「跑完這個 slice」的保護（RUN_TO_PARITY）。',
          'When a task with a shorter slice than the running task (curr) wakes up, it can cancel curr\'s "finish this slice" protection (RUN_TO_PARITY).',
        ),
        off: tr('短 slice 的程式醒來，也要等正在跑的程式跑完這次的 slice。', 'A waking task with a short slice still waits for the running task to finish its current slice.'),
      },
      {
        key: 'DELAY_DEQUEUE',
        on: tr(
          '去睡時拿得比應得的多（lag 是負的）的程式，先留在佇列上，等多拿的還完才真正離開，醒來時 lag 大約是 0。',
          'A task that goes to sleep having taken more than its share (negative lag) stays on the queue until the excess is paid back, and only then really leaves; it wakes with a lag of about 0.',
        ),
        off: tr(
          '睡著就離開佇列，多拿的那筆帳存起來，醒來原樣帶回來（和 v6.6 一樣）。',
          'A sleeping task leaves the queue at once; the overdrawn amount is saved and brought back unchanged on wakeup (same as v6.6).',
        ),
      },
      RUN_TO_PARITY,
      PLACE_LAG,
    ],
    make: (f) =>
      new EevdfV6_12({
        ...defaultTunablesV6_12,
        features: {
          ...defaultTunablesV6_12.features,
          RUN_TO_PARITY: flag(f, 'RUN_TO_PARITY'),
          PLACE_LAG: flag(f, 'PLACE_LAG'),
          PREEMPT_SHORT: flag(f, 'PREEMPT_SHORT'),
          DELAY_DEQUEUE: flag(f, 'DELAY_DEQUEUE'),
        },
      }),
    tasks: (specs, f) => (flag(f, 'custom_slice') ? specs : specs.map(({ slice: _slice, ...rest }) => rest)),
  },
  {
    id: 'eevdf-paper',
    title: tr('EEVDF 論文（1995）', 'EEVDF paper (1995)'),
    short: tr('EEVDF 論文', 'EEVDF paper'),
    hz: 1000,
    note: tr(
      '不是 kernel，是 Stoica 與 Abdel-Wahab 論文裡的演算法，拿來當理想的參考：V 用實數精確計算；每次分配一個 0.1ms 的 quantum 給 eligible 中 deadline 最早的 request，醒來的程式等到 quantum 結束才重新比；離開與加入時照論文的公式調整 V，lag 不截斷。',
      'Not a kernel: the algorithm from the Stoica and Abdel-Wahab paper, used as the ideal reference. V is computed exactly with real numbers; each 0.1ms quantum goes to the eligible request with the earliest deadline, and a waking task waits for the quantum to end before deadlines are compared again; V is adjusted by the paper\'s formulas when tasks leave and join, and lag is never clipped.',
    ),
    family: 'paper',
    features: [
      {
        key: 'custom_slice',
        sim: true,
        on: tr(
          '每個程式用自己要求的 request 長度 r（論文本來就允許 request 大小不同）。',
          'Each task uses the request length r it asks for (the paper allows requests of different sizes from the start).',
        ),
        off: tr('所有程式的 request 都是 0.75ms，和 v6.6 一樣。', 'Every request is 0.75ms, as in v6.6.'),
      },
      {
        key: 'keep_lag',
        sim: true,
        on: tr(
          '論文的 strategy 1：離開時的 lag 保留到重新加入，加入時照公式調整 V，自己和其他程式按權重分攤這筆 lag。kernel 的 PLACE_LAG 對應這個策略。',
          "The paper's strategy 1: the lag at leaving is kept until the task rejoins; on joining V is adjusted by the formula, and the task and the others share that lag in proportion to their weights. The kernel's PLACE_LAG corresponds to this strategy.",
        ),
        off: tr(
          '論文的 strategy 2：重新加入一律從 lag = 0 開始，離開前的帳不算了（kernel 關掉 PLACE_LAG 時的做法）。',
          "The paper's strategy 2: a rejoining task always starts at lag = 0 and its previous balance is dropped (what the kernel does with PLACE_LAG off).",
        ),
      },
    ],
    make: (f) => new EevdfPaper({ ...paperDefaults, keep_lag: flag(f, 'keep_lag') }),
    tasks: (specs, f) => (flag(f, 'custom_slice') ? specs : specs.map(({ slice: _slice, ...rest }) => rest)),
  },
];

/** 沒有指定時預設比較的排程器 */
export const DEFAULT_COMPARE = ['o1-v2.6.0', 'cfs-v2.6.24', 'eevdf-v6.6'];

/** 全部開著（kernel 預設） */
export function defaultFlags(v: SchedVariant): Flags {
  return Object.fromEntries(v.features.map((f) => [f.key, true]));
}

/** 被關掉的開關名稱 */
export function changedFlags(v: SchedVariant, flags: Flags): string[] {
  return v.features.filter((f) => !flag(flags, f.key)).map((f) => f.key);
}
