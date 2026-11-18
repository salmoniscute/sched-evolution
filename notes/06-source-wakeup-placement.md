# 原始碼頁第一批：喚醒時的放置與 migration

頁面：`src/ui/source.ts`。片段清單：`src/source/manifest.ts`，抽取：`npm run extract-snippets` → `src/source/snippets.json`。
測試 `test/snippets.test.ts` 會重新抽一次，和 JSON 比對，避免手動改到或 manifest 改了忘記重跑。

## 抽取腳本的做法

- 函式靠 kernel coding style 找：名稱在行首（回傳型別在上一行）或「型別 名稱(」在行首，本體的 `{`、`}` 在第 0 欄。
  以 `;` 結尾的是宣告，跳過。同名定義超過一個（`#ifdef` 兩版）就要求在 manifest 指定 `nth`。
- 要高亮的行用一段字串指定，不寫行號。字串必須在片段中剛好出現一次，否則報錯，換版本時不會默默對錯行。
  v6.6 `enqueue_entity()` 裡兩處 `place_entity(cfs_rq, se, flags);` 長得一樣，所以沒有拿來當 mark。
- Elixir 的版本名稱：2.6 以後是 `v2.6.24`，2.4 是 `2.4.0`（沒有 v，`v2.4.0` 會 404）。v2.6.0、v2.6.24、v6.5 都有。

## 讀原始碼時確認的事

1. v6.5 的補償：`thresh = sysctl_sched_latency`，`GENTLE_FAIR_SLEEPERS` 再右移一位。latency 是 6ms × (1 + ilog2(min(CPU 數, 8)))
   （`get_update_sysctl_factor()`，`SCHED_TUNABLESCALING_LOG`），單核補 3ms，8 核以上補 12ms。
2. `GENTLE_FAIR_SLEEPERS` 從 v2.6.32 開始（v2.6.31 的 `sched_features.h` 沒有），同一版 latency 預設從 20ms 改成 5ms。
3. `entity_is_long_sleeper()` 是 v6.3 加的（v6.2 沒有，v6.3 和 v6.4 內容相同）。用途是避免 `(s64)(a − b)` 溢位讓 `max_vruntime()` 比反。
4. v6.5 `enqueue_entity()` 的 `renorm = !(flags & ENQUEUE_WAKEUP) || (flags & ENQUEUE_MIGRATED)`：本地喚醒時 vruntime 是絕對值，
   不用加回 min_vruntime；被搬來或遠端喚醒的才要。遠端喚醒時的減法在 `migrate_task_rq_fair()`（`TASK_WAKING`）。
5. v6.6 每次 dequeue 都呼叫 `update_entity_lag()`，每次 enqueue 都呼叫 `place_entity()`（兩處都不看 flags），
   所以 migration 不需要另外正規化。min_vruntime 還在，只當 `avg_vruntime` 的基準點（`entity_key()`）。
6. 放置順序：v2.6.24 先 `place_entity()` 再 `account_entity_enqueue()`；v6.5 反過來；v6.6 又是先放置。
   CFS 的放置不看負載，順序沒影響。v6.6 的註解說要等 reweight（`update_cfs_group()`）之後再放置。

## 模擬結果（頁面上的情境）

兩個 compile + editor（跑 1.3ms，睡 4.7 / 4.7 / 97.3ms 循環）：

- CFS v2.6.24：前兩次短睡醒來保留原本的 vruntime（補償沒用上）。第一次長睡之後被拉到 min_vruntime − 20ms，
  之後每次只跑 1.3ms 追不回來，連短睡醒來也一直被拉回 −20ms，等於貼著補償上限。這解釋了 GPS 對照下 editor lag 一路往下。
- EEVDF v6.6：醒來位置只由睡前的 vlag 決定，乘上 (W + w)/W = 1.5 倍再反號，和睡多久無關。這個情境裡 vlag 都沒碰到 ±1.5ms 的上限。

## 模擬器的改動

只增加 trace 記錄的欄位，排程邏輯沒動：CFS `place_entity` 加 `debit`、`thresh`、`candidate`、`kept_old`，`dequeue_entity` 加 `min_vruntime`；
EEVDF `place_entity` 加 `W`、`weight`、`vslice`，`update_entity_lag` 加 `V`、`vruntime`。
