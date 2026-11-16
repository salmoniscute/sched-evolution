# EEVDF v6.6：實作時注意到的細節

實作：`src/sched/eevdf-v6.6.ts`。測試：`test/eevdf-v6.6.test.ts`、`test/common.test.ts`（和 CFS 共用）。

## 驗證結果

比較情境 5（nice -5 / 0 / 5，10 秒）：69.66% / 22.86% / 7.48%，理論值 69.67% / 22.86% / 7.48%。

測試用一個子類別 `Checked`，在每次 tick / enqueue / pick 之後檢查：
- 增量維護的 `avg_vruntime()` 和用定義直接算的 V **完全相等**
- 被選中的 task 一定 eligible
- 喚醒後 `V − v_i` 等於 dequeue 時記下的 `vlag`（誤差 ≤ 4ns，來自整數除法）

故意拿掉 `avg_vruntime_update()` 後，有 4 個測試失敗，確認這些測試真的抓得到錯。

## 和 CFS v2.6.24 的對照（compile + editor）

editor 跑 run、睡 sleep，和一個 CPU-bound 的 compile 一起跑 10 秒，時間刻意不對齊 tick：

| editor（run / sleep） | 排程器 | editor 拿到 | 需求 | 喚醒延遲 p99 | max |
|---|---|---|---|---|---|
| 1.037 / 9.311 ms | CFS | 10.02% | 10.02% | 0 | 1.65ms |
| | EEVDF | 9.12% | | 1.30ms | 1.30ms |
| 0.3 / 4.77 ms | CFS | 5.91% | 5.92% | 0 | 5.93ms |
| | EEVDF | 5.59% | | 0.86ms | 0.86ms |
| 2.2 / 3.13 ms | CFS | 41.21% | 41.28% | 0 | 7.67ms |
| | EEVDF | 29.22% | | 1.34ms | 1.34ms |

- **CFS 的睡眠補償**：醒來時 vruntime 被放在 `min_vruntime − 20ms` 附近，幾乎都立刻搶佔（p99 = 0），
  而且 burst 一次跑完，需求全部滿足。但補償用完時 max 會跳到好幾 ms：尾端延遲沒有上限保證。
- **EEVDF 沒有睡眠補償**：lag 只保留「睡之前」的狀態，睡越久也不會多拿。editor 可執行時只能和 compile
  對分，所以 2.2ms 的 burst 要花約 4.4ms 才跑完。比例 = run / (2·run + sleep) = 29.2%，和模擬結果一致。
  換來的是**延遲上限很緊**：max 不超過約一個 tick。
- 這正是比較情境 4 要接的地方：v6.6 無法讓 editor 宣告「我要短 slice」，v6.12 的 `custom_slice` + `PREEMPT_SHORT` 可以。

## 讀原始碼 / 實作時卡住或意外的地方

1. **v6.6 的 fork 放置被覆蓋了。** `task_fork_fair()`（:12410）用 `ENQUEUE_INITIAL` 呼叫 `place_entity`，
   讓新 task 只拿半個 slice。但 `wake_up_new_task()` 接著呼叫 `activate_task(rq, p, ENQUEUE_NOCLOCK)`
   （core.c:4872），沒帶 `ENQUEUE_INITIAL`。`enqueue_entity` 又呼叫一次 `place_entity`，覆蓋成完整 slice。
   **`PLACE_DEADLINE_INITIAL` 在 v6.6 實際上沒有作用。** v6.12 改成 `ENQUEUE_NOCLOCK | ENQUEUE_INITIAL`（core.c:4829）。

2. **`set_next_entity` 把 deadline 暫存在 `vlag`**（:5220 附近的 HACK）。`vlag` 只在 dequeue 時才有意義，
   執行中閒著，就拿來記「被選中時的 deadline」。之後 `curr->vlag == curr->deadline` 表示這個 slice 還沒用完，
   `RUN_TO_PARITY` 就繼續跑 curr，不被喚醒的 task 搶走。

3. **`min_vruntime` 從主角降級成基準點 v0。** 它只用來讓 `avg_vruntime` 存相對值（避免 `v_i · w_i` 溢位）。
   所以 v0 前進時要呼叫 `avg_vruntime_update()` 修正總和，這是最容易漏掉的一步，也是上面突變測試弄壞的地方。

4. **`entity_eligible()` 刻意不做除法**：比較 `Σ(v−v0)·w ≥ (v_i−v0)·Σw`，避免 `avg_vruntime()` 取整後誤判。
   `avg_vruntime()` 對負數改成向下取整，讓 V 偏左，保證 V 本身一定 eligible。

5. **`place_entity` 的 lag 補償**：新 entity 加入會把 V 往它的方向拉，直接放在 `V − vlag` 的話 lag 會縮水。
   所以先把 lag 放大成 `vlag · (W + w_i) / W`，加入後實際的 lag 才剛好等於 `vlag`（測試驗證誤差 ≤ 4ns）。

6. **`__calc_delta` 和 2.6.24 的 `calc_delta_mine` 不同**：沒有四捨五入，最後一步截斷。nice -20 時結果只有
   ~115µs，截斷 0.98ns 換成相對誤差就有 8.5e-6。一開始的測試用相對誤差 1e-6 判斷而失敗，錯在測試標準，不是實作。

7. **slice 0.75ms 但 tick 1ms**：沒有 HRTICK（預設關）時，slice 用完只能在下一個 tick 才發現，
   所以兩個 hog 實際上每 1ms 切換一次，一秒約 1000 次（CFS v2.6.24 約 90 次）。

## 模擬器的簡化

- `__pick_eevdf` 用線性掃描代替 augmented rbtree：樹依 vruntime 排序，eligible 的一定是左邊連續一段，
  遇到第一個不 eligible 就停，結果集合相同。**deadline 完全相同時**，kernel 的結果取決於樹的形狀；
  這裡取最左邊、curr 優先。
- **人造的平手**：工作負載的時間如果剛好對齊 tick（例如跑 1ms 睡 9ms），editor 醒來時 lag 為 0、
  deadline 和剛換新 deadline 的 compile 完全相同，平手時 curr 勝出，每次都要等 1ms。
  按 kernel 的樹走訪推演，這個情況 kernel 也回傳 curr，但真實系統的時間不會這麼剛好。比較情境應使用不對齊的時間。
- 權重存未放大的值（nice 0 = 1024），kernel 64 位元版本存 `w << 10`，但計算前都會 `scale_load_down()`，結果相同。
