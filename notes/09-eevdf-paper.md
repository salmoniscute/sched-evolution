# 論文版 EEVDF：理想演算法的參考

程式：`src/sched/eevdf-paper.ts`（family `paper`，模擬頁可勾選「EEVDF 論文」），測試：`test/eevdf-paper.test.ts`，
說明：`src/ui/inspect-paper.ts`。論文：I. Stoica, H. Abdel-Wahab, *Earliest Eligible Virtual Deadline First:
A Flexible and Accurate Mechanism for Proportional Share Resource Allocation*, TR-95-22, Old Dominion University, 1995。

## 從論文讀到的定義（附節號）

- §3：V(t) = ∫ dt / Σ_{active} w_j。request 的 ve 讓「到 e 為止應得 = 實得」（Eq. 9），vd = ve + r/w（Eq. 10）。
  連續 request：ve⁽ᵏ⁺¹⁾ = ve⁽ᵏ⁾ + u⁽ᵏ⁾/w，用滿時就是上一個 vd。
- §3：「A new quantum is allocated to the client that has the eligible request with the earliest virtual deadline.」
  request 比 q 長時 quantum 到期就換人；比 q 短時用完就換人。分配只在 quantum 開始時發生，醒來的 client 不會中途搶佔。
- §3 的例子：平手時「arbitrarily break the tie」。Figure 1 的兩次平手（t = 1、t = 5）都給了 ve 較晚的 client 2，模擬器照圖。
- §4 Eq. 18 / 19：離開 V += lag/Σ_{離開後} w，加入 V −= lag/Σ_{加入後} w（PDF 抽出的文字掉了正負號，是轉成圖片讀的）。
  Eq. 20 是改權重 = 離開再加入。
- §5：strategy 1 保留 lag、strategy 2 歸零、strategy 3 只在 lag = 0 時加入／離開（負 lag 用長度 0 的假 request 拖到 0）。
- §6 Theorem：穩定系統中 −r_max < lag < max(r_max, q)。
- 附錄 A 的 `join()`：`TotalWeight += w; VirtualTime = get_current_vt() - lag/TotalWeight; req->ve = VirtualTime;`。

## 卡住的地方

1. **加入的 client 帶回多少 lag？** Eq. 19 的分母包含加入者自己。附錄 A 的程式讓新 request 從 ve = V 開始（立刻 eligible），
   但 §4 又說 Eq. 18、19 保證 lag 總和為 0。兩者要同時成立，加入者實際的 lag 只能是 ℓ·W/(W + w)。
   模擬器照 §3 的定義讓 ve 落在這個 lag 的位置（負 lag 要等），不照附錄的 ve = V。
   kernel v6.6 `place_entity()` 的註解推導的正是同一件事（vl' = vl − w·vl/(W + w)），然後放大 (W + w)/W 抵銷，
   理由是「otherwise lag can quickly evaporate」。這是 kernel 刻意偏離論文的地方。
2. **V 是近似嗎？** Eq. 18、19 維持 Σ w_i(V − v_i) = 0，所以論文的 V 恆等於 Σ w_i v_i / W，和 kernel 的
   `avg_vruntime()` 在精確算術下相同。CLAUDE.md 說的「V 用加權平均近似」是相對 GPS 流體（V 不跳動）而言，不是相對論文。
3. **eligible 是 request 的性質。** 論文看 ve ≤ V，request 進行中 ve 不變，所以一直 eligible；kernel 看 entity 目前的
   vruntime，跑過頭就不 eligible，`RUN_TO_PARITY` 才讓它跑完。論文的行為比較接近開著 `RUN_TO_PARITY` 的 kernel。
4. **strategy 對照**：v6.12 `features.h` 寫 `PLACE_LAG`「EEVDF placement strategy #1, #2 if disabled」。
   `DELAY_DEQUEUE` 的註解沒有提 strategy 3，網頁上只說想法相同。
5. **浮點誤差**：V 與 ve 分別累加，理論上相等時可能 V 小一點點，曾經造成「沒有任何 request eligible」、CPU 空轉 65%。
   §6 Lemma 1 保證一定有 eligible request，所以加了 1e-3 虛擬 ns 的容許量，找不到時取 ve 最小的。

## 模擬器的選擇

- quantum q = 0.1ms，request r = slice（0.75ms 或 custom slice）。引擎新增 `next_timer()` / `timer_fire()`（類似 hrtick），
  quantum 到期與 request 用完都在精確的時刻發生，不受 tick 影響。
- 浮點數，不截斷 lag。成本模型：挑選記 log₂(n+1)（論文附錄 B 的 augmented tree），加入／離開各記 1。

## 量到的結果

- Figure 1 完全重現：每個 request 的 (ve, vd) 與 7 個 quantum 的分配順序。
- 四個情境 2 秒內 |Σ lag| < 1ns。Theorem 的上下界在 nice −5/0/5 與 r 不同（0.3、2、0.75ms）時都成立。
- 情境 4：audio 帶著約 −0.21ms 去睡，論文帶回 2/3，最久等 420µs（= 0.14 ÷ 1/3）；kernel v6.6 平均 623µs。
- 情境 5（沒有加入離開）：nice 5 相對 GPS 的 lag，v6.6 在 −0.92 到 0.49ms，論文在 −0.18 到 0.39ms。
  v6.6 的下界超過 slice，因為 tick 把 request 放大成 1ms。
- 情境 4 的論文版 audio 只拿 5.44%（GPS 5.49%）：audio 每次跑 0.31ms，request 只有 0.3ms，論文精確地在 0.3ms 結束
  request，剩下 10µs 要等新 request eligible，週期拉長。kernel 沒有 HRTICK，0.3ms 的 slice 在 1ms 的 tick 才被發現，
  audio 一口氣跑完 0.31ms。這不是論文對 kernel 的乾淨比較，網頁上沒有拿這個比例做結論。
