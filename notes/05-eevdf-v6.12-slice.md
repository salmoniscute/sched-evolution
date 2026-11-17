# EEVDF v6.12 選項：custom_slice 為什麼需要 DELAY_DEQUEUE

程式：`src/sched/eevdf-v6.12.ts`（v6.6 的子類別），測試：`test/eevdf-v6.12.test.ts`。
行號指 `kernel-src/v6.12/kernel/sched/fair.c`。

## 移植了什麼

| 項目 | 位置 | 作用 |
|---|---|---|
| `custom_slice` | `syscalls.c:304`、`update_deadline` :1017、`place_entity` :5271 | `sched_attr.sched_runtime` 指定 r_i，限制在 0.1ms–100ms |
| `PREEMPT_SHORT` | `do_preempt_short` :1177、`did_preempt_short` :1166、`check_preempt_wakeup_fair` :8833 | slice 較短且 eligible 的 task 醒來時，把 curr 的 `vlag` 改成 `deadline + 1`，取消 `RUN_TO_PARITY` 保護 |
| `DELAY_DEQUEUE` + `DELAY_ZERO` | `dequeue_entity` :5475、`pick_next_entity` :5626、`requeue_delayed_entity` :6919、`finish_delayed_dequeue_entity` :5468 | 睡著時不 eligible 就留在樹上，被選中時才真正離開；正的 lag 截成 0 |
| fork 的 `ENQUEUE_INITIAL` | `core.c:4829` | 修好 v6.6 的半個 slice 放置 |

原本的範圍決定是「不做 `DELAY_DEQUEUE`」，實測後改變（見下一節）。

## 卡住的地方：短 slice 一開始完全沒效

工作負載：audio（跑 310µs 睡 4.73ms）+ 2 個 compile，2 秒。

| 設定 | audio 喚醒延遲 平均 / p99 | audio CPU 比例 |
|---|---|---|
| GPS 參考 | —（回應時間 930µs） | 5.49% |
| CFS v2.6.24 | 10µs / 0 | 6.06% |
| EEVDF v6.6 | 623µs / 960µs | 5.49% |
| v6.12，不設 slice | 620µs / 960µs | 5.49% |
| v6.12，slice 0.3ms，**沒有 DELAY_DEQUEUE** | 620µs / 960µs | 5.49% |
| v6.12，slice 0.3ms | **3µs / 0** | 6.15% |
| v6.12，slice 0.1ms | 0 / 0 | 6.01% |

只移植 `custom_slice` + `PREEMPT_SHORT` 時，trace 顯示：

1. audio 一次跑完 310µs，期間 V 只前進約 1/3，所以睡著時帶走負的 lag（約 −187µs 虛擬時間）。
2. `PLACE_LAG` 保留這個 lag，醒來時 audio **不 eligible**，`do_preempt_short()` 的第二個條件
   `!entity_eligible(cfs_rq, pse)` 直接回傳 false。
3. 只能等到 lag 回到 0，平均 620µs，剛好是 GPS 下「把欠的還完」需要的時間。

`features.h` 的說明正好是答案：*"By delaying the dequeue for non-eligible tasks, they remain in the
competition and can burn off their negative lag. When they get selected they'll have positive lag by definition."*
睡眠時間（4.73ms）遠大於還債需要的時間，醒來時 lag ≈ 0、eligible，短 slice 的 deadline 最早，`PREEMPT_SHORT` 才能發揮。

**結論：custom slice 的低延遲要靠 DELAY_DEQUEUE 才成立。** 測試裡關掉 `DELAY_DEQUEUE` 或 `PREEMPT_SHORT` 都會讓延遲回到 > 0.2ms。

## 理論與實作的差異

- 以 GPS 參考（睡眠時 lag 凍結）來看，`DELAY_DEQUEUE` 等於**原諒了睡眠期間的負 lag**：audio 拿到全部需求 6.15%，
  GPS 只給 5.49%，相對 GPS 的 lag 2 秒累積到約 −81ms，和 CFS 喚醒補償的效果同一型。
  差別在於 v6.12 是有明確規則的記帳（還完才走、正的截掉），CFS 是固定補償 `sysctl_sched_latency`。
- 這是 GPS 參考的建模選擇造成的對比：如果參考模型改成「離開時丟掉負 lag」，v6.12 就會被看成公平。
  論文怎麼處理 client 帶著 lag 離開，要對照原文確認。
- 被延後的 entity 仍算在 `nr_running` 和 V 的加權平均裡：睡著的 task 還在拉 V。

## 不變式（測試）

- 每次 `finish_delayed_dequeue_entity` 後 vlag 都剛好是 0：被選中代表 lag ≥ 0，DELAY_ZERO 再截成 0。

## 沒有移植的 v6.12 變更

- 樹改依 **deadline** 排序，augmented 欄位從 `min_deadline` 換成 `min_vruntime`。選出的集合相同，
  但平手時不同：v6.12 的 `pick_eevdf` 最後是 `if (!best || (curr && entity_before(curr, best))) best = curr;`，
  而 `entity_before` 改成比 deadline 而且是嚴格小於，所以 deadline 平手時 **curr 不再優先**（模擬器仍沿用 v6.6 的 curr 優先）。
- `pick_eevdf` 在 `nr_running == 1` 時直接回傳（結果相同）。
- `PLACE_REL_DEADLINE`：只影響 migration / save-restore，單核模擬用不到。
- `entity_lag()` 抽成獨立函式，限制值不變（max(2·slice, TICK)）。
