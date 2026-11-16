# sched-evolution

> 回覆語言：一律用繁體中文（包括工作中途的進度說明）。程式碼識別字、kernel 函式名稱維持原文。

在瀏覽器裡跑的 Linux CPU 排程器演進模擬器：同一組工作負載丟給不同年代的排程器跑，並排比較行為，並對照當年 kernel 的關鍵原始碼。

## 目的

- 主要動機：作者藉此複習 CPU 排程器的核心觀念，學習優先，履歷其次。
- 不需要 Linux / VM，全部在 Mac 的瀏覽器裡開發與執行。
- 定位是教學工具。現有的 Perfetto、KernelShark 是看真實 trace，這個專案要回答「排程器為什麼這樣決定」，以及「各代設計怎麼演進」。

## 要涵蓋的排程器（演進主線）

| 排程器 | 版本 | 原始碼 | 關鍵函式 |
|---|---|---|---|
| O(n) | 2.4 | `kernel/sched.c` | `goodness()`、`schedule()`、counter 重算 |
| O(1) | 2.6.0 | `kernel/sched.c` | `prio_array`、`sched_find_first_bit()`、active/expired 交換、`effective_prio()` / sleep_avg |
| CFS | v2.6.24 | `kernel/sched_fair.c`（權重表 `prio_to_weight[]` 在 `kernel/sched.c`） | `update_curr()`、`__pick_next_entity()`、`place_entity()`、`sched_slice()` |
| EEVDF | v6.6 | `kernel/sched/fair.c` | `pick_eevdf()`、`entity_eligible()`、`update_deadline()`、`place_entity()`（lag） |
| EEVDF 選項 | v6.12 | `kernel/sched/fair.c` | 只移植 `custom_slice` + `PREEMPT_SHORT`（給比較情境 4），不做 `DELAY_DEQUEUE` |
| sched_ext | 6.12 | — | 只當結尾介紹，不實作 |

RSDL/SD/BFS（Con Kolivas）只在歷史說明中提到，不實作。v2.6.23 的初版 CFS（`fair_clock` / `wait_runtime`）也只在歷史說明中提到。

## 開發順序

1. 先做 CFS 和 EEVDF（最重要、對比最精彩）
2. 每完成一個排程器，寫一篇筆記到 `notes/`（讀原始碼時卡住的地方），之後可轉成工具內的解說
3. 最後補 O(1)，然後 O(n)。O(1) 的互動性啟發式最難做準，簡化之處要在介面上標示

## 設計原則

- 單核。不做多核 load balancing、cgroup 群組排程，避免範圍膨脹。
- 模擬器的函式名稱與結構對齊 kernel（例如也叫 `update_curr`、`place_entity`），讓模擬步驟和原始碼一對一對照。
- 參數和公式對照當年的原始碼（例如 nice 0 權重 1024、每差一級約 1.25 倍）。
- 畫面分兩邊：左邊是可逐步執行的模擬時間軸，右邊是當年原始碼，高亮目前執行的函式。

## 原始碼對照

- 用腳本從指定版本抽出片段與行號，不手動複製。
- 2.6.12 之後用 git tag 鎖定版本；2.4 / 2.6.0 比 git 歷史還早，要從 kernel.org 舊版 tarball 或 full-history repo 取得。
- 每個片段附 Bootlin Elixir 連結（`elixir.bootlin.com/linux/<版本>/source/...`）；最舊的版本 Elixir 不一定有，要確認。
- 對照資料用一份 JSON 對應「模擬步驟 → 版本 / 檔案 / 函式 / 行號 / 說明」。
- 授權：專案內含 kernel 程式碼片段，因此整個專案用 GPL-2.0。

## 數學說明：理論與實作的差異

重點是說明**理論模型（論文）和 kernel 實作的落差**，以及 kernel 為什麼這樣取捨，不只是列公式。

- 做法：每個排程器對照**它自己的理想參考**，同一組工作負載並排跑，把落差畫出來（V 的軌跡、各 task 的 lag、搶占時間點）：
  - CFS v2.6.24 → GPS 流體模型（每個 task 依權重同時獲得服務）。
  - EEVDF v6.6 / v6.12 → 兩層：GPS 流體模型定義 lag（S − s_i），論文的離散 EEVDF（精確的 V、任意時間點可搶占、request 大小 r_i）定義「理想演算法」。kernel 對論文演算法的差異是重點；論文演算法對流體模型的差異就是論文證明的 lag 上下界。v6.12 的 custom slice 對應論文中不同大小的 request。
  - O(1) / O(n) → 沒有比例分享的理論模型，本質是優先權 + 時間片的啟發式。仍可拿 GPS（nice 換算 CFS 權重）對照「離比例分享多遠」，但介面上要標明這不是它們的設計目標。
- 演進故事線：v2.6.23 用 `wait_runtime` 直接記錄「應得 − 實得」（也就是 lag，並截斷在 ±limit）；v2.6.24 改成 `vruntime`，lag 不再明確存在；v6.6 EEVDF 又把 lag（`vlag`）正式帶回來，同樣有截斷。v2.6.23 只在歷史說明中提，不實作。
- 每一項差異標出處：kernel 註解（抽取腳本，附行號）或論文（書目 + 章節，推導用自己的話重寫）。引用哪些論文由作者決定。
- 已知的差異（EEVDF v6.6）：V 用加權平均近似，只有在 lag = 0 時加入／離開才等於理想值（`avg_vruntime` 註解的 NOTE）；lag 被強制截斷在 max(2×slice, TICK)，論文的上下界是推導出來的；加入時要放大 lag `(W + w_i)/W`；tick 粒度讓 0.75ms slice 實際上變成 1ms；`RUN_TO_PARITY` 讓 curr 跑完 slice 才讓位；整數運算的截斷與偏左取整；fork 的半 slice 放置被覆蓋。
- 已知的差異（CFS v2.6.24）：沒有 lag 概念，`min_vruntime` 不是理想的 V；喚醒時 `vruntime -= sysctl_sched_latency` 給睡眠者補償（睡太久的則失去應得的服務）；`START_DEBIT` 讓新 task 先欠一段。

## 比較情境

1. 大量 task：O(n) 每次排程的成本線性上升
2. 互動型 + 批次型混合（編輯器 + 編譯）
3. 刻意騙過 O(1) 啟發式（短暫 sleep 假裝互動型）
4. 低延遲需求（短 slice）：CFS 無法表達，EEVDF 可以
5. 不同 nice 值的 CPU 分配比例與理論值比較

指標：CPU 分配比例、等待時間、喚醒延遲（含 p99）、context switch 次數、每次排程決策的成本。

## 技術選型

- TypeScript + Canvas/SVG。之後視需要把模擬核心改成 Rust → WASM。
- 預計分三塊：模擬核心、原始碼抽取腳本、前端視覺化。

## 目前進度

- 2026-11-16：建立資料夾與本文件。下一步：抓 v2.6.23 `kernel/sched_fair.c` 與 v6.6 `kernel/sched/fair.c` 放進 `kernel-src/`，邊讀邊決定模擬器要對齊哪些函式。
- 2026-11-16：新增 `scripts/fetch-kernel-src.sh`（從 git.kernel.org 依 tag 抓檔；GitHub raw 會 429）。已抓 v2.6.23、v2.6.24、v6.6 到 `kernel-src/<tag>/`。
  - 發現：v2.6.23 是初版 CFS，用 `fair_clock` + `wait_runtime` + `sleeper_bonus`，**沒有 `vruntime` 與 `place_entity()`**。`vruntime` / `min_vruntime` / `place_entity()` / `sched_slice()` 從 v2.6.24 開始。已決定 CFS 對齊 v2.6.24。
  - 寫完 `notes/01-cfs-eevdf-alignment.md`：兩版要對齊的函式、欄位、參數與行號。
  - 發現：v6.6 沒有每個 task 的自訂 slice（一律 `sysctl_sched_base_slice`）。`custom_slice` / `PREEMPT_SHORT` 要到 v6.12，影響比較情境 4。已決定：主線 v6.6，加一個 v6.12 選項，只移植 custom slice + PREEMPT_SHORT。
- 2026-11-16：模擬核心第一版。`src/core/`（engine 對應 `kernel/sched.c` 的 schedule / try_to_wake_up / scheduler_tick、timeline、metrics、weights），`src/sched/cfs-v2.6.24.ts`。比較情境 5 的比例和理論值相差 < 0.01%。筆記見 `notes/02-cfs-v2.6.24.md`。
- 2026-11-16：EEVDF v6.6（`src/sched/eevdf-v6.6.ts`）。共通測試在 `test/common.test.ts`，兩個排程器都通過。筆記見 `notes/03-eevdf-v6.6.md`。
  - 發現：v6.6 的 `PLACE_DEADLINE_INITIAL` 實際上沒作用（fork 時的放置被 `activate_task` 覆蓋），v6.12 才修正。
  - 比較情境要用不對齊 tick 的時間，否則會出現人造的 deadline 平手。
  - 下一步：v6.12 選項（`custom_slice` + `PREEMPT_SHORT`），做比較情境 4。
- 2026-11-16：GPS 流體參考（`src/ref/gps.ts`）。`GpsShadow` 透過引擎新增的 `observers` 跟著真實排程器算 lag；`simulateGps` 是獨立的理想模擬。筆記見 `notes/04-gps-reference.md`。
  - 發現：EEVDF v6.6 的 lag 符合論文上下界，但 r 要用被 tick 放大的 1ms，不是名目 slice 0.75ms。
  - 發現：CFS v2.6.24 的喚醒補償讓互動型 task 相對 GPS 的 lag 線性累積（editor + 2 compile，1 秒 −75.6ms）；EEVDF 有界，但 editor 要等。
  - 下一步：v6.12 選項，接著論文版的離散 EEVDF 參考。

## 指令

- `npm test`：跑模擬核心測試（vitest）
- `npm run typecheck`
- `npm run fetch-kernel-src`：重抓 `kernel-src/`
