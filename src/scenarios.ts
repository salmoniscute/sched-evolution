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
 * 動手試：先猜，再照著設定看結果。答案的數字在網頁上現算（預設值 vs. 照題目改過開關），
 * 所以 answer 只寫原因，不寫數字。
 */
export interface Exercise {
  question: string;
  /** 要改的排程器（variants.ts 的 id）與要關掉的開關；沒有就只是觀察題 */
  variant?: string;
  off?: string[];
  /** 答案要列出哪個程式的數字（tasks 的索引） */
  task: number;
  /** 觀察題：建議的時間軸寬度（ms） */
  width?: number;
  answer: string;
}

export interface Scenario {
  id: string;
  title: string;
  story: string;
  /** 依 tasks 順序 */
  roles: Role[];
  lookFor: string[];
  takeaway: string[];
  exercises: Exercise[];
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
    exercises: [
      {
        question: 'CFS 的 audio 幾乎不用等。把喚醒補償 NEW_FAIR_SLEEPERS 關掉，audio 每次醒來要等多久？它拿到的 CPU 會變多還是變少？',
        variant: 'cfs-v2.6.24',
        off: ['NEW_FAIR_SLEEPERS'],
        task: 0,
        answer:
          '沒有補償，醒來的 audio 放在 min_vruntime，和 cc1、cc2 差不多。check_preempt_wakeup() 要 vruntime 小超過 10ms 才搶佔，條件不成立，' +
          'audio 只能等正在跑的 cc 在 tick 時用完 sched_slice（三個程式時約 6.7ms），而且大多數時候還要再等另一個 cc 跑一段，因為它們的 vruntime 和 audio 差不多。' +
          'audio 一個週期本來只要 5ms，現在光等就要 8ms 多，一秒能完成的週期變少，所以 CPU 比例反而掉到公平的份以下。真的在放音樂的話就是斷音。' +
          '點時間軸上 audio 的淺色段，可以看到每一次的理由。',
      },
      {
        question: 'CFS 預設允許醒來的程式插隊（WAKEUP_PREEMPT）。把它關掉，CFS 會變成 non-preemptive 嗎？audio 要等多久？2 秒內的 context switch 會變多還是變少？',
        variant: 'cfs-v2.6.24',
        off: ['WAKEUP_PREEMPT'],
        task: 0,
        answer:
          '不會變成 non-preemptive。tick 時 check_preempt_tick() 照樣會在 curr 用完 sched_slice 時把它換下，關掉的只是「醒來那一刻」的搶占。' +
          'audio 醒來後不能插隊，要等正在跑的 cc 在某個 tick 用完 slice。少了插隊，cc 被打斷的次數變少，context switch 也跟著變少：' +
          '這就是用延遲換吞吐量，audio 等得久，cc 每次跑得比較完整。audio 的週期被拉長，一秒內完成的週期變少，CPU 比例也跟著下降。',
      },
      {
        question: 'EEVDF v6.6 的 audio 平均要等 600 多 µs。關掉 RUN_TO_PARITY，讓每次有人醒來都重新比 deadline，audio 會比較快輪到嗎？',
        variant: 'eevdf-v6.6',
        off: ['RUN_TO_PARITY'],
        task: 0,
        answer:
          '幾乎沒變。用決策檢視看 audio 醒來的那幾刻：開著 RUN_TO_PARITY 時，常見的理由是「cc 要先把 slice 跑完」；關掉之後，理由變成「audio 不 eligible」或「cc 的 deadline 比較早」。' +
          'v6.6 每個程式的 slice 都是 0.75ms，audio 醒來時的 deadline 通常不會比 cc 早，就算重新比也是 cc 先。' +
          '要讓 audio 先跑，得讓它的 deadline 比別人早，也就是更短的 slice，這就是 v6.12 的做法。',
      },
      {
        question: '再看 v6.6：PLACE_LAG 讓程式睡前的 lag 醒來照樣帶回來。關掉它，醒來一律從 lag = 0 開始，聽起來對 audio 比較寬容。audio 會變好還是變差？',
        variant: 'eevdf-v6.6',
        off: ['PLACE_LAG'],
        task: 0,
        answer:
          '變差：等得更久，CPU 也拿得比公平的份少。lag = 0 雖然 eligible，但 deadline 是 V + 0.75ms，幾乎都比正在跑的 cc 晚，所以每次都要等 cc 跑完手上的 slice。' +
          '等待的時候 GPS 照樣把份額算給 audio，也就是排程器欠它；PLACE_LAG 本來會把這筆正的 lag 存起來、下次醒來還給它，關掉之後睡一覺就歸零。' +
          '開到 2 秒看 lag 圖，藍線會一路往上：audio 長期被少給。PLACE_LAG 不只是「多拿的要還」，也是「被欠的要補」。',
      },
      {
        question: 'v6.12 的 audio 宣告了 0.3ms 的 slice，幾乎不用等。如果只關掉 DELAY_DEQUEUE，短 slice 還有用嗎？',
        variant: 'eevdf-v6.12-slice',
        off: ['DELAY_DEQUEUE'],
        task: 0,
        answer:
          '沒用了，延遲回到 v6.6 的程度。audio 每次跑 0.31ms，跑的時候它的 vruntime 以 1 的速度前進，V（三個程式的加權平均）只以約 1/3 的速度前進，' +
          '所以去睡的時候 vruntime 已經跑到 V 右邊，lag 是負的。沒有 DELAY_DEQUEUE，這個負 lag 存進 vlag，醒來原樣帶回來（還放大 1.5 倍），audio 不 eligible，deadline 再早也不會被選。' +
          'DELAY_DEQUEUE 讓它睡著之後先留在佇列上，等 V 追上來、負的 lag 還完才真正離開，醒來時 lag 大約是 0。點 audio 醒來的那一刻，可以看到理由是「lag < 0，不 eligible」。',
      },
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
    exercises: [
      {
        question: 'CFS 給 editor 的 CPU 比公平的份多。關掉喚醒補償 NEW_FAIR_SLEEPERS，editor 會剛好拿到公平的份嗎？',
        variant: 'cfs-v2.6.24',
        off: ['NEW_FAIR_SLEEPERS'],
        task: 0,
        answer:
          '不會，反而掉到公平的份以下，而且每次醒來都要等好幾 ms。補償是 CFS 唯一讓睡醒的程式不吃虧的機制：拿掉之後 editor 醒來和 cc 站在同一個起跑點，' +
          '要等 cc 用完 sched_slice 才輪得到。等待讓它的週期變長，一秒內處理的按鍵變少，CPU 比例也跟著變少。' +
          'CFS 在這裡只有「補 20ms」和「完全不補」兩種，沒有剛好的設定。後來 v2.6.32 加了 GENTLE_FAIR_SLEEPERS，把補償減半。',
      },
      {
        question: 'v6.12 的 editor 比 v6.6 少等約 100µs，但 editor 沒有設定 slice。差別是哪一個開關造成的？先關 custom_slice 看看，再改關 DELAY_DEQUEUE。',
        variant: 'eevdf-v6.12-slice',
        off: ['DELAY_DEQUEUE'],
        task: 0,
        answer:
          '關 custom_slice 完全沒差，因為 editor 沒有用到它。關 DELAY_DEQUEUE 之後，數字和 v6.6 一模一樣，所以差別全部來自 DELAY_DEQUEUE：' +
          'editor 睡前的負 lag 在睡著時就還掉了，醒來時 lag 大約是 0，比較常是 eligible 的。' +
          '代價看 lag 圖：預設的 v6.12 下，editor 相對 GPS 的 lag 會往下走到約 −6ms，表示它拿得比公平的份多一點，那是睡覺時被原諒的帳。',
      },
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
    exercises: [
      {
        question: '三個排程器 2 秒下來的比例都很準。在 50ms 這種短時間裡呢？先猜哪一個的 lag 擺得最大，再看三張 lag 圖（共用刻度）。',
        task: 0,
        width: 50,
        answer:
          'CFS 的鋸齒大得多。CFS 每次讓一個程式連續跑完 sched_slice（nice −5 那個一次約 14ms），這段時間另外兩個的 lag 一直往上累積；' +
          'EEVDF 每 1ms 就重新比一次 deadline，鋸齒只有 1ms 左右高。答案的數字是每個排程器三個程式的 lag 範圍。',
      },
      {
        question: '這三個程式都不睡覺。在 EEVDF v6.6 關掉 RUN_TO_PARITY，結果會改變嗎？',
        variant: 'eevdf-v6.6',
        off: ['RUN_TO_PARITY'],
        task: 0,
        answer:
          '完全不變，每個數字都一樣。RUN_TO_PARITY 只管「有人醒來時，要不要中途重新挑」。這個情境沒有人睡覺，也就沒有人醒來，' +
          'curr 只會在 tick 時因為 slice 用完被換下，那時本來就會重新挑。開關的效果要看工作負載，同一個開關在「延遲和公平」情境也幾乎沒差，但原因不一樣。',
      },
    ],
    tasks: [hog('nice-5', -5), hog('nice0', 0), hog('nice5', 5)],
  },
];
