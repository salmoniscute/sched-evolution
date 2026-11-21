// 標記說明文字裡的模擬數字，讓 test/sim-claims.test.ts 能重跑模擬核對（寫法見 src/sim-claims.ts）。
// 獨立成一個檔案：scenarios.ts 要用它，而 sim-claims.ts 又要 import scenarios.ts。

/** 每個情境先綁定自己的 id：const n = simIn('latency')；再寫 n('cfs-v2.6.24 audio.lat', '10µs') */
export const simIn =
  (scenario: string) =>
  (spec: string, text: string): string =>
    `<span data-sim="${scenario} ${spec}">${text}</span>`;
