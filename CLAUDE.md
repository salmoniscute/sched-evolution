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
| EEVDF 選項 | v6.12 | `kernel/sched/fair.c` | 移植 `custom_slice`、`PREEMPT_SHORT`、`DELAY_DEQUEUE` + `DELAY_ZERO`（給比較情境 4；沒有 DELAY_DEQUEUE 短 slice 無效）、fork 的 `ENQUEUE_INITIAL` |
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

## 介面語言（中英並列）

- 網頁有中英兩種語言，右上角切換（網址 `?lang=en`，記在 localStorage）。切換時重新載入，模組在載入時決定語言。
- **改任何讀者看得到的文字時，中英文一起改。** 程式裡用 `tr('中文', 'English')`（`src/i18n.ts`），兩種寫在同一處；`index.html` 的固定文字把英文寫在 `data-en`、`data-en-title`、`data-en-aria`。名詞表每個條目有 `zh` / `en` 兩份。
- 大段內文（介紹頁、學習路線每一章）：每個 `<article>` 的最後一個子元素是 `<template lang="en">`，放整篇的英文版，英文模式載入時在小圖掛上去之前整篇換掉。章名與引導問題的英文寫在 `data-title-en` / `data-q-en`。改中文段落時，同一個 article 結尾的英文對應段落也要改。
- `test/i18n-html.test.ts`：每個 article 都要有英文版且沒有中文；中英兩版的 id、`data-sim` 標記、章節引用、外部連結、公式與 details／figure／table 的數量要一致；`index.html` 其他固定文字要有 `data-en`；小圖與原始碼頁（`src/ui/` 的 `start.ts`、`o1-widgets.ts` 等）的中文字串都要在 `tr()` 的第一個參數裡。英文裡的章節引用顯示為 “Chapter N”。
- 列舉用 `joinList()`（中文頓號、英文逗號），欄位間隔用 `gap`（中文全形空白、英文 ·），不要在字串裡直接寫全形標點。
- `test/i18n.test.ts` 用英文模式載入情境、開關、名詞表，並把每個情境 × 排程器 × 開關的每一個決策說明都產生一次，不能有中文，漏翻會在這裡失敗。
- 全部頁面都已翻成英文（2026-11-21）。

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
- 已知的差異（EEVDF v6.6）：V 用加權平均，相對 GPS 流體只有在 lag = 0 時加入／離開才相等（`avg_vruntime` 註解的 NOTE），相對論文則是同一個量（論文 Eq. 18、19 維持 lag 總和為 0）；lag 被強制截斷在 max(2×slice, TICK)，論文的上下界是推導出來的；加入時要放大 lag `(W + w_i)/W`（論文讓加入者自己分攤一份，kernel 刻意補回）；tick 粒度讓 0.75ms slice 實際上變成 1ms；`RUN_TO_PARITY` 讓 curr 跑完 slice 才讓位；整數運算的截斷與偏左取整；fork 的半 slice 放置被覆蓋。
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
- 2026-11-16：EEVDF v6.12 選項（`src/sched/eevdf-v6.12.ts`），比較情境 4 測試在 `test/eevdf-v6.12.test.ts`。筆記見 `notes/05-eevdf-v6.12-slice.md`。
  - 發現：只移植 `custom_slice` + `PREEMPT_SHORT` 時短 slice 無效（audio 帶負 lag 醒來、不 eligible）。改變範圍決定，加入 `DELAY_DEQUEUE` + `DELAY_ZERO` 後 audio 喚醒延遲從 620µs 降到 ~0。
  - 發現：以 GPS（睡眠時 lag 凍結）來看，DELAY_DEQUEUE 等於原諒睡眠期間的負 lag，audio 拿到 6.15%（GPS 5.49%）。
  - 下一步：前端（目前還沒有網頁）。
- 2026-11-16：最小前端（`index.html`、`src/ui/`）。三個排程器並排：時間軸、相對 GPS 的 lag 曲線（游標同步顯示數值）、指標表；情境定義在 `src/scenarios.ts`，時間段由 `src/ref/recorder.ts` 記錄。
  - 網頁分三頁（hash 路由）：模擬（控制列固定在頂端，圖在前、結果比較圖在後）、概念（lag 與 GPS 的推導）、原始碼（製作中）。情境說明預設收起來，強調不同程式要的是延遲還是吞吐量／公平。
  - 下一步：原始碼頁（抽取腳本 + 步驟→行號 JSON），可加入 v6.5 的睡眠補償與 migration 程式碼做歷史對照。

- 2026-11-16：原始碼頁第一批（`src/ui/source.ts`）：喚醒時的放置。CFS v2.6.24 與 EEVDF v6.6 逐步對照（模擬器 trace 驅動，程式碼行內顯示實際數值），v6.5 的補償與 migration 正規化只做靜態對照。抽取腳本 `scripts/extract-snippets.ts` + `src/source/manifest.ts` → `src/source/snippets.json`，測試檢查 JSON 和 `kernel-src/` 一致。新增 `kernel-src/v6.5/`。筆記見 `notes/06-source-wakeup-placement.md`。
  - 發現：CFS 下 editor 第一次長睡後就一直貼著 −20ms 的補償上限，短睡醒來也一樣。
  - Elixir 的 2.4 版本名稱沒有 v（`2.4.0`）。

- 2026-11-16：模擬頁加上決策檢視、sched_feat 開關、lag 圖共用刻度。
  - 引擎新增 `SchedEvent`（`SimObserver.onEvent`）：每次 `schedule()` 的挑選，以及「醒來但沒觸發重新排程」的喚醒，各附一份 `class->snapshot()`。`RunRecorder.events` 收集，`src/ui/inspect.ts` 轉成說明文字、數線、數值表。點時間軸看那一刻的決策，◀ ▶ 逐個決策前進。
  - 開關定義在 `src/variants.ts`（不碰 DOM，可測試）：CFS 的 `NEW_FAIR_SLEEPERS` / `WAKEUP_PREEMPT` / `START_DEBIT`，EEVDF 的 `RUN_TO_PARITY` / `PLACE_LAG`，v6.12 另有 `custom_slice` / `PREEMPT_SHORT` / `DELAY_DEQUEUE`。改過開關時表格會附上預設值的數字。
  - 修正：`schedule()` 改成在 `pick_next_task()` 之後才清 `need_resched`（和 v6.6 `__schedule()` 一致）。原本先清，EEVDF 在 dequeue 途中 `update_deadline()` 再設一次，會在同一時刻多跑一次 `schedule()`。影響：v6.12 情境 4 的 context switch 2134 → 2133。
  - 發現：情境 4 裡 `RUN_TO_PARITY` 關掉幾乎沒差（2026-11-17 更正：原因不只是負 lag。關掉後 audio 搶不到的理由大多變成「cc 的 deadline 比較早」，v6.6 的 slice 一樣長，audio 的 deadline 很少比較早）；CFS 關掉 `NEW_FAIR_SLEEPERS` 後 audio 平均等 8.3ms、只拿到 2.29%。
  - 測試 `test/events.test.ts`：事件和時間軸一致、挑選符合快照（CFS 最左邊；EEVDF eligible 中 deadline 最早）、說明不退回中性敘述。
  - 待辦：情境 2（editor）的週期剛好 10ms，喚醒會對齊 tick，違反「不對齊 tick」的原則。

- 2026-11-17：讓網頁更適合學習。
  - 新增「從這裡開始」頁（`#/start`，預設首頁）：程式的三種狀態與排程的三種時機（附圖）、延遲 vs. 公平、nice 與權重、CFS 的 vruntime 與喚醒補償、EEVDF 的 eligible / deadline（附數線例子）、演進主線、建議閱讀順序、名詞速查。
  - `src/ui/glossary.ts`：名詞表。決策說明裡的術語自動加虛線底線（`linkTerms`，每段第一次出現），表頭手動標（`term`），滑鼠移上去或點一下顯示定義（浮動提示框掛在 body，不會被表格捲軸裁掉）。
  - 決策檢視先給一句不用術語的白話摘要（`Explained.plain`），細節收進「排程器實際比了什麼」，展開狀態三欄同步。數線圖例改成完整說明怎麼讀。進到模擬頁會先選好第一次喚醒的決策。
  - 每個情境加「動手試」（`Scenario.exercises`）：先猜，按鈕套用開關，答案的數字現場跑模擬算，文字只寫原因。測試檢查題目的開關存在、說「完全不變」的題目真的完全不變、其他題目真的有變。
  - 概念頁加「三個程式輪流跑 1ms」的 lag 圖；原本的「怎麼看模擬頁的圖」搬到模擬頁頂端的可收合卡片。結果圖在 p99 比平均小時加註原因。

- 2026-11-17：減少文字量、改成邊做邊學。
  - 首頁改成「讀一段、動一下」：`src/ui/start.ts` 的四個小圖（拖 nice 看權重比例；CFS 的 vruntime 數線，可以讓 A 去睡再叫醒看喚醒補償；EEVDF 拖 slice 看誰被選、按鈕讓被選中的跑完 slice；演進時間軸）。小圖是玩具模型，不經過模擬核心，簡化之處寫在圖下方。名詞速查收進可展開區塊。
  - 模擬頁：拿掉「怎麼看這一頁」卡片，改成 `src/ui/tour.ts` 的逐步導覽（第一次進來自動開始，localStorage 記住；控制列的「導覽」可重看）。決策檢視的細節預設收起；sched_feat 的說明改成滑鼠提示，只有關掉的開關才在下方寫出效果；「怎麼解讀」收起來，提示先做動手試。
  - 導覽列加高（64px，品牌標誌 + 副標、分頁底線），模擬頁的控制項移到第二列；高度寫進 `--topbar-h`，原始碼頁的步驟列貼在它下面。首頁和概念頁的卡片收窄到 880px。HTML 和 `source.ts` 裡中文斷行不要換行縮排，否則瀏覽器會多出空白。
  - 網頁改為五頁：介紹（`#/intro`，預設首頁：為什麼要了解 scheduler、各代為什麼一再改寫＋演進時間軸、各頁導覽卡片）、基礎觀念（`#/basics`，原「從這裡開始」，舊網址 `#/start` 導到介紹頁）、模擬、概念、原始碼。介紹頁與基礎觀念頁的文字改用 sysprog 講義的口吻（問題帶出主題、kernel 名詞保留英文、用 task 稱呼）；其餘頁面還沒改。
  - 介紹頁的學習理由：CPU scheduler 是作業系統觀念的集大成、效能分析（schedstat、perf sched、p99）、理論與工程的落差。用詞一律寫 CPU scheduler，不單寫 scheduler。延伸閱讀列 sysprog 講義系列（hackmd.io/@sysprog/linux-scheduler-0 起）、Stoica 1995 論文、LWN 925371。
  - 讀過 sysprog 講義系列：第 1 章（O(1)）沒有 `sleep_avg` / `effective_prio` / `goodness()` 的細節，之後做 O(1)、O(n) 仍要直接讀 2.6.0 / 2.4 原始碼；第 3 章分析的是 v5.16（有 GENTLE_FAIR_SLEEPERS），不是 v2.6.24；第 5 章（EEVDF）和本專案的 v6.6 / v6.12 實作一致，另有論文兩個 client 的逐步例子（w=2,2；r=2,1），可做成概念頁的互動圖。

## 指令

- `npm run dev`：開網頁（Vite，http://localhost:5173）
- `npm test`：跑模擬核心測試（vitest）
- `npm run typecheck`
- `npm run fetch-kernel-src`：重抓 `kernel-src/`
- `npm run extract-snippets`：依 `src/source/manifest.ts` 重新產生 `src/source/snippets.json`

- 2026-11-17：解說改成「一句直覺 → 公式（KaTeX，`src/ui/math.ts`）→ 符號說明 → 代入數字」。
  - 行內程式碼依種類上色，沒包 `<code>` 的 kernel 名稱自動包起來（`src/ui/code-chips.ts`）。
  - 基礎觀念頁新增：GPS 與 lag 一節、vruntime 相等 ⇒ 時間比等於權重比的推導、starvation（含 aging 與 O(1) 的 `EXPIRED_STARVING()`，已對照 v2.6.12）、preemptive 與 non-preemptive（`WAKEUP_PREEMPT`、`RUN_TO_PARITY`）、延遲與吞吐量的取捨。情境 4 加一題 `WAKEUP_PREEMPT` 的動手試。
  - 發現：情境 4 關掉 `WAKEUP_PREEMPT`，audio 平均喚醒延遲 10µs → 1.96ms，context switch 786 → 568。`RUN_TO_PARITY` 只在醒來的 task deadline 比 curr 早時才有作用，slice 相同時很少發生。
  - 待辦：模擬器不計 context switch 成本。

- 2026-11-17：整理網頁結構，減少一頁到底的長文。
  - 導覽列改成四頁：介紹、學習路線（`#/learn/<章>`）、模擬、原始碼。原「基礎觀念」和「概念：lag 與 GPS」合併成學習路線的 8 章（problem、weight、lag、cfs、why、eevdf、preempt、tradeoff）＋附錄名詞速查（`#/learn/glossary`，`article.appendix`，不編號、不在上下章串列裡），一次只顯示一章，左側章節目錄（手機上是橫向圓點列），底下上一章／下一章。章節標題與引導問題寫在 `index.html` 的 `data-title` / `data-q`，目錄與章首由 `src/ui/learn.ts` 產生。舊網址 `#/basics`、`#/concepts`、`#/start` 會導到新位置。
  - 兩頁重複的 GPS／lag 內容合併到第 3 章；推導、歷史、細節數字收進 `details.deep`（「深入：…」），主線只留直覺、公式、小圖和動手試。
  - 介紹頁「為什麼要了解 CPU scheduler」的四大段改成四張卡片，點一張才顯示那一段；延伸閱讀收起來。
  - 新增第 5 章「為什麼離開 CFS」：只有權重一個參數、延遲靠 heuristics（v6.5 → v6.6 移除 `GENTLE_FAIR_SLEEPERS`、`START_DEBIT`、`LAST_BUDDY`、`sysctl_sched_latency` / `min_granularity` / `wakeup_granularity`，已對照 `kernel-src/`）、latency-nice 與 dual tree、`PLACE_BONUS` 的 67/33 vs 50/50、各方 benchmark、介面從 latency-nice 改成 slice。引文出自 LKML（Zijlstra 的 v1–v3 cover letter、Hegde 的測試回覆）與 commit 147f3efaa241、5e963f2bd465，出處列在章末。git.kernel.org 對自動抓取回 403，commit 用 GitHub 鏡像讀；「Remove START_DEBIT」commit 的內文沒讀到。

- 2026-11-18：原始碼頁減量。
  - 每一步的說明改成「一句直覺 → 公式（KaTeX）→ 符號 → 代入數字」，文字只寫相對 `min_vruntime` / V 的量，絕對值只留在程式碼行下的註記。名詞提示接上（`linkTermsIn()`，名詞表新增 `vlag`、`sched_latency`）。
  - v6.5 與 migration 只留結論和關鍵程式碼；SCHED_IDLE、`entity_is_long_sleeper()`、遠端喚醒的兩條路與 lock 細節已在 `notes/06`，網頁不放。頁尾拿掉「讀原始碼時的細節在 notes/」。
  - 介紹頁拿掉「雲端資源的底層」卡片（KVM、steal time、Kubernetes）：本站沒有多核與 cgroup，讀者無法驗證。之後若做到 cgroup 再考慮。

- 2026-11-18：拿掉模擬頁的「動手試」卡片（使用者不喜歡先猜再看答案）。改成 `Scenario.featNotes`：關掉某個 sched_feat 時，開關列下方顯示這個情境專屬的原因（一兩句，不寫數字），再加一行現算的前後數字（喚醒延遲、CPU 比例、context switch）；沒有專屬說明的開關用 `Feature.off`。情境 5 的觀察題改成 `Scenario.zoom` 提示列。測試 `test/events.test.ts` 檢查說明的開關存在、寫「完全不變」的真的不變、其他的真的有變。

- 2026-11-18：O(n) 2.4.0 與 O(1) 2.6.0。
  - 原始碼：`kernel-src/v2.4.0/`、`kernel-src/v2.6.0/`（kernel.org tarball，`fetch-kernel-src.sh` 只解出 `kernel/sched.c`、`fork.c`、`timer.c`、`include/linux/sched.h`）。HZ 照 i386 預設：2.4 是 100，2.6.0 是 1000；`SchedVariant.hz` 傳給引擎。
  - `src/sched/on-v2.4.0.ts`（`goodness()`、`for_each_task` 重算、`reschedule_idle()` 的 +2 門檻、idle 借 mm）、`src/sched/o1-v2.6.0.ts`（prio_array + bitmap、`recalc_task_prio()`、`TASK_INTERACTIVE`、`EXPIRED_STARVING`、`TIMESLICE_GRANULARITY`、i386 32 位元溢位）。筆記 `notes/07-o1-v2.6.0.md`、`notes/08-on-v2.4.0.md`，測試 `test/o1-v2.6.0.test.ts`、`test/on-v2.4.0.test.ts`，共通測試的 legacy 部分在 `test/common.test.ts`。
  - 2.6.0 沒有 sched_feat。開關是模擬器加的（`Feature.sim`，提示裡註明）：O(1) 的 `sleep_avg` / `TASK_INTERACTIVE` / `EXPIRED_STARVING` / `TIMESLICE_GRANULARITY`，O(n) 的 `for_each_task`。
  - 簡化：fork 沒有真的 parent，假設是 sleep_avg 滿、時間片滿的 shell（O(1) 新 task bonus +4、時間片 51 tick；O(n) counter 是 NICE_TO_TICKS 的一半）。前一秒的數字會受影響，已寫在面板說明。
  - 模擬頁加「比較」勾選（`comparePicker()`）：每個情境有建議組合 `Scenario.compare`，使用者改過的存在 localStorage，至少留一個；結論改成 `Takeaway { variant, text }`，只列出有在比較的。決策檢視：O(1) 畫 prio_array 的格子（active / expired × prio），O(n) 畫 goodness 長條（串列順序），在 `src/ui/inspect-legacy.ts`。
  - 新增比較情境 3（`cheat`：跑 2.3ms 睡 0.83ms）：O(1) 給它 67%（GPS 29.8%），關掉 `TASK_INTERACTIVE` 回到 33.7%；O(n) 只給 12%；CFS 32.7%。
  - 發現：O(1) 關掉 `sleep_avg` 後，會睡覺的 task 幾乎拿不到 CPU（情境 4 audio 0.17%、平均等 189ms），active 一空就和 expired 交換，醒來排在拿了新時間片的 hog 後面。`EXPIRED_STARVING` 的門檻是 1.02s × nr_running，四個情境都用不到。
  - 發現：2.4 的 tick dodging（每 10ms 跑 9.4ms、tick 前睡著）拿到 86.5%，對齊 tick，只放在測試，沒做成情境。
  - 待辦：原始碼頁還沒有 O(1)、O(n) 的片段；學習路線還沒有 O(n)、O(1) 的章節。（比較情境 1 已在 2026-11-21 完成）

- 2026-11-18：模擬頁的名詞改成白話帶出。O(1) 的 active / expired 一律寫成「這一輪／下一輪」（決策摘要、開關提示、排程器說明、情境文字）；CFS 的 vslice、curr、`sched_attr.sched_runtime` 等也改寫。排程器說明、開關說明、情境卡片、結論、zoom 提示、決策摘要都套上 `linkTermsIn` / `linkTerms`。名詞表新增 `EXPIRED_STARVING`、`TIMESLICE_GRANULARITY`、HZ 與 jiffies、fork。
  - 待辦：第 5 章寫了「本站的筆記發現」，和「網頁不提 repo 內部」的原則不一致。

- 2026-11-19：學習路線加入 O(1) 兩章，插在 GPS／lag 之後（共 10 章）：第 4 章「O(1)：優先權加時間片」（2.4 goodness 的 O(n)、bitmap 挑選、`static_prio` 與時間片、active / expired、sleep_avg 與 bonus、`TASK_INTERACTIVE`，深入區塊放 2.4 counter 的不動點 2T 和 `EXPIRED_STARVING`），第 5 章「為什麼離開 O(1)」（sleep_avg 的加扣、被騙的門檻、情境 3 的數字、補丁規則表、nice 的意義不一致、2007 年 RSDL/SD 與 CFS 公告）。
  - 小圖在 `src/ui/o1-widgets.ts`：兩個 prio_array（可讓 C 變 interactive，看 A、B 等到 `EXPIRED_STARVING`）、sleep_avg 隨「跑 r 睡 s」的變化（照 2.6.0 的整數運算，從 0 開始跑 3 秒）。
  - 推導：sleep_avg 停在 b* = 10 − r/s，但 `CURRENT_BONUS` 是整數，會在 ⌈b*⌉ 那一級的下緣擺動，睡醒時是 ⌈b*⌉、跑完時是 ⌊b*⌋。時間片多半在跑的時候用完，所以「留在這一輪」要 ⌊b*⌋ ≥ 7，即 r ≤ 3s（用掉 75% 的 CPU 也算）；睡醒時算 interactive 只要 r < 4s（80%）。
  - nice 差一級的效果：O(1) 時間片線性，nice 0 vs 1 是 102:97，nice 18 vs 19 是 14:10；CFS 每級都約 1.25 倍。
  - 內文的章節引用改寫成 `<a class="chref" data-ref="章節 id">`，章號由 `learn.ts` 填，之後插章不用手動改號。`#/sim/<情境 id>` 可以直接開某個情境。
  - CFS 公告原文從 LWN 的存檔讀（lwn.net/Articles/230501），lkml.org 對自動抓取擋掉。沒有 “80% of CFS's design” 那句，別引用。
  - 待辦：O(n) 只在第 4 章帶過，沒有獨立章節；原始碼頁還沒有 O(1)、O(n) 的片段。

- 2026-11-19：英文介面第一階段。新增 `src/i18n.ts`（`tr()`、`joinList()`、`gap`、`setLang()`），模擬頁、名詞表、導覽列與頁尾改成中英並列，`test/i18n.test.ts` 檢查英文模式下沒有中文。做法與規則寫在「介面語言」一節。
  - 名詞表的 `term(label, key)` 仍用中文的鍵查（`keys` 欄位），自動標註只比對目前語言的寫法。
  - 待辦：學習路線 10 章（含小圖 `start.ts`、`o1-widgets.ts`）、介紹頁、原始碼頁（`source.ts`）的英文。

- 2026-11-19：學習路線補 EEVDF 的空缺（共 11 章）。
  - 第 8 章 EEVDF：lag → V 的換算移進主線（s_i、S_i 都換成 vruntime 單位，再由 lag 總和為 0 解出加權平均）；新增 `update_deadline()`、`place_entity()`（`vlag` 截斷在 max(2×slice, TICK)、加入時放大 (W + w_i)/W，附數字例子）兩節；論文的 lag 上下界從第 3 章移到這裡的深入區塊。第 3 章的深入不再提還沒教的 `sched_slice()`、`check_preempt_tick()`。
  - 新增第 10 章「v6.12：讓 task 說出自己的 slice」（`data-ch="slice"`）：custom slice、`PREEMPT_SHORT`（`do_preempt_short()` 的條件）、`DELAY_DEQUEUE` + `DELAY_ZERO`，以及「睡著時還債」等於原諒負 lag 的代價。小圖 `src/ui/eevdf-widgets.ts`（`#w-v612`）：三個開關，玩具模型畫 audio 一個週期的 lag，下方數字用模擬核心現場跑情境 4。
  - 情境 4 量到：custom slice、`PREEMPT_SHORT`、`DELAY_DEQUEUE` 缺任何一樣，audio 平均都等 620µs（= 0.21ms 負 lag ÷ 1/3）；三樣都有是 3µs。
  - 學習路線仍只有中文。`#page-concepts` 是舊頁殘留的 HTML，路由已導走，可以刪。
  - 待辦：`sched_slice()` 公式沒寫進 CFS 章；第 5 章的 ⌈b*⌉／⌊b*⌋ 可移進深入。（總結章與 sched_ext 已在 2026-11-21 完成）

- 2026-11-21：說明文字裡的模擬數字改由測試核對。寫成 `<span data-sim="情境 排程器 [±開關] [@時間] 指標">數字</span>`（`scenarios.ts` 用 `simIn()`，`src/sim-tag.ts`），`test/sim-claims.test.ts` 照標記重跑模擬，以字面的單位與小數位數比對（`src/sim-claims.ts`）。`index.html` 51 處、`scenarios.ts` 中英各 29 處，現有數字全部正確。
  - 規則：學習路線或情境結論引用模擬跑出來的數字時一定要加標記；公式推導、玩具例子、外部 benchmark 的數字不加。
  - 沒標的：比例式（45 : 33 : 21）、「約」開頭的概數、上下界（< 0.01%、±1ms）。

- 2026-11-21：比較情境 1（大量 task）與決策成本。
  - 成本改用 `charge(rq, kind, n)` 記（`pick` / `queue` / `recalc`），引擎另外記 `schedule()` 裡面花的部分。`opsPerSchedule` 改成只算 `schedule()` 本身：原本是總成本 ÷ `schedule()` 次數，CFS v2.6.24 的 `update_curr()` 每個 tick 都查一次 leftmost（為了 `min_vruntime`），task 少時被灌成每次 2000。總成本另有 `opsPerSec`。`RUN_TO_PARITY` 直接回傳 curr 的路徑補記 1。
  - N 個 nice 0 hog、2 秒：2.4 每次挑選 ≈ n + 1（prev 先算一次，prev 也在 runqueue 上），重算後再掃一輪，攤提多約 1；2.6.0 恆為 1（時間片用完的搬移在 `scheduler_tick()`）；CFS 挑選 2、進出樹 ≈ 2 log n；EEVDF 挑選本身也隨 log n 成長。v6.12 和 v6.6 相同。
  - 情境 1 不放模擬頁（時間軸放不下），做成學習路線第 4 章的小圖（`src/cost.ts` + `src/ui/cost-widget.ts`，`#w-cost`），測試 `test/cost.test.ts`。模擬頁的指標表加上每次 `schedule()` 的平均步數與拆解。
  - 成本模型不含 cache miss 與多核 lock，網頁上已註明。

- 2026-11-21：論文版的離散 EEVDF（`src/sched/eevdf-paper.ts`，family `paper`，模擬頁可勾選「EEVDF 論文」，預設不比較）。筆記 `notes/09-eevdf-paper.md`，測試 `test/eevdf-paper.test.ts`，決策說明 `src/ui/inspect-paper.ts`。第 8 章新增深入區塊「論文的演算法和 kernel 差在哪」。
  - 論文 PDF 用 PDFKit（Swift）抽文字；公式的正負號抽不出來，關鍵頁轉成圖片讀。
  - 引擎新增選用的 `next_timer()` / `timer_fire()`（類似 hrtick），kernel 版本不實作。
  - 發現：論文 Eq. 18、19 維持 lag 總和為 0，所以論文的 V 恆等於加權平均，和 `avg_vruntime()` 是同一個量；「V 是近似」是相對 GPS 而言。
  - 發現：照 Eq. 19，帶著 lag ℓ 加入的 task 只帶回 ℓ·W/(W + w)；kernel 的 (W + w)/W 放大是刻意偏離論文（`place_entity()` 註解：lag would evaporate）。情境 4 audio 最久等 420µs，v6.6 平均 623µs。
  - 發現：`PLACE_LAG` 開／關 = 論文 strategy 1 / 2（`features.h` 註解）；`DELAY_DEQUEUE` 與 strategy 3 處理負 lag 的想法相同（kernel 沒有這樣註明）。
  - 論文的 eligible 是 request 的性質（ve ≤ V），request 進行中不會失去資格，行為接近開著 `RUN_TO_PARITY` 的 kernel。

- 2026-11-21：學習路線新增第 12 章「回顧：各代怎麼回答公平與延遲」（`data-ch="recap"`）：各代挑選規則各一行公式、「誰在意延遲：從猜到說」比較表（數字用 `data-sim` 標記）、理論與實作的距離、sched_ext 結尾介紹。
  - sched_ext 的內容對照 `kernel-src/v6.12/Documentation/scheduler/sched-ext.rst` 與 `kernel/sched/ext.c`（新加進 `fetch-kernel-src.sh`）：`struct sched_ext_ops` 只有 `ops.name` 必填、DSQ（local / global，`scx_bpf_dispatch_vtime()` 是優先佇列）、出錯／task 卡住／SysRq-S 退回 fair class、watchdog 預設 `SCX_WATCHDOG_MAX_TIMEOUT` = 30 × HZ、ABI 不穩定。
  - 長文字的表格用 `table.mini.eq-ex.wrap`（`eq-ex` 單獨用會靠右、不換行，會撐破卡片）。
  - zsh 的 `path` 變數綁定 `PATH`，迴圈變數不要取名 `path`。

- 2026-11-21：英文介面補完：介紹頁、學習路線 12 章與附錄、原始碼頁，以及小圖（`start.ts`、`o1-widgets.ts`、`cost-widget.ts`、`eevdf-widgets.ts`）。做法與測試見「介面語言」。「還沒翻譯」的提示已拿掉。
  - 順手修正：刪掉舊概念頁的殘留 HTML（`#page-concepts`）；介紹頁「十個短章」改成十二；第 7 章與原始碼頁不再提 `kernel-src/` 與抽取腳本；第 11 章「論文……之後會再對照原文」改成指向第 8 章的論文對照。
