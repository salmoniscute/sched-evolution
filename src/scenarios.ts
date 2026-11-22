// 比較情境（CLAUDE.md）。時間刻意不對齊 tick，避免人造的 deadline 平手。
// story / roles / lookFor / takeaway 是給網頁顯示的說明；結論裡的模擬數字用 simIn() 標記，由測試核對。
import { NSEC_PER_MSEC as MS, NSEC_PER_USEC as US, type TaskSpec } from './core/types.ts';
import { tr } from './i18n.ts';
import { simIn } from './sim-tag.ts';

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

// 結論裡的模擬數字用 simIn() 標記，test/sim-claims.test.ts 會重跑模擬核對
const nLat = simIn('latency');
const nInt = simIn('interactive');
const nCheat = simIn('cheat');
const nNice = simIn('nice');

const hog = (name: string, nice = 0): TaskSpec => ({ name, nice, pattern: [{ run: Infinity, sleep: 0 }] });

const COMPILE: Role = {
  what: tr('編譯程式，永遠有事做，只要 CPU 空出來就會用掉。', 'A compiler: always has work to do and uses the CPU whenever it is free.'),
  needs: tr('吞吐量。不在乎哪一刻輪到自己，在乎的是長期拿到的 CPU 夠不夠、有沒有被分到公平的份。', 'Throughput. It does not care when exactly it gets its turn, only whether it gets enough CPU over time and receives its fair share.'),
};

export const scenarios: Scenario[] = [
  {
    id: 'latency',
    // CLAUDE.md 比較情境 4
    title: tr('延遲和公平：要準時的程式（短 slice）', 'Latency vs. fairness: a task that must be on time (short slice)'),
    compare: ['cfs-v2.6.24', 'eevdf-v6.6', 'eevdf-v6.12-slice'],
    story:
      tr('延遲和公平是兩件不同的事。公平看的是一段時間下來 CPU 分得對不對；延遲看的是程式醒來之後多快輪到它。', 'Latency and fairness are two different things. Fairness asks whether the CPU is divided correctly over a period of time; latency asks how soon a task gets to run after it wakes up. ') +
      tr('audio 用的 CPU 很少，但每次醒來都要馬上處理；編譯程式剛好相反，用很多 CPU，但晚一點跑沒關係。', 'audio uses very little CPU but must be served as soon as it wakes; the compilers are the opposite: they use a lot of CPU but do not mind running a bit later. ') +
      tr('同一個排程器要同時滿足這兩種需求，這個情境看各代怎麼做。', 'One scheduler has to satisfy both kinds of demand; this scenario shows how each generation does it.'),
    roles: [
      {
        what: tr('播音樂。每 5ms 醒來一次，花 0.31ms 填聲音緩衝區就去睡。只用掉約 6% 的 CPU。', 'Plays music. Wakes every 5ms, spends 0.31ms filling the sound buffer, then sleeps again. Uses only about 6% of the CPU.'),
        needs:
          tr('延遲。醒來後如果要排隊，緩衝區來不及填，聲音就會斷。它透過 sched_attr 告訴排程器每次只需要 0.3ms 的 slice，但只有 v6.12 會讀這個設定。', 'Latency. If it has to queue after waking, the buffer is not refilled in time and the sound breaks up. It tells the scheduler through sched_attr that it needs only a 0.3ms slice, but only v6.12 reads this setting.'),
      },
      COMPILE,
      { ...COMPILE, what: tr('另一個編譯程式。', 'Another compiler.') },
    ],
    lookFor: [
      tr('時間軸上 audio（藍色）那一列：深色前面有沒有淺色。淺色的長度就是它這次的喚醒延遲。', 'The audio (blue) row of the timeline: is there a light stretch before each dark one? The light stretch is that wakeup\'s latency.'),
      tr('cc1、cc2 拿到的 CPU 比例和 GPS 比例差多少，這是編譯程式在乎的。', 'How far the CPU share of cc1 and cc2 is from the GPS share; this is what the compilers care about.'),
      tr('lag 圖的藍線開到 2 秒看：一路往下表示 audio 長期拿得比公平的份多，多出來的是從 cc1、cc2 那裡拿的。', 'The blue line of the lag chart over 2 seconds: if it keeps going down, audio is taking more than its fair share in the long run, and the extra comes out of cc1 and cc2.'),
    ],
    takeaway: [
      tr(`CFS v2.6.24 的延遲很好，audio 平均只等 ${nLat('cfs-v2.6.24 audio.lat', '10µs')}。代價是公平：audio 拿了 ${nLat('cfs-v2.6.24 audio.share', '6.1%')}，公平的份是 ${nLat('gps audio.share', '5.5%')}。CFS 不知道 audio 要什麼，是靠喚醒補償剛好幫到它。`, `CFS v2.6.24 has excellent latency: audio waits only ${nLat('cfs-v2.6.24 audio.lat', '10µs')} on average. The price is fairness: audio takes ${nLat('cfs-v2.6.24 audio.share', '6.1%')} against a fair share of ${nLat('gps audio.share', '5.5%')}. CFS has no idea what audio needs; its sleeper credit just happens to help.`),
      tr(`EEVDF v6.6 很公平，三個程式都拿到 GPS 的份。但 audio 每次醒來平均要等 ${nLat('eevdf-v6.6 audio.lat', '623µs')}，最久 ${nLat('eevdf-v6.6 audio.max', '960µs')}。v6.6 只有一種 slice（0.75ms），沒辦法分辨誰要的是延遲。`, `EEVDF v6.6 is fair: all three tasks get their GPS share. But audio waits ${nLat('eevdf-v6.6 audio.lat', '623µs')} on average after each wakeup, ${nLat('eevdf-v6.6 audio.max', '960µs')} at worst. v6.6 has only one slice length (0.75ms) and cannot tell who needs latency.`),
      tr(`EEVDF v6.12 的 audio 宣告了 0.3ms 的短 slice，平均只等 ${nLat('eevdf-v6.12-slice audio.lat', '3µs')}。它拿到自己需要的 ${nLat('eevdf-v6.12-slice audio.share', '6.2%')}，比公平的份多一點，cc1、cc2 各少約 0.3 個百分點。`, `In EEVDF v6.12 audio declares a short 0.3ms slice and waits only ${nLat('eevdf-v6.12-slice audio.lat', '3µs')} on average. It gets the ${nLat('eevdf-v6.12-slice audio.share', '6.2%')} it needs, a little above its fair share; cc1 and cc2 each lose about 0.3 percentage points.`),
      tr('v6.6 和 v6.12 的差別在於程式可以把需求告訴排程器。前面幾代都是排程器自己猜誰是互動型的。', 'The difference between v6.6 and v6.12 is that a task can tell the scheduler what it needs. Earlier generations had to guess which tasks were interactive.'),
      {
        variant: 'o1-v2.6.0',
        text: tr(`O(1) 2.6.0 從 sleep_avg 猜出 audio 是互動型，醒來大多立刻打斷 cc（平均 ${nLat('o1-v2.6.0 audio.lat', '124µs')}），拿 ${nLat('o1-v2.6.0 audio.share', '6.0%')}。最久的一次等了 ${nLat('o1-v2.6.0 audio.max', '35ms')}，發生在剛開始不久：cc 剛 fork 出來時繼承了 shell 的 sleep_avg，優先權和 audio 差不多。`, `O(1) 2.6.0 guesses from sleep_avg that audio is interactive; on wakeup it usually interrupts cc at once (${nLat('o1-v2.6.0 audio.lat', '124µs')} on average) and takes ${nLat('o1-v2.6.0 audio.share', '6.0%')}. The longest wait, ${nLat('o1-v2.6.0 audio.max', '35ms')}, happens near the start: cc was just forked and inherited the shell's sleep_avg, so its priority was close to audio's.`),
      },
    ],
    featNotes: [
      {
        variant: 'cfs-v2.6.24',
        key: 'NEW_FAIR_SLEEPERS',
        task: 0,
        note: tr('沒有補償，醒來的 audio 和 cc 站在同一個起跑點，vruntime 沒有小超過 10ms 就搶不了，只能等 cc 在 tick 時用完 sched_slice。等太久讓 audio 的週期變長，CPU 比例反而掉到公平的份以下。', 'Without the credit, a waking audio starts level with cc; unless its vruntime is more than 10ms smaller it cannot preempt and has to wait for cc to use up its sched_slice at a tick. The long waits stretch audio\'s period, and its CPU share actually drops below its fair share.'),
      },
      {
        variant: 'cfs-v2.6.24',
        key: 'WAKEUP_PREEMPT',
        task: 0,
        note: tr('CFS 沒有變成 non-preemptive：tick 時照樣會把用完 sched_slice 的 curr 換下，少的只是醒來那一刻的插隊。audio 等得久，cc 被打斷得少，context switch 跟著變少，這就是拿延遲換吞吐量。', 'CFS does not become non-preemptive: at a tick it still switches out a curr that has used up its sched_slice; only the preemption at wakeup is gone. audio waits longer, cc is interrupted less often, and context switches drop with it. This is trading latency for throughput.'),
      },
      {
        variant: 'eevdf-v6.6',
        key: 'RUN_TO_PARITY',
        task: 0,
        note: tr('幾乎沒差。v6.6 每個程式的 slice 一樣長，audio 醒來時的 deadline 很少比 cc 早，就算每次重新比也是 cc 先。要讓 audio 先跑，得給它更短的 slice，也就是 v6.12 的做法。', 'Hardly any difference. In v6.6 every task has the same slice length, so audio\'s deadline is rarely earlier than cc\'s when it wakes, and even comparing again on every wakeup still favours cc. To let audio go first it needs a shorter slice, which is what v6.12 does.'),
      },
      {
        variant: 'eevdf-v6.6',
        key: 'PLACE_LAG',
        task: 0,
        note: tr('反而變差。lag = 0 的 audio 雖然 eligible，deadline 卻比正在跑的 cc 晚，每次都要等；等待期間被欠的 lag 本來會存起來下次補，關掉之後睡一覺就歸零，所以 lag 圖的線一路往上。', 'Worse, not better. With lag = 0 audio is eligible, but its deadline is later than the running cc\'s, so it waits every time; the lag it is owed while waiting would normally be saved for next time, but with this off it resets to zero after every sleep, so the line in the lag chart keeps climbing.'),
      },
      {
        variant: 'eevdf-v6.12-slice',
        key: 'DELAY_DEQUEUE',
        task: 0,
        note: tr('短 slice 沒用了。audio 跑完去睡時 vruntime 已經超過 V，帶著負的 lag 醒來就不 eligible，deadline 再早也選不到。DELAY_DEQUEUE 讓它睡著後先留在佇列上，把負的 lag 還完才離開。', 'The short slice stops working. When audio goes to sleep its vruntime is already past V, so it wakes with negative lag and is not eligible, however early its deadline. DELAY_DEQUEUE keeps it on the queue while it sleeps until the negative lag is paid back.'),
      },
    ],
    tasks: [{ name: 'audio', nice: 0, slice: 300 * US, pattern: [{ run: 310 * US, sleep: 4730 * US }] }, hog('cc1'), hog('cc2')],
  },
  {
    id: 'interactive',
    // CLAUDE.md 比較情境 2
    title: tr('打字和編譯', 'Typing while compiling'),
    compare: ['o1-v2.6.0', 'cfs-v2.6.24', 'eevdf-v6.6'],
    story:
      tr('和情境 4 類似：一個要反應快的程式，加上兩個要吞吐量的程式。不同的是 editor 沒有告訴排程器自己需要什麼，排程器只能從它的行為去判斷。', 'Similar to the latency scenario: one task that must respond quickly plus two tasks that want throughput. The difference is that the editor does not tell the scheduler what it needs, so the scheduler can only judge from its behaviour.'),
    roles: [
      {
        what: tr('文字編輯器。大約每 10ms 醒來處理一次按鍵，花 1.3ms 就去睡。週期刻意不對齊 1ms 的 tick。', 'A text editor. Wakes about every 10ms to handle a keystroke and goes back to sleep after 1.3ms. The period is deliberately not aligned to the 1ms tick.'),
        needs: tr('延遲。按鍵後畫面晚出來，使用者就會覺得卡。它沒有設定任何 slice。', 'Latency. If the screen updates late after a keystroke, the user feels lag. It does not set any slice.'),
      },
      COMPILE,
      { ...COMPILE, what: tr('另一個編譯程式。', 'Another compiler.') },
    ],
    lookFor: [tr('時間軸上 editor（藍色）醒來後排隊（淺色）多久。', 'How long the editor (blue) queues (light) after waking, in the timeline.'), tr('lag 圖的藍線開到 2 秒看長期走向。', 'The blue line of the lag chart over 2 seconds, to see the long-term trend.')],
    takeaway: [
      tr(`CFS 讓 editor 醒來馬上跑，但它拿了 ${nInt('cfs-v2.6.24 editor.share', '12.8%')} 的 CPU，公平的份是 ${nInt('gps editor.share', '10.3%')}。CFS 對每個剛醒的程式都固定補償，不管它是不是真的需要。`, `CFS lets the editor run as soon as it wakes, but it takes ${nInt('cfs-v2.6.24 editor.share', '12.8%')} of the CPU against a fair share of ${nInt('gps editor.share', '10.3%')}. CFS gives every waking task the same fixed credit, whether it really needs it or not.`),
      tr(`EEVDF v6.6 剛好給 ${nInt('eevdf-v6.6 editor.share', '10.3%')}，editor 平均要等 ${nInt('eevdf-v6.6 editor.lat', '660µs')}。`, `EEVDF v6.6 gives exactly ${nInt('eevdf-v6.6 editor.share', '10.3%')}; the editor waits ${nInt('eevdf-v6.6 editor.lat', '660µs')} on average.`),
      tr(`EEVDF v6.12 的結果和 v6.6 差不多（平均等 ${nInt('eevdf-v6.12-slice editor.lat', '719µs')}），因為 editor 沒有要求短 slice。v6.12 不會自己去猜誰是互動型程式，要程式自己講。`, `EEVDF v6.12 gives about the same result as v6.6 (${nInt('eevdf-v6.12-slice editor.lat', '719µs')} on average) because the editor does not ask for a short slice. v6.12 does not guess which tasks are interactive; the task has to say so.`),
      {
        variant: 'o1-v2.6.0',
        text: tr(`O(1) 2.6.0 從 sleep_avg 猜出 editor 是互動型（bonus +5，prio 115），醒來大多立刻打斷 cc，平均只等 ${nInt('o1-v2.6.0 editor.lat', '205µs')}，拿 ${nInt('o1-v2.6.0 editor.share', '12.7%')} 的 CPU。最久的兩次等待（${nInt('o1-v2.6.0 editor.max', '29ms')}、11ms）是頭兩次喚醒：cc 剛從 shell fork 出來，繼承了 shell 的 sleep_avg，優先權和 editor 差不多，editor 搶不贏。`, `O(1) 2.6.0 guesses from sleep_avg that the editor is interactive (bonus +5, prio 115); on wakeup it usually interrupts cc at once, waits only ${nInt('o1-v2.6.0 editor.lat', '205µs')} on average and takes ${nInt('o1-v2.6.0 editor.share', '12.7%')} of the CPU. The two longest waits (${nInt('o1-v2.6.0 editor.max', '29ms')} and 11ms) are the first two wakeups: cc was just forked from the shell and inherited its sleep_avg, so its priority was close to the editor's and the editor could not win.`),
      },
      {
        variant: 'on-v2.4.0',
        text: tr(`O(n) 2.4 的 editor 平均等 ${nInt('on-v2.4.0 editor.lat', '546µs')}，p99 卻是 ${nInt('on-v2.4.0 editor.p99', '50ms')}。這兩次長等待都在剛開始：editor 的 counter 只比 cc 多 1，goodness 沒有高出 2，搶不了，只能等 cc 用完剩下的時間片。之後 editor 每次睡著遇到重算，沒用完的 counter 都保留一半，醒來就能插隊。`, `In O(n) 2.4 the editor waits ${nInt('on-v2.4.0 editor.lat', '546µs')} on average, but p99 is ${nInt('on-v2.4.0 editor.p99', '50ms')}. Both long waits are at the very start: the editor's counter is only 1 higher than cc's, so its goodness is not 2 higher and it cannot preempt; it has to wait for cc to use up the rest of its time slice. Afterwards, every time the editor is asleep during a recalculation it keeps half of its unused counter, so it can preempt when it wakes.`),
      },
    ],
    featNotes: [
      {
        variant: 'cfs-v2.6.24',
        key: 'NEW_FAIR_SLEEPERS',
        task: 0,
        note: tr('editor 沒有剛好拿到公平的份，反而掉到以下：醒來要等 cc 用完 sched_slice，週期變長，一秒內處理的按鍵變少。CFS 在這裡只有「補 20ms」和「完全不補」兩種選擇。', 'The editor does not end up with exactly its fair share; it drops below it. After waking it has to wait for cc to use up its sched_slice, its period grows, and fewer keystrokes are handled per second. CFS only has two choices here: a 20ms credit or none at all.'),
      },
      {
        variant: 'o1-v2.6.0',
        key: 'sleep_avg',
        task: 0,
        note: tr('少了 bonus，editor 和 cc 同優先權，醒來不能插隊，只能排在 cc 後面等一整個時間片（約 100ms）。2.6.0 照顧互動型程式的手段只有 sleep_avg 這一個，拿掉之後比 2.4 還糟。', 'Without the bonus, the editor and cc have the same priority; the editor cannot preempt on wakeup and has to queue behind cc for a whole time slice (about 100ms). sleep_avg is the only tool 2.6.0 has for interactive tasks, and without it things are worse than in 2.4.'),
      },
      {
        variant: 'on-v2.4.0',
        key: 'for_each_task',
        task: 0,
        note: tr('editor 睡著時錯過的重算不再補給它，counter 用完之後要等下一次重算，而重算只在 runqueue 上的 task 全部用完時才發生。2.4 的互動性，全靠「睡著的 task 也一起重算」這一行。', 'Recalculations the editor misses while asleep are no longer credited to it; once its counter runs out it has to wait for the next recalculation, which happens only when every task on the runqueue has used up its slice. 2.4\'s interactivity rests entirely on the one line that recalculates sleeping tasks too.'),
      },
      {
        variant: 'eevdf-v6.12-slice',
        key: 'custom_slice',
        task: 0,
        note: tr('完全不變：editor 沒有設定 slice，這個開關對它沒有作用。', 'No change at all: the editor does not set a slice, so this switch has no effect on it.'),
      },
      {
        variant: 'eevdf-v6.12-slice',
        key: 'DELAY_DEQUEUE',
        task: 0,
        note: tr('數字變得和 v6.6 一樣：對 editor 來說，v6.12 和 v6.6 只差在 DELAY_DEQUEUE。開著它，睡前的負 lag 在睡著時就還掉，editor 醒來都是 eligible；但要立刻搶到 CPU，deadline 還得比 cc 早，否則照樣等到下一個 tick。所以平均等待不一定變短，會隨週期和 tick 的相對位置忽多忽少，這個情境裡反而多等一點。代價是預設值下 lag 圖往下走，editor 拿得比公平的份多一點。', 'The numbers become the same as v6.6: for the editor, DELAY_DEQUEUE is the only difference between v6.12 and v6.6. With it on, the negative lag from before sleeping is paid back while the editor sleeps, so it is always eligible when it wakes; but to get the CPU at once its deadline must also be earlier than cc\'s, otherwise it still waits for the next tick. So the average wait is not necessarily shorter: it goes up or down with the position of the period relative to the tick, and in this scenario it is slightly longer. The price is that with the defaults the lag line goes down and the editor takes a little more than its fair share.'),
      },
    ],
    tasks: [{ name: 'editor', nice: 0, pattern: [{ run: 1.3 * MS, sleep: 8.73 * MS }] }, hog('cc1'), hog('cc2')],
  },
  {
    id: 'cheat',
    // CLAUDE.md 比較情境 3
    title: tr('假裝互動：騙過 O(1) 的 heuristics', 'Fake interactivity: fooling the O(1) heuristics'),
    compare: ['on-v2.4.0', 'o1-v2.6.0', 'cfs-v2.6.24'],
    story:
      tr('O(1) 不知道哪個 task 是互動型的，只能從行為猜：睡得多的就當成互動型，提高優先權，時間片用完還不用等下一輪（留在 active）。', 'O(1) does not know which task is interactive; it can only guess from behaviour. A task that sleeps a lot is treated as interactive: its priority goes up and it does not have to wait for the next round when its time slice runs out (it stays in active). ') +
      tr('cheat 其實和 cc 一樣是一直有事做的程式，只是每跑 2.3ms 就故意睡 0.83ms。這一點點睡眠，夠不夠讓 CPU scheduler 把它當成編輯器？', 'cheat is really just like cc, always busy, except that it deliberately sleeps 0.83ms after every 2.3ms of running. Is that tiny bit of sleep enough for the CPU scheduler to treat it like an editor?'),
    roles: [
      {
        what: tr('一直有事做的程式，但每跑 2.3ms 就主動睡 0.83ms（例如呼叫 usleep）。不睡的話它和 cc 沒有兩樣。', 'Always has work to do, but voluntarily sleeps 0.83ms after every 2.3ms of running (for example by calling usleep). Without the sleeps it would be no different from cc.'),
        needs: tr('吞吐量。它睡覺不是因為在等什麼，而是想多搶一點 CPU。', 'Throughput. It does not sleep because it is waiting for something; it sleeps to grab a bit more CPU.'),
      },
      COMPILE,
      { ...COMPILE, what: tr('另一個編譯程式。', 'Another compiler.') },
    ],
    lookFor: [
      tr('表格的 CPU 比例：cheat 在各個排程器拿到多少，和 GPS 比例差多少。', 'The CPU share in the table: how much cheat gets under each scheduler, and how far that is from the GPS share.'),
      tr('點 O(1) 時間軸上 cheat 醒來的那一刻，看它的優先權和 bonus，為什麼它一醒來就能打斷 cc。', 'Click the moment cheat wakes up on the O(1) timeline and look at its priority and bonus: why can it interrupt cc as soon as it wakes?'),
      tr('lag 圖開到 2 秒：cheat 的線往下走得多快。', 'The lag chart over 2 seconds: how fast cheat\'s line goes down.'),
    ],
    latencyNote: tr('cheat 其實不在乎延遲，這裡看的是它醒來後能不能馬上插隊：能插隊，就表示 CPU scheduler 把它當成需要快速回應的程式。', 'cheat does not actually care about latency. What this shows is whether it can jump the queue on wakeup: if it can, the CPU scheduler is treating it as a task that needs a quick response.'),
    takeaway: [
      {
        variant: 'o1-v2.6.0',
        text: tr(`O(1) 把 cheat 當成互動型。cheat 每睡 0.83ms，sleep_avg 就加上這段睡眠的好幾倍（recalc_task_prio() 乘上 10 − 目前的 bonus，bonus 越低乘得越多）；跑的 2.3ms 則照實扣掉。兩邊在 bonus +2、+3（prio 117–118）附近打平，剛好過了 nice 0 互動型的門檻（bonus ≥ +2）。於是它醒來就能打斷 cc，時間片用完又不用等下一輪，2 秒下來拿走 ${nCheat('o1-v2.6.0 cheat.share', '67%')} 的 CPU，公平的份只有 ${nCheat('gps cheat.share', '29.8%')}。`, `O(1) treats cheat as interactive. Every 0.83ms cheat sleeps adds several times that amount to sleep_avg (recalc_task_prio() multiplies by 10 − the current bonus level, so the lower the bonus, the bigger the multiplier), while its 2.3ms of running is subtracted one for one. The two balance around bonus +2 to +3 (prio 117–118), just past the interactive threshold for nice 0 (bonus ≥ +2). So it interrupts cc whenever it wakes, and when its time slice runs out it does not have to wait for the next round. Over 2 seconds it takes ${nCheat('o1-v2.6.0 cheat.share', '67%')} of the CPU, where its fair share is ${nCheat('gps cheat.share', '29.8%')}.`),
      },
      {
        variant: 'o1-v2.6.0',
        text: tr('cc 沒有被完全餓死，只是因為 cheat 每 3ms 自己會睡將近 1ms，CPU 才空給 cc。換個角度看：O(1) 被騙的根源，是用「睡了多少」去猜「需不需要快速回應」。', 'cc is not starved completely only because cheat sleeps for almost 1ms every 3ms, which leaves the CPU to cc. Put another way: O(1) is fooled because it uses "how much did it sleep" to guess "does it need a quick response".'),
      },
      {
        variant: 'on-v2.4.0',
        text: tr(`O(n) 2.4 反而虧待 cheat，只給它 ${nCheat('on-v2.4.0 cheat.share', '12%')}。cheat 醒來時 counter 比 cc 多（睡著時遇到重算，沒用完的保留一半），確實能插隊；但它每跑 2.3ms 就會碰到 tick 扣 counter，幾輪就扣完了。counter 是 0 的 task goodness 也是 0，要等兩個 cc 也把各自 60ms 的時間片用完、一起重算，才能再跑。`, `O(n) 2.4 actually shortchanges cheat, giving it only ${nCheat('on-v2.4.0 cheat.share', '12%')}. When cheat wakes, its counter is higher than cc's (it was asleep during a recalculation and kept half of what it had left), so it can preempt; but every 2.3ms of running it hits a tick that decrements its counter, and a few rounds use it up. A task with counter 0 has goodness 0 and has to wait until both cc tasks have used up their 60ms slices and everyone is recalculated together.`),
      },
      {
        variant: 'cfs-v2.6.24',
        text: tr(`CFS 只看 vruntime，睡過不會換來額外的 CPU：cheat 拿 ${nCheat('cfs-v2.6.24 cheat.share', '32.7%')}，和三等分差不多。比 GPS 的份（${nCheat('gps cheat.share', '29.8%')}）多一點，是因為喚醒補償讓它睡醒時保留了落後 min_vruntime 的那一小段。`, `CFS only looks at vruntime; sleeping does not earn extra CPU. cheat takes ${nCheat('cfs-v2.6.24 cheat.share', '32.7%')}, about a third. It is slightly above the GPS share (${nCheat('gps cheat.share', '29.8%')}) because the sleeper credit lets it keep the small gap behind min_vruntime when it wakes.`),
      },
      { variant: 'eevdf-v6.6', text: tr(`EEVDF v6.6 也不會被騙，cheat 拿 ${nCheat('eevdf-v6.6 cheat.share', '29.8%')}，和 GPS 的份相同。`, `EEVDF v6.6 is not fooled either: cheat takes ${nCheat('eevdf-v6.6 cheat.share', '29.8%')}, the same as its GPS share.`) },
    ],
    featNotes: [
      {
        variant: 'o1-v2.6.0',
        key: 'TASK_INTERACTIVE',
        task: 0,
        note: tr('cheat 醒來照樣能靠 bonus 打斷 cc，但時間片用完就得排到下一輪（expired），要等 cc 也把時間片用完才輪得到，CPU 比例回到三分之一左右。互動型「用完時間片不必等下一輪」的特權，就是被騙走的那一塊。', 'cheat still interrupts cc on wakeup thanks to its bonus, but when its time slice runs out it has to go to the next round (expired) and wait until cc has used up its slice too; its CPU share drops back to about a third. The interactive privilege of "not waiting for the next round after using up the slice" is exactly what was being exploited.'),
      },
      {
        variant: 'o1-v2.6.0',
        key: 'sleep_avg',
        task: 0,
        note: tr('不會被騙了，但矯枉過正：cheat 沒有 bonus，和 cc 同優先權，醒來不能插隊，只能排在 cc 後面等一整個時間片（約 100ms）；每次只跑 2.3ms 就去睡，醒來又得重新排隊。真正的互動型程式也會一起失去照顧，可以到「打字和編譯」關掉同一個開關看 editor。', 'No longer fooled, but it overcorrects: cheat has no bonus and the same priority as cc, cannot preempt on wakeup, and queues behind cc for a whole time slice (about 100ms); it runs only 2.3ms before sleeping and has to queue all over again when it wakes. Truly interactive tasks lose their help too; try turning off the same switch in "Typing while compiling" and watch the editor.'),
      },
      {
        variant: 'o1-v2.6.0',
        key: 'EXPIRED_STARVING',
        task: 1,
        note: tr('完全不變。排到下一輪的 task 要等超過約 1 秒 × task 數（STARVATION_LIMIT × nr_running，三個 task 約 3 秒），EXPIRED_STARVING 才出手，比這個模擬還長。', 'No change at all. EXPIRED_STARVING only steps in after tasks in the next round have waited more than about 1 second × the number of tasks (STARVATION_LIMIT × nr_running, about 3 seconds for three tasks), which is longer than this simulation.'),
      },
      {
        variant: 'on-v2.4.0',
        key: 'for_each_task',
        task: 0,
        note: tr('cheat 拿得更少。它每 3ms 有將近 1ms 在睡，重算 counter 時如果剛好在睡，就分不到新的時間片，醒來 counter 是 0、goodness 也是 0，要等 cc 把時間片用完、下一次重算。', 'cheat gets even less. It is asleep almost 1ms out of every 3ms; if it happens to be asleep when counters are recalculated it gets no new time slice, wakes with counter 0 and goodness 0, and has to wait until cc uses up its slice and the next recalculation happens.'),
      },
      {
        variant: 'cfs-v2.6.24',
        key: 'NEW_FAIR_SLEEPERS',
        task: 0,
        note: tr('cheat 睡 0.83ms 醒來時，vruntime 落在 min_vruntime 後面一點。有喚醒補償時保留原本的 vruntime；關掉之後被拉到 min_vruntime，每次睡醒都損失這一小段，CPU 比例掉到公平的份以下。', 'When cheat wakes from its 0.83ms sleep, its vruntime is slightly behind min_vruntime. With the sleeper credit it keeps its old vruntime; with it off it is pulled up to min_vruntime and loses that small gap on every wakeup, so its CPU share falls below its fair share.'),
      },
    ],
    tasks: [{ name: 'cheat', nice: 0, pattern: [{ run: 2.3 * MS, sleep: 0.83 * MS }] }, hog('cc1'), hog('cc2')],
  },
  {
    id: 'nice',
    // CLAUDE.md 比較情境 5
    title: tr('不同 nice 值的分配', 'Different nice values'),
    compare: ['o1-v2.6.0', 'cfs-v2.6.24', 'eevdf-v6.6'],
    story: tr('三個程式要的都是吞吐量，沒有延遲的問題，只是優先權不同。這裡只看公平：CPU 有沒有照權重比例分。', 'All three tasks want throughput; there is no latency question, only different priorities. This scenario looks only at fairness: is the CPU divided in proportion to the weights?'),
    roles: [
      { what: tr('一直要 CPU 的程式，nice −5（權重 3121）。', 'Always wants the CPU, nice −5 (weight 3121).'), needs: tr(`吞吐量。照權重比例，該拿 ${nNice('gps nice-5.share', '69.7%')}。`, `Throughput. By weight it should get ${nNice('gps nice-5.share', '69.7%')}.`) },
      { what: tr('一直要 CPU 的程式，nice 0（權重 1024）。', 'Always wants the CPU, nice 0 (weight 1024).'), needs: tr(`吞吐量。該拿 ${nNice('gps nice0.share', '22.9%')}。`, `Throughput. It should get ${nNice('gps nice0.share', '22.9%')}.`) },
      { what: tr('一直要 CPU 的程式，nice 5（權重 335）。', 'Always wants the CPU, nice 5 (weight 335).'), needs: tr(`吞吐量。該拿 ${nNice('gps nice5.share', '7.5%')}。`, `Throughput. It should get ${nNice('gps nice5.share', '7.5%')}.`) },
    ],
    lookFor: [
      tr('表格的 CPU 比例和 GPS 比例：2 秒下來分得準不準。', 'The CPU share and GPS share in the table: how accurate the split is over 2 seconds.'),
      tr('lag 曲線擺動的幅度：在很短的時間尺度上離比例分享有多遠。', 'How far the lag curves swing: how far from proportional sharing the scheduler is over very short time scales.'),
    ],
    takeaway: [
      tr('CFS 和 EEVDF 2 秒下來的比例都準，誤差在 0.2% 以內。', 'CFS and EEVDF both get the 2-second shares right, within 0.2%.'),
      tr('短時間尺度就不一樣了。CFS 一次讓一個程式跑好幾 ms，lag 擺到約 ±6ms；EEVDF 切得細，lag 都在 1ms 以內。長期公平和短期公平是兩種不同的保證。', 'Short time scales are a different story. CFS lets one task run for several ms at a time and lag swings to about ±6ms; EEVDF slices finely and lag stays within 1ms. Long-term fairness and short-term fairness are two different guarantees.'),
      {
        variant: 'o1-v2.6.0',
        text: tr('O(1) 2.6.0 不是照權重分，而是照時間片長度：nice −5、0、5 的時間片是 126ms、102ms、78ms，三個 hog 輪流各跑一整塊，比例約 41 : 33 : 25。nice 差 5 級，CPU 只差約 1.2 倍；CFS 是 3 倍。2 秒的數字是 45 : 33 : 21，因為前 1 秒還有 fork 時從 shell 繼承的 bonus。', 'O(1) 2.6.0 does not divide by weight but by time slice length: nice −5, 0 and 5 get 126ms, 102ms and 78ms, the three hogs take turns running one whole slice each, and the split is about 41 : 33 : 25. A difference of 5 nice levels makes only about a 1.2× difference in CPU; in CFS it is 3×. The 2-second numbers are 45 : 33 : 21 because during the first second the bonus inherited from the shell at fork is still there.'),
      },
      {
        variant: 'on-v2.4.0',
        text: tr('O(n) 2.4 也是照時間片：HZ = 100 時 counter 是 7、6、4 個 tick（70、60、40ms），比例約 41 : 35 : 24。', 'O(n) 2.4 also divides by time slice: with HZ = 100 the counters are 7, 6 and 4 ticks (70, 60 and 40ms), a split of about 41 : 35 : 24.'),
      },
    ],
    featNotes: [
      {
        variant: 'eevdf-v6.6',
        key: 'RUN_TO_PARITY',
        task: 0,
        note: tr('完全不變。這裡沒有人睡覺，也就沒有人醒來，curr 只會在 tick 時因為 slice 用完被換下，那時本來就會重新挑。', 'No change at all. Nobody sleeps here, so nobody wakes up; curr is only switched out at a tick when its slice is used up, and a new pick happens then anyway.'),
      },
    ],
    zoom: {
      width: 50,
      text: tr('CFS 和 EEVDF 2 秒下來的比例都很準。換成 50ms 看短時間：CFS 一次讓一個程式連續跑完 sched_slice（nice −5 那個約 14ms），lag 的鋸齒比 EEVDF 大得多。', 'CFS and EEVDF both get the 2-second shares right. Switch to 50ms to see the short term: CFS lets a task run its whole sched_slice in one go (about 14ms for the nice −5 task), and its lag sawtooth is much larger than EEVDF\'s.'),
    },
    tasks: [hog('nice-5', -5), hog('nice0', 0), hog('nice5', 5)],
  },
];
