// 網頁上並排比較的排程器，以及每個排程器可以開關的 sched_feat。
// 開關的預設值就是該版本 kernel 的預設值；關掉其中一個，是為了看「少了它會怎樣」。
import type { SchedClass, TaskSpec } from './core/types.ts';
import { CfsV2_6_24, defaultTunables as cfsDefaults } from './sched/cfs-v2.6.24.ts';
import { EevdfV6_6, defaultTunables as eevdfDefaults } from './sched/eevdf-v6.6.ts';
import { EevdfV6_12, defaultTunablesV6_12 } from './sched/eevdf-v6.12.ts';

export interface Feature {
  /** kernel 的 sched_feat 名稱（custom_slice 不是 sched_feat，是 sched_attr 的欄位） */
  key: string;
  /** 一句話：開著的時候它做什麼 */
  on: string;
  /** 一句話：關掉之後變成怎樣 */
  off: string;
}

export type Flags = Record<string, boolean>;

export interface SchedVariant {
  id: string;
  title: string;
  note: string;
  family: 'cfs' | 'eevdf';
  features: Feature[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  make(flags: Flags): SchedClass<any>;
  /** 這個排程器實際看到的工作負載（custom_slice 關掉時拿掉 slice） */
  tasks(specs: TaskSpec[], flags: Flags): TaskSpec[];
}

const RUN_TO_PARITY: Feature = {
  key: 'RUN_TO_PARITY',
  on: '被選中的程式一路跑到目前的 slice 用完（或不再 eligible），中途有人醒來也不重新比 deadline。',
  off: '每次有人醒來都重新比一次 deadline，deadline 較早又 eligible 的可以立刻搶佔。',
};
const PLACE_LAG: Feature = {
  key: 'PLACE_LAG',
  on: '睡前把 lag 存進 vlag，醒來照樣放回去：之前多拿的要先還，被欠的可以先跑。',
  off: '醒來一律放在 V（lag = 0），睡前的帳不算了。',
};

const same = (specs: TaskSpec[]) => specs;
const flag = (flags: Flags, key: string) => flags[key] ?? true;

export const variants: SchedVariant[] = [
  {
    id: 'cfs-v2.6.24',
    title: 'CFS v2.6.24',
    note: 'vruntime 最小者先跑；喚醒時補償最多 sched_latency（20ms）。',
    family: 'cfs',
    features: [
      {
        key: 'NEW_FAIR_SLEEPERS',
        on: '喚醒補償：睡醒的程式放在 min_vruntime − 20ms（不會比它原本的 vruntime 小）。',
        off: '睡醒的程式放在 min_vruntime，沒有額外的補償。',
      },
      {
        key: 'WAKEUP_PREEMPT',
        on: '醒來的程式 vruntime 比 curr 小超過 wakeup_granularity（10ms）就立刻搶佔。',
        off: '醒來不搶佔，要等 curr 在 tick 時用完自己的 sched_slice。',
      },
      {
        key: 'START_DEBIT',
        on: '新程式放在 min_vruntime 後面一個 vslice，先欠一輪。',
        off: '新程式直接放在 min_vruntime。',
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
    note: 'eligible（lag ≥ 0）中 deadline 最早者；slice 一律 0.75ms，忽略 task 的 slice 要求。',
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
    title: 'EEVDF v6.12（slice 選項）',
    note: '加上 custom_slice、PREEMPT_SHORT、DELAY_DEQUEUE。其餘沿用 v6.6（簡化）。',
    family: 'eevdf',
    features: [
      {
        key: 'custom_slice',
        on: '程式用 sched_attr.sched_runtime 指定自己的 slice；slice 短，deadline 就早。',
        off: '忽略程式的要求，所有人都用 0.75ms。',
      },
      {
        key: 'PREEMPT_SHORT',
        on: 'slice 比 curr 短的程式醒來時，可以取消 curr「跑完這個 slice」的保護（RUN_TO_PARITY）。',
        off: '短 slice 的程式醒來也要等 curr 跑完目前的 slice。',
      },
      {
        key: 'DELAY_DEQUEUE',
        on: '睡著時 lag 是負的程式先留在佇列上，等負的 lag 還完才真正離開，醒來時 lag 大約是 0。',
        off: '睡著就離開佇列，負的 lag 存在 vlag，醒來原樣帶回來（和 v6.6 一樣）。',
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
];

/** 全部開著（kernel 預設） */
export function defaultFlags(v: SchedVariant): Flags {
  return Object.fromEntries(v.features.map((f) => [f.key, true]));
}

/** 被關掉的開關名稱 */
export function changedFlags(v: SchedVariant, flags: Flags): string[] {
  return v.features.filter((f) => !flag(flags, f.key)).map((f) => f.key);
}
