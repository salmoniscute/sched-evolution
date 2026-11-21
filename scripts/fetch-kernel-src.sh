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
  "v6.5    kernel/sched/fair.c"       # EEVDF 之前最後一版 CFS：GENTLE_FAIR_SLEEPERS、migration 的 vruntime 正規化
  "v6.5    kernel/sched/features.h"
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
  "v6.12   kernel/sched/ext.c"        # sched_ext：struct sched_ext_ops、watchdog、退回 fair class
  "v6.12   Documentation/scheduler/sched-ext.rst"
)

for entry in "${FILES[@]}"; do
  read -r tag path <<<"$entry"
  out="$DEST/$tag/$path"
  mkdir -p "$(dirname "$out")"
  url="https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/$path?h=$tag"
  echo "fetch $tag $path"
  curl -fsSL --retry 3 "$url" -o "$out"
done

# 2.4 / 2.6.0 比 git 歷史（v2.6.12）還早：從 kernel.org 的 tarball 只解出需要的檔案
# 版本  tarball 目錄  tarball 裡的頂層目錄  檔案...
TARBALLS=(
  "v2.4.0 v2.4 linux kernel/sched.c kernel/fork.c kernel/timer.c include/linux/sched.h"
  "v2.6.0 v2.6 linux-2.6.0 kernel/sched.c kernel/fork.c kernel/timer.c include/linux/sched.h"
)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for entry in "${TARBALLS[@]}"; do
  read -r tag dir top files <<<"$entry"
  ver="${tag#v}"
  url="https://cdn.kernel.org/pub/linux/kernel/$dir/linux-$ver.tar.gz"
  echo "fetch $url"
  members=()
  for f in $files; do members+=("$top/$f"); done
  curl -fsSL --retry 3 "$url" | tar xzf - -C "$TMP" "${members[@]}"
  for f in $files; do
    mkdir -p "$DEST/$tag/$(dirname "$f")"
    cp "$TMP/$top/$f" "$DEST/$tag/$f"
  done
done

echo "done -> $DEST"
