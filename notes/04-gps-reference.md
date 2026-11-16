# GPS 流體參考：理論與實作差異的量尺

程式：`src/ref/gps.ts`，測試：`test/gps.test.ts`。

## 模型

- 可執行的 task 同時拿到 CPU，速率 dS_i/dt = w_i / W(t)，W(t) = Σ runnable 的權重。
- 虛擬時間 dV/dt = NICE_0_LOAD / W，所以 runnable 的 task 滿足 dS_i = (w_i / 1024)·dV，和 vruntime 的換算一致。
- lag_i = S_i − s_i（應得 − 實得）。這就是 v6.6 `fair.c:589` 註解的 `lag_i = S − s_i = w_i * (V − v_i)`。
- 時間是實數（流體），不像引擎一律用整數 ns。

## 兩種用法

| | `GpsShadow` | `simulateGps` |
|---|---|---|
| 問題 | 真實排程器每一刻離 GPS 多遠？ | 同一組工作負載在理想 GPS 下會怎麼跑？ |
| runnable 集合 | 跟真實排程器的一樣（透過引擎的 `observers`） | 自己的（burst 完成時間跟著改變） |
| 產出 | 每個 task 的 lag、lagMin / lagMax、V 的軌跡 | 每個 task 的 runtime、burst 回應時間 |

`GpsShadow` 的 lag 是分段線性函數，極值只會出現在事件邊界，所以 lagMin / lagMax 是精確值，不是取樣的近似。

## 建模選擇：睡眠時 lag 凍結

task 睡著時不累積 S_i，lag 維持離開時的值，醒來時帶回來。這和 v6.6 保留 `se->vlag` 的語意相同。
論文也討論了離開時丟棄 lag 的策略，這裡沒採用。**這個選擇會影響 CFS 的數字**（見下面第 2 點）。

## 量到的差異

1. **EEVDF v6.6 的 lag 在論文的上下界內，但前提是 r 用被 tick 放大後的值。**
   論文：−r_max < lag < max(r_max, q)。名目 slice 是 0.75ms，但沒有 HRTICK 時只能在 tick（1ms）發現 slice 用完，
   實際 request 變成 1ms。nice −5/0/5 三個 hog 時，lagMin 到 −0.90ms，打破用 0.75ms 算的下界，但在 ±1ms 內。
2. **CFS v2.6.24 對互動型 task 的 lag 沒有上下界。** editor（跑 1.3ms 睡 8.7ms）+ 2 個 compile：
   GPS 下 editor 醒來只拿 1/3 的速率，1.3ms 的 burst 要 3.9ms，CPU 比例 10.4%。
   CFS 的喚醒補償（`vruntime -= sysctl_sched_latency`）讓 editor 醒來幾乎馬上上 CPU，比例 12.7%，
   每個週期多拿約 0.87ms，lag 線性累積（1 秒 −75.6ms，2 秒約加倍）。
   EEVDF 下 editor 的比例等於 GPS（10.4%），lag 在 [−0.67, 0.40]ms 內。
   代價是 editor 要等：這正是 v6.12 `custom_slice` 想解決的問題（比較情境 4）。
3. **CFS 兩個 hog：lag 在 [−5.5, 5.5]ms 內**，大約是 sched_slice（20ms / 2 = 10ms）的一半，再加上 tick 的捨入。
   EEVDF 兩個 hog 每 1ms 切換一次，lag 只有 ±0.5ms。

## 不變式（測試裡檢查）

- `GpsShadow` 的 s_i 和引擎記錄的 runtime 完全相等。
- Σ lag_i = 0（所有 task，含睡眠中的）：兩邊都是工作守恆，有 task 可執行時 CPU 不會閒著。
  只對 runnable 的 task 求和則不一定是 0，差額就是睡眠中 task 帶走的 lag。
- `simulateGps` 全是 hog 時，比例和 w_i / Σw 相差 < 1e-9。
