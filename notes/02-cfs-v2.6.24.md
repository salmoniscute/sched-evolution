# CFS v2.6.24：實作時注意到的細節

實作：`src/sched/cfs-v2.6.24.ts`。測試：`test/cfs-v2.6.24.test.ts`。

## 驗證結果（比較情境 5）

3 個 CPU-bound task，nice -5 / 0 / 5，跑 10 秒（HZ=1000）：

| nice | weight | 實際 | 理論 w/Σw |
|---|---|---|---|
| -5 | 3121 | 69.67% | 69.67% |
| 0 | 1024 | 22.85% | 22.86% |
| 5 | 335 | 7.48% | 7.48% |

## 讀原始碼 / 實作時卡住或意外的地方

1. **`min_vruntime` 從 `-(1 << 20)` 開始**（`kernel/sched.c:6746`）。u64 一開機就快溢位，
   是故意讓溢位 bug 早點出現。所以所有 vruntime 比較都寫成 `(s64)(a - b)`，而不是 `a < b`。
   JS 的 number 本身有號，直接比較即可。

2. **新 task 不是放在 `min_vruntime`，而是再往後一個 vslice**（`START_DEBIT`，`place_entity` :488）。
   trace 中第一個 task 的 vruntime = −1048576 + 20ms = 18951424。
   理由：這一輪的時間已經承諾給現有的 task，新來的排到這一輪的最後。這也防止 fork 炸彈靠不斷 fork 插隊。

3. **`check_preempt_tick` 用 `>` 而不是 `>=`**（:575）。tick 只在整數 ms 檢查，兩個 nice 0 task 的
   slice 是 10ms，但 10ms 那次 tick 時 `delta_exec == ideal_runtime`，沒有觸發，要到 11ms 才切換。
   實際的 slice 長度受 HZ 影響。

4. **`task_new_fair` 無條件 `resched_task(rq->curr)`**（:1087）。結果 curr 經過 `put_prev` → `pick_next`
   還是被選回來，但 `set_next_entity` 會重設 `prev_sum_exec_runtime`，**curr 的 slice 重新計時**。
   trace：t=5ms 新 task 進來後，task 1 從 5ms 跑到 16ms，而不是 0→11ms。

5. **`check_preempt_wakeup` 沒有先呼叫 `update_curr`**（:841）。看起來會拿到過時的 curr vruntime，
   但呼叫它之前的 `enqueue_entity` 已經做過 `update_curr`，所以沒問題。

6. **睡醒補償上限是一個 `sched_latency`（20ms）**（`NEW_FAIR_SLEEPERS`）。
   睡越久不會累積越多優勢，而且 `max_vruntime(se->vruntime, …)` 保證不會因為睡覺而「倒退」。
   互動型 task（跑 1ms 睡 9ms）醒來時 vruntime 遠小於 hog，差距超過 `wakeup_granularity`（10ms），
   所以每次都立即搶佔，喚醒延遲為 0。

7. **`calc_delta_mine` 有兩條捨入路徑**（`kernel/sched.c:752`）：`delta × weight` 超過 2^32
   （nice 0 時約 4.2ms 以上）就先右移 16 位元再乘，精度較差。模擬器用 BigInt 重現。

## 模擬器的簡化

- `sysctl_sched_child_runs_first` 預設關閉（kernel 預設開）。工作負載的 task 不是由目前正在跑的 task
  fork 出來的，套用的話會和不相干的 task 互換 vruntime。
- 新 task 一律走 `task_new_fair`。kernel 在 parent 不在 runqueue 時會改走 `activate_task(rq, p, 0)`。
- rbtree 用有序陣列代替，排序結果相同（相同 key 往右）。成本以 ⌈log2(n+1)⌉ 計。
