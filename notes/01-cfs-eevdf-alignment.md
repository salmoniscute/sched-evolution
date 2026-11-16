# CFS (v2.6.24) 與 EEVDF (v6.6)：模擬器要對齊的函式與欄位

原始碼：`kernel-src/`（由 `scripts/fetch-kernel-src.sh` 抓取）。行號都對應該版本的檔案。

## 1. 版本選擇的兩個發現

- **v2.6.23 不是我們熟悉的 CFS。** 2.6.23 用 `fair_clock` + `wait_runtime` + `sleeper_bonus`，沒有 `vruntime`。
  `vruntime` / `min_vruntime` / `place_entity()` / `sched_slice()` 從 v2.6.24 開始，所以 CFS 對齊 v2.6.24。
  2.6.23 留作歷史說明：CFS 合併後只過一個版本就重寫了記帳模型。
- **v6.6 的 EEVDF 不能設定每個 task 的 slice。** `place_entity()`（`fair.c:4979`）和 `update_deadline()`（`fair.c:1029`）
  都直接寫 `se->slice = sysctl_sched_base_slice`。自訂 slice（`se->custom_slice`，經由 `sched_attr.sched_runtime` 設定）
  和 `PREEMPT_SHORT` 到 **v6.12** 才出現。比較情境 4（短 slice）因此要用 v6.12 的行為。

## 2. 資料結構

模擬器只保留排程決策需要的欄位。schedstats、PELT（`update_load_avg`）、cgroup、bandwidth 全部略過。

### `struct sched_entity`

| 欄位 | v2.6.24 `include/linux/sched.h:866` | v6.6 `include/linux/sched.h:548` | 用途 |
|---|---|---|---|
| `load.weight` | ✓ | ✓ | nice → 權重 |
| `run_node` | ✓ | ✓ | rbtree 節點（模擬器用排序陣列即可，但要能畫成樹） |
| `on_rq` | ✓ | ✓ | |
| `exec_start` | ✓ | ✓ | `update_curr` 算 delta |
| `sum_exec_runtime` | ✓ | ✓ | 實際 CPU 時間 |
| `prev_sum_exec_runtime` | ✓ | ✓ | 本次上 CPU 前的值（2.6.24 拿來判斷 slice 用完沒） |
| `vruntime` | ✓ | ✓ | |
| `deadline` | — | ✓ | 虛擬截止時間 `vd_i` |
| `min_deadline` | — | ✓ | augmented rbtree：子樹最小 deadline |
| `vlag` | — | ✓ | dequeue 時存 lag。**被選中執行時暫存 deadline**（`set_next_entity` 的 HACK，給 `RUN_TO_PARITY` 用） |
| `slice` | — | ✓ | request size `r_i` |

### `struct cfs_rq`

| 欄位 | v2.6.24 `kernel/sched.c:231` | v6.6 `kernel/sched/sched.h:546` |
|---|---|---|
| `load.weight` | ✓ | ✓ |
| `nr_running` | ✓ | ✓ |
| `min_vruntime` | ✓ | ✓（降級成 `avg_vruntime` 的基準點 v0） |
| `tasks_timeline` + `rb_leftmost` | ✓ | ✓（`rb_root_cached`） |
| `curr` | ✓ | ✓ |
| `avg_vruntime` | — | ✓ `Σ (v_i − v0)·w_i` |
| `avg_load` | — | ✓ `Σ w_i` |

**關鍵：`curr` 不在樹裡。** 兩版都在 `set_next_entity` 把 curr 拿出樹，`put_prev_entity` 放回去。
v6.6 的 `avg_vruntime()` / `entity_eligible()` 因此要另外把 curr 加回去算。模擬器的「樹」視覺化要處理這點。

## 3. 參數

| | v2.6.24 | v6.6 |
|---|---|---|
| 權重表 | `prio_to_weight[40]` `kernel/sched.c:813` | `sched_prio_to_weight[40]` `kernel/sched/core.c:11542`（數值相同） |
| 延遲目標 | `sysctl_sched_latency = 20ms` `sched_fair.c:35` | 已移除 |
| 最小粒度 | `sysctl_sched_min_granularity = 4ms` `:41`，`sched_nr_latency = 5` | 已移除 |
| 喚醒粒度 | `sysctl_sched_wakeup_granularity = 10ms` `:80` | 已移除 |
| slice | 動態算：`sched_slice()` | `sysctl_sched_base_slice = 0.75ms` `fair.c:78` |
| features | `NEW_FAIR_SLEEPERS`、`WAKEUP_PREEMPT`、`START_DEBIT` 開；`TREE_AVG`、`APPROX_AVG` 關（`sched.c:464`） | `PLACE_LAG`、`PLACE_DEADLINE_INITIAL`、`RUN_TO_PARITY`、`WAKEUP_PREEMPTION` 開；`NEXT_BUDDY` 關（`features.h`） |

註：kernel 的預設值會乘上 `1 + ilog(ncpus)`。單核時係數為 1，上表就是實際值。

## 4. 函式對照（模擬器要用同名函式）

### 共通骨架

```
tick:    entity_tick → update_curr → (2.6.24) check_preempt_tick / (6.6) update_deadline 內 resched
wakeup:  enqueue_entity → place_entity → __enqueue_entity → check_preempt_wakeup
sleep:   dequeue_entity → update_curr → (6.6) update_entity_lag → __dequeue_entity
switch:  put_prev_entity → pick_next_entity → set_next_entity
fork:    (2.6.24) task_new_fair → place_entity(initial=1) / (6.6) place_entity(ENQUEUE_INITIAL)
```

### v2.6.24 `kernel/sched_fair.c`

| 函式 | 行 | 模擬器要做的 |
|---|---|---|
| `__sched_period` | 245 | `nr ≤ 5 ? 20ms : 20ms·nr/5` |
| `sched_slice` | 264 | `period · w / Σw`（實際時間） |
| `__sched_vslice` / `sched_vslice_add` | 279 | `period · 1024 / Σw`（虛擬時間，給 `place_entity`） |
| `__update_curr` / `update_curr` | 305 / 336 | `vruntime += delta · 1024 / w`；`min_vruntime = max(min_vruntime, min(curr, leftmost))` |
| `__enqueue_entity` / `__dequeue_entity` | 146 / 183 | 依 `vruntime − min_vruntime` 排序 |
| `__pick_next_entity` | 196 | 取最左 |
| `place_entity` | 488 | 新 task：`min_vruntime + vslice_add`（START_DEBIT）。喚醒：`max(se->vruntime, min_vruntime − 20ms)`（NEW_FAIR_SLEEPERS） |
| `enqueue_entity` / `dequeue_entity` | 525 / 545 | |
| `check_preempt_tick` | 575 | 本次已跑 `sum − prev_sum > sched_slice` 就 resched |
| `set_next_entity` / `pick_next_entity` / `put_prev_entity` | 586 / 615 / 627 | |
| `entity_tick` | 645 | |
| `check_preempt_wakeup` | 841 | `pse->vruntime + gran < se->vruntime` 就搶佔；`gran = 10ms` 按 curr 權重換算 |
| `task_new_fair` | 1065 | `child_runs_first`：若 curr 的 vruntime 較小就和 child 互換 |

### v6.6 `kernel/sched/fair.c`

| 函式 | 行 | 模擬器要做的 |
|---|---|---|
| `calc_delta_fair` | 311 | `delta · 1024 / w` |
| `entity_key` | 572 | `v_i − min_vruntime` |
| `avg_vruntime_add` / `_sub` | 639 | 維護 `Σ key·w`、`Σ w` |
| `avg_vruntime` | 671 | `V = v0 + Σ key·w / Σ w`（含 curr；負數向下取整） |
| `update_entity_lag` | 710 | `vlag = clamp(V − v_i, ±calc_delta_fair(max(2·slice, TICK)))` |
| `entity_eligible` | 738 | `Σ key·w ≥ key_i · Σ w`（不做除法，避免精度誤差） |
| `update_min_vruntime` | 768 | 前進時要同步修正 `avg_vruntime`（`avg_vruntime_update`） |
| `__enqueue_entity` / `__dequeue_entity` | 831 / 839 | 依 vruntime 排序，並維護 `min_deadline` |
| `__pick_eevdf` / `pick_eevdf` | 875 / 969 | eligible 中 deadline 最小者；`RUN_TO_PARITY` 時，curr 的 deadline 沒變（`vlag == deadline`）就繼續跑 curr |
| `update_deadline` | 1019 | `vruntime ≥ deadline` 時：`deadline = vruntime + slice·1024/w`，`nr_running > 1` 就 resched |
| `update_curr` | 1150 | `vruntime += calc_delta_fair`；`update_deadline`；`update_min_vruntime` |
| `place_entity` | 4974 | `v = V − lag·(W + w_i)/W`（lag 補償）；`deadline = v + vslice`（新 task 為 `vslice/2`） |
| `enqueue_entity` / `dequeue_entity` | 5080 / 5167 | |
| `set_next_entity` | 5220 | 出樹 + `vlag = deadline` 的 HACK |
| `pick_next_entity` | 5270 | `NEXT_BUDDY` 預設關，等同 `pick_eevdf` |
| `put_prev_entity` | 5284 | |
| `entity_tick` | 5307 | 只呼叫 `update_curr`（已無 `check_preempt_tick`） |
| `check_preempt_wakeup` | 8055 | `update_curr` 後 `pick_eevdf(cfs_rq) == pse` 就搶佔 |

## 5. 模擬器的簡化（要在介面上標示）

- `__pick_eevdf` 的 augmented rbtree 走訪是 O(log n)。模擬器可先用線性掃描得到**相同結果**，視覺化時再示範 `min_deadline` 剪枝。
- 時間單位用 ns 整數，除法照 kernel 的整數除法（`calc_delta_mine` 在 2.6.24 用 `inv_weight` 做定點乘法，誤差很小，先用直接除法，必要時再對齊）。
- tick 頻率：模擬器設定可調（預設 HZ=1000 → 1ms），會影響 v2.6.24 slice 結束的判斷時機。

## 6. 待決定

- 情境 4（短 slice）要用 v6.12 的 `custom_slice` + `PREEMPT_SHORT`。是要把 EEVDF 主線改成 v6.12，還是 v6.6 主線 + v6.12 的「自訂 slice」選項？
