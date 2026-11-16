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

## 指令

- `npm test`：跑模擬核心測試（vitest）
- `npm run typecheck`
- `npm run fetch-kernel-src`：重抓 `kernel-src/`
