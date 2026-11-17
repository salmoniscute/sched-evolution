// 比較情境（CLAUDE.md）。時間刻意不對齊 tick，避免人造的 deadline 平手。
// story / roles / lookFor / takeaway 是給網頁顯示的說明；結論裡的數字來自 2 秒模擬，改了工作負載要重跑確認。
import { NSEC_PER_MSEC as MS, NSEC_PER_USEC as US, type TaskSpec } from './core/types.ts';

export interface Role {
  /** 這個程式在做什麼 */
  what: string;
  /** 它對排程器的需求是哪一種 */
  needs: string;
}

export interface Scenario {
  id: string;
  title: string;
  story: string;
  /** 依 tasks 順序 */
  roles: Role[];
  lookFor: string[];
  takeaway: string[];
  tasks: TaskSpec[];
}

const hog = (name: string, nice = 0): TaskSpec => ({ name, nice, pattern: [{ run: Infinity, sleep: 0 }] });

const COMPILE: Role = {
  what: '編譯程式，永遠有事做，只要 CPU 空出來就會用掉。',
  needs: '吞吐量。不在乎哪一刻輪到自己，在乎的是長期拿到的 CPU 夠不夠、有沒有被分到公平的份。',
};

export const scenarios: Scenario[] = [
  {
    id: 'latency',
    // CLAUDE.md 比較情境 4
    title: '延遲和公平：要準時的程式（短 slice）',
    story:
      '延遲和公平是兩件不同的事。公平看的是一段時間下來 CPU 分得對不對；延遲看的是程式醒來之後多快輪到它。' +
      'audio 用的 CPU 很少，但每次醒來都要馬上處理；編譯程式剛好相反，用很多 CPU，但晚一點跑沒關係。' +
      '同一個排程器要同時滿足這兩種需求，這個情境看各代怎麼做。',
    roles: [
      {
        what: '播音樂。每 5ms 醒來一次，花 0.31ms 填聲音緩衝區就去睡。只用掉約 6% 的 CPU。',
        needs:
          '延遲。醒來後如果要排隊，緩衝區來不及填，聲音就會斷。它透過 sched_attr 告訴排程器每次只需要 0.3ms 的 slice，但只有 v6.12 會讀這個設定。',
      },
      COMPILE,
      { ...COMPILE, what: '另一個編譯程式。' },
    ],
    lookFor: [
      '時間軸上 audio（藍色）那一列：深色前面有沒有淺色。淺色的長度就是它這次的喚醒延遲。',
      'cc1、cc2 拿到的 CPU 比例和 GPS 比例差多少，這是編譯程式在乎的。',
      'lag 圖的藍線開到 2 秒看：一路往下表示 audio 長期拿得比公平的份多，多出來的是從 cc1、cc2 那裡拿的。',
    ],
    takeaway: [
      'CFS v2.6.24 的延遲很好，audio 平均只等 10µs。代價是公平：audio 拿了 6.1%，公平的份是 5.5%。CFS 不知道 audio 要什麼，是靠喚醒補償剛好幫到它。',
      'EEVDF v6.6 很公平，三個程式都拿到 GPS 的份。但 audio 每次醒來平均要等 623µs，最久 960µs。v6.6 只有一種 slice（0.75ms），沒辦法分辨誰要的是延遲。',
      'EEVDF v6.12 的 audio 宣告了 0.3ms 的短 slice，平均只等 3µs。它拿到自己需要的 6.2%，比公平的份多一點，cc1、cc2 各少約 0.3 個百分點。',
      'v6.6 和 v6.12 的差別在於程式可以把需求告訴排程器。前面幾代都是排程器自己猜誰是互動型的。',
    ],
    tasks: [{ name: 'audio', nice: 0, slice: 300 * US, pattern: [{ run: 310 * US, sleep: 4730 * US }] }, hog('cc1'), hog('cc2')],
  },
  {
    id: 'interactive',
    // CLAUDE.md 比較情境 2
    title: '打字和編譯',
    story:
      '和情境 4 類似：一個要反應快的程式，加上兩個要吞吐量的程式。不同的是 editor 沒有告訴排程器自己需要什麼，排程器只能從它的行為去判斷。',
    roles: [
      {
        what: '文字編輯器。每 10ms 醒來處理一次按鍵，花 1.3ms 就去睡。',
        needs: '延遲。按鍵後畫面晚出來，使用者就會覺得卡。它沒有設定任何 slice。',
      },
      COMPILE,
      { ...COMPILE, what: '另一個編譯程式。' },
    ],
    lookFor: ['時間軸上 editor（藍色）醒來後排隊（淺色）多久。', 'lag 圖的藍線開到 2 秒看長期走向。'],
    takeaway: [
      'CFS 讓 editor 醒來馬上跑，但它拿了 12.9% 的 CPU，公平的份是 10.3%。CFS 對每個剛醒的程式都固定補償，不管它是不是真的需要。',
      'EEVDF v6.6 剛好給 10.3%，editor 平均要等 608µs。',
      'EEVDF v6.12 的結果和 v6.6 差不多（平均等 503µs），因為 editor 沒有要求短 slice。v6.12 不會自己去猜誰是互動型程式，要程式自己講。',
    ],
    tasks: [{ name: 'editor', nice: 0, pattern: [{ run: 1.3 * MS, sleep: 8.7 * MS }] }, hog('cc1'), hog('cc2')],
  },
  {
    id: 'nice',
    // CLAUDE.md 比較情境 5
    title: '不同 nice 值的分配',
    story: '三個程式要的都是吞吐量，沒有延遲的問題，只是優先權不同。這裡只看公平：CPU 有沒有照權重比例分。',
    roles: [
      { what: '一直要 CPU 的程式，nice −5（權重 3121）。', needs: '吞吐量。照權重比例，該拿 69.7%。' },
      { what: '一直要 CPU 的程式，nice 0（權重 1024）。', needs: '吞吐量。該拿 22.9%。' },
      { what: '一直要 CPU 的程式，nice 5（權重 335）。', needs: '吞吐量。該拿 7.5%。' },
    ],
    lookFor: [
      '表格的 CPU 比例和 GPS 比例：2 秒下來分得準不準。',
      'lag 曲線擺動的幅度：在很短的時間尺度上離比例分享有多遠。',
    ],
    takeaway: [
      '三個排程器 2 秒下來的比例都準，誤差在 0.2% 以內。',
      '短時間尺度就不一樣了。CFS 一次讓一個程式跑好幾 ms，lag 擺到約 ±6ms；EEVDF 切得細，lag 都在 1ms 以內。長期公平和短期公平是兩種不同的保證。',
    ],
    tasks: [hog('nice-5', -5), hog('nice0', 0), hog('nice5', 5)],
  },
];
