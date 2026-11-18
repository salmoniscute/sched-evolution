// 原始碼頁要用的片段清單。產生 src/source/snippets.json：npm run extract-snippets
// marks 的字串必須在片段中剛好出現在一行（見 extract.ts）。

import type { SnippetSpec } from './extract.ts';

export const manifest: SnippetSpec[] = [
  // ---- CFS v2.6.24：喚醒補償 --------------------------------------------
  {
    id: 'v2.6.24/place_entity',
    tag: 'v2.6.24',
    file: 'kernel/sched_fair.c',
    fn: 'place_entity',
    marks: {
      base: 'vruntime = cfs_rq->min_vruntime;',
      debit_if: 'if (initial && sched_feat(START_DEBIT))',
      debit: 'vruntime += sched_vslice_add(cfs_rq, se);',
      wake_if: 'if (!initial) {',
      sleeper: 'vruntime -= sysctl_sched_latency;',
      clamp: 'vruntime = max_vruntime(se->vruntime, vruntime);',
      assign: 'se->vruntime = vruntime;',
    },
  },
  {
    id: 'v2.6.24/enqueue_entity',
    tag: 'v2.6.24',
    file: 'kernel/sched_fair.c',
    fn: 'enqueue_entity',
    marks: {
      update_curr: 'update_curr(cfs_rq);',
      place: 'place_entity(cfs_rq, se, 0);',
      tree: '__enqueue_entity(cfs_rq, se);',
    },
  },
  {
    id: 'v2.6.24/dequeue_entity',
    tag: 'v2.6.24',
    file: 'kernel/sched_fair.c',
    fn: 'dequeue_entity',
    marks: {
      update_curr: 'update_curr(cfs_rq);',
      sleep_start: 'se->sleep_start = rq_of(cfs_rq)->clock;',
      account: 'account_entity_dequeue(cfs_rq, se);',
    },
  },

  // ---- CFS v6.5：EEVDF 之前的最後一版 ------------------------------------
  {
    id: 'v6.5/place_entity',
    tag: 'v6.5',
    file: 'kernel/sched/fair.c',
    fn: 'place_entity',
    marks: {
      base: 'u64 vruntime = cfs_rq->min_vruntime;',
      debit: 'vruntime += sched_vslice(cfs_rq, se);',
      thresh: 'thresh = sysctl_sched_latency;',
      gentle: 'thresh >>= 1;',
      sleeper: 'vruntime -= thresh;',
      long_sleeper: 'if (entity_is_long_sleeper(se))',
      clamp: 'se->vruntime = max_vruntime(se->vruntime, vruntime);',
    },
  },
  {
    id: 'v6.5/entity_is_long_sleeper',
    tag: 'v6.5',
    file: 'kernel/sched/fair.c',
    fn: 'entity_is_long_sleeper',
    marks: {
      limit: 'if (sleep_time > ((1ULL << 63) / scale_load_down(NICE_0_LOAD)))',
    },
  },
  {
    id: 'v6.5/migration-comment',
    tag: 'v6.5',
    file: 'kernel/sched/fair.c',
    comment: ' * MIGRATION',
  },
  {
    id: 'v6.5/enqueue_entity',
    tag: 'v6.5',
    file: 'kernel/sched/fair.c',
    fn: 'enqueue_entity',
    marks: {
      renorm: 'bool renorm = !(flags & ENQUEUE_WAKEUP) || (flags & ENQUEUE_MIGRATED);',
      renorm_curr: 'if (renorm && curr)',
      renorm_other: 'if (renorm && !curr)',
      place: 'place_entity(cfs_rq, se, 0);',
      migrated: 'se->exec_start = 0;',
    },
  },
  {
    id: 'v6.5/dequeue_entity',
    tag: 'v6.5',
    file: 'kernel/sched/fair.c',
    fn: 'dequeue_entity',
    marks: {
      normalize_if: 'if (!(flags & DEQUEUE_SLEEP))',
      normalize: 'se->vruntime -= cfs_rq->min_vruntime;',
    },
  },
  {
    id: 'v6.5/migrate_task_rq_fair',
    tag: 'v6.5',
    file: 'kernel/sched/fair.c',
    fn: 'migrate_task_rq_fair',
    leadingComment: true,
    marks: {
      waking: 'if (READ_ONCE(p->__state) == TASK_WAKING) {',
      normalize: 'se->vruntime -= u64_u32_load(cfs_rq->min_vruntime);',
    },
  },

  // ---- EEVDF v6.6：lag 取代補償 ----------------------------------------
  {
    id: 'v6.6/update_entity_lag',
    tag: 'v6.6',
    file: 'kernel/sched/fair.c',
    fn: 'update_entity_lag',
    leadingComment: true,
    marks: {
      lag: 'lag = avg_vruntime(cfs_rq) - se->vruntime;',
      limit: 'limit = calc_delta_fair(max_t(u64, 2*se->slice, TICK_NSEC), se);',
      clamp: 'se->vlag = clamp(lag, -limit, limit);',
    },
  },
  {
    id: 'v6.6/place_entity',
    tag: 'v6.6',
    file: 'kernel/sched/fair.c',
    fn: 'place_entity',
    marks: {
      V: 'u64 vslice, vruntime = avg_vruntime(cfs_rq);',
      slice: 'se->slice = sysctl_sched_base_slice;',
      vslice: 'vslice = calc_delta_fair(se->slice, se);',
      lag_if: 'if (sched_feat(PLACE_LAG) && cfs_rq->nr_running) {',
      vlag: 'lag = se->vlag;',
      load: 'load = cfs_rq->avg_load;',
      inflate: 'lag *= load + scale_load_down(se->load.weight);',
      div: 'lag = div_s64(lag, load);',
      assign: 'se->vruntime = vruntime - lag;',
      initial: 'vslice /= 2;',
      deadline: 'se->deadline = se->vruntime + vslice;',
    },
  },
  {
    id: 'v6.6/enqueue_entity',
    tag: 'v6.6',
    file: 'kernel/sched/fair.c',
    fn: 'enqueue_entity',
    marks: {
      migrated: 'se->exec_start = 0;',
    },
  },
  {
    id: 'v6.6/dequeue_entity',
    tag: 'v6.6',
    file: 'kernel/sched/fair.c',
    fn: 'dequeue_entity',
    marks: {
      lag: 'update_entity_lag(cfs_rq, se);',
    },
  },
  {
    id: 'v6.6/migrate_task_rq_fair',
    tag: 'v6.6',
    file: 'kernel/sched/fair.c',
    fn: 'migrate_task_rq_fair',
    leadingComment: true,
  },
];
