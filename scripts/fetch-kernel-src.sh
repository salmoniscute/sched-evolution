#!/usr/bin/env bash
# 從 git.kernel.org（torvalds/linux）的 git tag 抓指定版本的排程器原始碼到 kernel-src/<tag>/<path>
# 用法：scripts/fetch-kernel-src.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/kernel-src"

# tag  path
FILES=(
  "v2.6.23 kernel/sched_fair.c"
  "v2.6.23 kernel/sched.c"            # prio_to_weight[]、prio_to_wmult[]
  "v2.6.23 include/linux/sched.h"     # struct sched_entity / cfs_rq 相關
  "v2.6.24 kernel/sched_fair.c"       # vruntime / place_entity 首次出現
  "v2.6.24 kernel/sched.c"            # cfs_rq 定義、prio_to_weight[]、calc_delta_mine
  "v2.6.24 include/linux/sched.h"     # struct sched_entity
  "v6.6    kernel/sched/fair.c"
  "v6.6    kernel/sched/core.c"       # sched_prio_to_weight[]
  "v6.6    kernel/sched/sched.h"
  "v6.6    kernel/sched/features.h"   # PLACE_LAG / RUN_TO_PARITY 等預設值
  "v6.6    include/linux/sched.h"     # struct sched_entity（deadline / vlag / slice）
  "v6.12   kernel/sched/fair.c"       # custom_slice、PREEMPT_SHORT、DELAY_DEQUEUE
  "v6.12   kernel/sched/core.c"       # wake_up_new_task 的 ENQUEUE_INITIAL、__setscheduler_params
  "v6.12   kernel/sched/syscalls.c"   # sched_attr.sched_runtime → se.slice
  "v6.12   kernel/sched/sched.h"
  "v6.12   kernel/sched/features.h"
  "v6.12   include/linux/sched.h"     # struct sched_entity（custom_slice / min_slice）
)

for entry in "${FILES[@]}"; do
  read -r tag path <<<"$entry"
  out="$DEST/$tag/$path"
  mkdir -p "$(dirname "$out")"
  url="https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/$path?h=$tag"
  echo "fetch $tag $path"
  curl -fsSL --retry 3 "$url" -o "$out"
done

echo "done -> $DEST"
