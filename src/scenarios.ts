// 比較情境（CLAUDE.md）。時間刻意不對齊 tick，避免人造的 deadline 平手。
// story / roles / lookFor / takeaway 是給網頁顯示的說明；結論裡的數字來自 2 秒模擬，改了工作負載要重跑確認。
import { NSEC_PER_MSEC as MS, NSEC_PER_USEC as US, type TaskSpec } from './core/types.ts';

export interface Role {
  /** 這個程式在做什麼 */
  what: string;
  /** 它對排程器的需求是哪一種 */
  needs: string;
}

/**
 * 這個情境裡關掉某個開關會怎樣。關掉時顯示在開關列下方，取代 Feature.off 的一般說明。
 * 數字在網頁上現算（預設值 vs. 關掉之後），所以 note 只寫原因，不寫數字。
 * note 裡寫「完全不變」的，測試會檢查關掉之後每個數字真的都一樣。
 */
export interface FeatNote {
  /** variants.ts 的 id */
  variant: string;
  key: string;
  /** 要列出前後數字的程式（tasks 的索引） */
  task: number;
  note: string;
}

/** 換個時間尺度看：按鈕把時間軸寬度設成 width、lag 圖共用刻度 */
export interface ZoomHint {
  width: number;
  text: string;
}

/** 只在比較某個排程器時才顯示的結論 */
export interface Takeaway {
  variant: string;
  text: string;
}

export interface Scenario {
  id: string;
  title: string;
  /** 預設比較哪幾個排程器（variants.ts 的 id，依年代排） */
  compare: string[];
  story: string;
  /** 依 tasks 順序 */
  roles: Role[];
  lookFor: string[];
  takeaway: (string | Takeaway)[];
  featNotes: FeatNote[];
  zoom?: ZoomHint;
  /** 延遲圖的副標題；預設是「越短越好。這是（會睡覺的程式）在乎的」 */
  latencyNote?: string;
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
    compare: ['cfs-v2.6.24', 'eevdf-v6.6', 'eevdf-v6.12-slice'],
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
      {
        variant: 'o1-v2.6.0',
        text: 'O(1) 2.6.0 從 sleep_avg 猜出 audio 是互動型，醒來大多立刻打斷 cc（平均 124µs），拿 6.0%。最久的一次等了 35ms，發生在剛開始不久：cc 剛 fork 出來時繼承了 shell 的 sleep_avg，優先權和 audio 差不多。',
      },
    ],
    featNotes: [
      {
        variant: 'cfs-v2.6.24',
        key: 'NEW_FAIR_SLEEPERS',
        task: 0,
        note: '沒有補償，醒來的 audio 和 cc 站在同一個起跑點，vruntime 沒有小超過 10ms 就搶不了，只能等 cc 在 tick 時用完 sched_slice。等太久讓 audio 的週期變長，CPU 比例反而掉到公平的份以下。',
      },
      {
        variant: 'cfs-v2.6.24',
        key: 'WAKEUP_PREEMPT',
        task: 0,
        note: 'CFS 沒有變成 non-preemptive：tick 時照樣會把用完 sched_slice 的 curr 換下，少的只是醒來那一刻的插隊。audio 等得久，cc 被打斷得少，context switch 跟著變少，這就是拿延遲換吞吐量。',
      },
      {
        variant: 'eevdf-v6.6',
        key: 'RUN_TO_PARITY',
        task: 0,
        note: '幾乎沒差。v6.6 每個程式的 slice 一樣長，audio 醒來時的 deadline 很少比 cc 早，就算每次重新比也是 cc 先。要讓 audio 先跑，得給它更短的 slice，也就是 v6.12 的做法。',
      },
      {
        variant: 'eevdf-v6.6',
        key: 'PLACE_LAG',
        task: 0,
        note: '反而變差。lag = 0 的 audio 雖然 eligible，deadline 卻比正在跑的 cc 晚，每次都要等；等待期間被欠的 lag 本來會存起來下次補，關掉之後睡一覺就歸零，所以 lag 圖的線一路往上。',
      },
      {
        variant: 'eevdf-v6.12-slice',
        key: 'DELAY_DEQUEUE',
        task: 0,
        note: '短 slice 沒用了。audio 跑完去睡時 vruntime 已經超過 V，帶著負的 lag 醒來就不 eligible，deadline 再早也選不到。DELAY_DEQUEUE 讓它睡著後先留在佇列上，把負的 lag 還完才離開。',
      },
    ],
    tasks: [{ name: 'audio', nice: 0, slice: 300 * US, pattern: [{ run: 310 * US, sleep: 4730 * US }] }, hog('cc1'), hog('cc2')],
  },
  {
    id: 'interactive',
    // CLAUDE.md 比較情境 2
    title: '打字和編譯',
    compare: ['o1-v2.6.0', 'cfs-v2.6.24', 'eevdf-v6.6'],
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
      {
        variant: 'o1-v2.6.0',
        text: 'O(1) 2.6.0 從 sleep_avg 猜出 editor 是互動型（bonus +5，prio 115），醒來大多立刻打斷 cc，平均只等 205µs，拿 12.7% 的 CPU。最久的兩次等待（9ms、31ms）都在前 50ms：cc 剛從 shell fork 出來，繼承了 shell 的 sleep_avg，優先權和 editor 差不多，editor 搶不贏。',
      },
      {
        variant: 'on-v2.4.0',
        text: 'O(n) 2.4 的 editor 平均等 546µs，p99 卻是 50ms。這兩次長等待都在剛開始：editor 的 counter 只比 cc 多 1，goodness 沒有高出 2，搶不了，只能等 cc 用完剩下的時間片。之後 editor 每次睡著遇到重算，沒用完的 counter 都保留一半，醒來就能插隊。',
      },
    ],
    featNotes: [
      {
        variant: 'cfs-v2.6.24',
        key: 'NEW_FAIR_SLEEPERS',
        task: 0,
        note: 'editor 沒有剛好拿到公平的份，反而掉到以下：醒來要等 cc 用完 sched_slice，週期變長，一秒內處理的按鍵變少。CFS 在這裡只有「補 20ms」和「完全不補」兩種選擇。',
      },
      {
        variant: 'o1-v2.6.0',
        key: 'sleep_avg',
        task: 0,
        note: '少了 bonus，editor 和 cc 同優先權，醒來不能插隊，只能排在 cc 後面等一整個時間片（約 100ms）。2.6.0 照顧互動型程式的手段只有 sleep_avg 這一個，拿掉之後比 2.4 還糟。',
      },
      {
        variant: 'on-v2.4.0',
        key: 'for_each_task',
        task: 0,
        note: 'editor 睡著時錯過的重算不再補給它，counter 用完之後要等下一次重算，而重算只在 runqueue 上的 task 全部用完時才發生。2.4 的互動性，全靠「睡著的 task 也一起重算」這一行。',
      },
      {
        variant: 'eevdf-v6.12-slice',
        key: 'custom_slice',
        task: 0,
        note: '完全不變：editor 沒有設定 slice，這個開關對它沒有作用。',
      },
      {
        variant: 'eevdf-v6.12-slice',
        key: 'DELAY_DEQUEUE',
        task: 0,
        note: '數字變得和 v6.6 一樣：v6.12 的 editor 少等的那段全部來自 DELAY_DEQUEUE。睡前的負 lag 在睡著時就還掉，醒來比較常是 eligible；代價是預設值下 lag 圖往下走，editor 拿得比公平的份多一點。',
      },
    ],
    tasks: [{ name: 'editor', nice: 0, pattern: [{ run: 1.3 * MS, sleep: 8.7 * MS }] }, hog('cc1'), hog('cc2')],
  },
  {
    id: 'cheat',
    // CLAUDE.md 比較情境 3
    title: '假裝互動：騙過 O(1) 的 heuristics',
    compare: ['on-v2.4.0', 'o1-v2.6.0', 'cfs-v2.6.24'],
    story:
      'O(1) 不知道哪個 task 是互動型的，只能從行為猜：睡得多的就當成互動型，提高優先權，時間片用完還不用等下一輪（留在 active）。' +
      'cheat 其實和 cc 一樣是一直有事做的程式，只是每跑 2.3ms 就故意睡 0.83ms。這一點點睡眠，夠不夠讓 CPU scheduler 把它當成編輯器？',
    roles: [
      {
        what: '一直有事做的程式，但每跑 2.3ms 就主動睡 0.83ms（例如呼叫 usleep）。不睡的話它和 cc 沒有兩樣。',
        needs: '吞吐量。它睡覺不是因為在等什麼，而是想多搶一點 CPU。',
      },
      COMPILE,
      { ...COMPILE, what: '另一個編譯程式。' },
    ],
    lookFor: [
      '表格的 CPU 比例：cheat 在各個排程器拿到多少，和 GPS 比例差多少。',
      '點 O(1) 時間軸上 cheat 醒來的那一刻，看它的優先權和 bonus，為什麼它一醒來就能打斷 cc。',
      'lag 圖開到 2 秒：cheat 的線往下走得多快。',
    ],
    latencyNote: 'cheat 其實不在乎延遲，這裡看的是它醒來後能不能馬上插隊：能插隊，就表示 CPU scheduler 把它當成需要快速回應的程式。',
    takeaway: [
      {
        variant: 'o1-v2.6.0',
        text: 'O(1) 把 cheat 當成互動型。cheat 每睡 0.83ms，sleep_avg 就加上這段睡眠的好幾倍（recalc_task_prio() 乘上 10 − 目前的 bonus，bonus 越低乘得越多）；跑的 2.3ms 則照實扣掉。兩邊在 bonus +2、+3（prio 117–118）附近打平，剛好過了 nice 0 互動型的門檻（bonus ≥ +2）。於是它醒來就能打斷 cc，時間片用完又不用等下一輪，2 秒下來拿走 67% 的 CPU，公平的份只有 29.8%。',
      },
      {
        variant: 'o1-v2.6.0',
        text: 'cc 沒有被完全餓死，只是因為 cheat 每 3ms 自己會睡將近 1ms，CPU 才空給 cc。換個角度看：O(1) 被騙的根源，是用「睡了多少」去猜「需不需要快速回應」。',
      },
      {
        variant: 'on-v2.4.0',
        text: 'O(n) 2.4 反而虧待 cheat，只給它 12%。cheat 醒來時 counter 比 cc 多（睡著時遇到重算，沒用完的保留一半），確實能插隊；但它每跑 2.3ms 就會碰到 tick 扣 counter，幾輪就扣完了。counter 是 0 的 task goodness 也是 0，要等兩個 cc 也把各自 60ms 的時間片用完、一起重算，才能再跑。',
      },
      {
        variant: 'cfs-v2.6.24',
        text: 'CFS 只看 vruntime，睡過不會換來額外的 CPU：cheat 拿 32.7%，和三等分差不多。比 GPS 的份（29.8%）多一點，是因為喚醒補償讓它睡醒時保留了落後 min_vruntime 的那一小段。',
      },
      { variant: 'eevdf-v6.6', text: 'EEVDF v6.6 也不會被騙，cheat 拿 29.8%，和 GPS 的份相同。' },
    ],
    featNotes: [
      {
        variant: 'o1-v2.6.0',
        key: 'TASK_INTERACTIVE',
        task: 0,
        note: 'cheat 醒來照樣能靠 bonus 打斷 cc，但時間片用完就得排到下一輪（expired），要等 cc 也把時間片用完才輪得到，CPU 比例回到三分之一左右。互動型「用完時間片不必等下一輪」的特權，就是被騙走的那一塊。',
      },
      {
        variant: 'o1-v2.6.0',
        key: 'sleep_avg',
        task: 0,
        note: '不會被騙了，但矯枉過正：cheat 沒有 bonus，和 cc 同優先權，醒來不能插隊，只能排在 cc 後面等一整個時間片（約 100ms）；每次只跑 2.3ms 就去睡，醒來又得重新排隊。真正的互動型程式也會一起失去照顧，可以到「打字和編譯」關掉同一個開關看 editor。',
      },
      {
        variant: 'o1-v2.6.0',
        key: 'EXPIRED_STARVING',
        task: 1,
        note: '完全不變。排到下一輪的 task 要等超過約 1 秒 × task 數（STARVATION_LIMIT × nr_running，三個 task 約 3 秒），EXPIRED_STARVING 才出手，比這個模擬還長。',
      },
      {
        variant: 'on-v2.4.0',
        key: 'for_each_task',
        task: 0,
        note: 'cheat 拿得更少。它每 3ms 有將近 1ms 在睡，重算 counter 時如果剛好在睡，就分不到新的時間片，醒來 counter 是 0、goodness 也是 0，要等 cc 把時間片用完、下一次重算。',
      },
      {
        variant: 'cfs-v2.6.24',
        key: 'NEW_FAIR_SLEEPERS',
        task: 0,
        note: 'cheat 睡 0.83ms 醒來時，vruntime 落在 min_vruntime 後面一點。有喚醒補償時保留原本的 vruntime；關掉之後被拉到 min_vruntime，每次睡醒都損失這一小段，CPU 比例掉到公平的份以下。',
      },
    ],
    tasks: [{ name: 'cheat', nice: 0, pattern: [{ run: 2.3 * MS, sleep: 0.83 * MS }] }, hog('cc1'), hog('cc2')],
  },
  {
    id: 'nice',
    // CLAUDE.md 比較情境 5
    title: '不同 nice 值的分配',
    compare: ['o1-v2.6.0', 'cfs-v2.6.24', 'eevdf-v6.6'],
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
      'CFS 和 EEVDF 2 秒下來的比例都準，誤差在 0.2% 以內。',
      '短時間尺度就不一樣了。CFS 一次讓一個程式跑好幾 ms，lag 擺到約 ±6ms；EEVDF 切得細，lag 都在 1ms 以內。長期公平和短期公平是兩種不同的保證。',
      {
        variant: 'o1-v2.6.0',
        text: 'O(1) 2.6.0 不是照權重分，而是照時間片長度：nice −5、0、5 的時間片是 126ms、102ms、78ms，三個 hog 輪流各跑一整塊，比例約 41 : 33 : 25。nice 差 5 級，CPU 只差約 1.2 倍；CFS 是 3 倍。2 秒的數字是 45 : 33 : 21，因為前 1 秒還有 fork 時從 shell 繼承的 bonus。',
      },
      {
        variant: 'on-v2.4.0',
        text: 'O(n) 2.4 也是照時間片：HZ = 100 時 counter 是 7、6、4 個 tick（70、60、40ms），比例約 41 : 35 : 24。',
      },
    ],
    featNotes: [
      {
        variant: 'eevdf-v6.6',
        key: 'RUN_TO_PARITY',
        task: 0,
        note: '完全不變。這裡沒有人睡覺，也就沒有人醒來，curr 只會在 tick 時因為 slice 用完被換下，那時本來就會重新挑。',
      },
    ],
    zoom: {
      width: 50,
      text: 'CFS 和 EEVDF 2 秒下來的比例都很準。換成 50ms 看短時間：CFS 一次讓一個程式連續跑完 sched_slice（nice −5 那個約 14ms），lag 的鋸齒比 EEVDF 大得多。',
    },
    tasks: [hog('nice-5', -5), hog('nice0', 0), hog('nice5', 5)],
  },
];
