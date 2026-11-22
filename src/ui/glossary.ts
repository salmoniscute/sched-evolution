// 名詞表：網頁上出現的術語，滑鼠移上去（或用 Tab 聚焦、在手機上點一下）會顯示定義。
// 決策說明的文字由 linkTerms() 自動標出術語；表頭等固定文字用 term() 手動標。
import { isEn } from '../i18n.ts';

interface TermText {
  /** 顯示在名詞速查的名稱 */
  name: string;
  /** 在文字中要被認出來的寫法（第一個是主要的） */
  match: string[];
  def: string;
}

export interface Term extends TermText {
  /** term() 用來查的鍵：中文版的 match，兩種語言都查得到，程式裡寫一次就好 */
  keys: string[];
}

// 每個名詞中英各一份，改一邊時另一邊要一起改
const raw: { zh: TermText; en: TermText }[] = [
  {
    zh: {
      name: '想跑（runnable）',
      match: ['runnable', 'runqueue'],
      def: '程式有事要做，在佇列（run queue）上等 CPU。時間軸上的淺色段。正在 CPU 上跑的那一個叫 curr，也算在想跑的程式裡。',
    },
    en: {
      name: 'runnable',
      match: ['runnable', 'runqueue'],
      def: 'The task has work to do and is waiting on the queue (run queue) for the CPU: the light stretches in the timeline. The task currently on the CPU is called curr and also counts as runnable.',
    },
  },
  {
    zh: {
      name: 'curr',
      match: ['curr'],
      def: '目前在 CPU 上跑的程式。單核只有一個。',
    },
    en: {
      name: 'curr',
      match: ['curr'],
      def: 'The task currently running on the CPU. On a single core there is only one.',
    },
  },
  {
    zh: {
      name: 'tick',
      match: ['tick'],
      def: '週期性的時鐘中斷。本站的 2.4 用 HZ=100（每 10ms 一次），其他都用 HZ=1000（每 1ms 一次）。排程器在 tick 時檢查 curr 是不是跑太久了。沒有人睡覺或醒來的話，換人只會發生在 tick 上，所以 HZ=1000 時 EEVDF 0.75ms 的 slice 實際上會跑到 1ms；HZ=250 時是 4ms。',
    },
    en: {
      name: 'tick',
      match: ['tick'],
      def: 'The periodic timer interrupt. On this site 2.4 uses HZ=100 (one every 10ms) and everything else HZ=1000 (one every 1ms). At a tick the scheduler checks whether curr has run too long. If nobody sleeps or wakes up, switches only happen at ticks, which is why with HZ=1000 EEVDF\'s 0.75ms slice actually runs for 1ms; with HZ=250 it would be 4ms.',
    },
  },
  {
    zh: {
      name: 'nice 與權重',
      match: ['權重', 'nice'],
      def: '使用者設定的優先權，−20 到 19，越小越優先。CFS 以後換算成權重：nice 0 是 1024，每差 1 大約差 1.25 倍（nice −5 是 3121，nice 5 是 335）。公平的份 = 自己的權重 ÷ 所有想跑程式的權重總和。',
    },
    en: {
      name: 'nice and weight',
      match: ['weight', 'nice'],
      def: 'The priority set by the user, −20 to 19; lower means higher priority. From CFS on it is converted to a weight: nice 0 is 1024 and each step is about 1.25× (nice −5 is 3121, nice 5 is 335). Fair share = own weight ÷ total weight of all runnable tasks.',
    },
  },
  {
    zh: {
      name: 'starvation（飢餓）',
      match: ['starvation'],
      def: 'task 想執行，卻長時間拿不到 CPU。常見於嚴格的優先權排程、SJF，以及「被虧欠的一次討回全部」的規則。CFS 在喚醒時把落後的幅度限制在 20ms 以內，就是為了避免醒來的 task 讓其他 task 餓太久。',
    },
    en: {
      name: 'starvation',
      match: ['starvation'],
      def: 'A task wants to run but cannot get the CPU for a long time. Common with strict priority scheduling, SJF, and rules where an owed task claims everything back at once. CFS caps how far behind a waking task can be at 20ms precisely so that it cannot starve the others for too long.',
    },
  },
  {
    zh: {
      name: 'preemptive 與 non-preemptive',
      match: ['preemptive'],
      def: 'non-preemptive：task 拿到 CPU 後一直執行到自己讓出（去睡或結束）才重新挑選。preemptive：CPU scheduler 可以把 CPU 從正在執行的 task 手上拿走。Linux 在 tick（curr 用完該拿的）和喚醒（醒來的 task 能否插隊）兩個時機搶占。',
    },
    en: {
      name: 'preemptive and non-preemptive',
      match: ['preemptive'],
      def: 'Non-preemptive: once a task gets the CPU it keeps it until it gives it up itself (sleeps or exits). Preemptive: the CPU scheduler can take the CPU away from the running task. Linux preempts at two points: at a tick (curr has used up its share) and at wakeup (can the waking task jump the queue).',
    },
  },
  {
    zh: {
      name: 'throughput（吞吐量）',
      match: ['throughput', '吞吐量'],
      def: '單位時間完成的工作量。context switch 越頻繁，花在切換（以及 cache、TLB 重新填）的時間越多，throughput 越低；但切換太少，醒來的 task 要等得久。本站的模擬不計切換成本，以 context switch 次數當作指標。',
    },
    en: {
      name: 'throughput',
      match: ['throughput'],
      def: 'Work done per unit of time. The more often context switches happen, the more time goes to switching (and refilling caches and the TLB) and the lower the throughput; but too few switches make waking tasks wait longer. The simulation here does not charge for switches and uses the number of context switches as the indicator.',
    },
  },
  {
    zh: {
      name: '時間片（time slice）',
      match: ['time_slice', '時間片'],
      def: 'O(n) 與 O(1) 分給 task 的 CPU 時間，以 tick 為單位：每個 tick 由正在跑的 task 扣一格，扣完就換人，不管那個 tick 裡它實際跑了多久。2.4.0（HZ=100）nice 0 是 6 個 tick = 60ms；2.6.0（HZ=1000）nice 0 是 102ms，nice −20 是 200ms，nice 19 是 10ms。CFS 以後沒有固定的時間片。',
    },
    en: {
      name: 'time slice',
      match: ['time_slice', 'time slice'],
      def: 'The CPU time O(n) and O(1) give a task, counted in ticks: each tick takes one unit from the running task, and when it reaches zero the task is switched out, no matter how much of that tick it actually ran. In 2.4.0 (HZ=100) nice 0 gets 6 ticks = 60ms; in 2.6.0 (HZ=1000) nice 0 gets 102ms, nice −20 200ms, nice 19 10ms. From CFS on there is no fixed time slice.',
    },
  },
  {
    zh: {
      name: 'counter',
      match: ['counter'],
      def: '2.4 的 task 這一輪還剩幾個 tick。tick 時 curr 扣 1；runqueue 上所有 task 都扣到 0 時，系統裡每一個 task（包括睡著的）重算 counter = counter / 2 + NICE_TO_TICKS(nice)，所以常睡的 task 會累積到將近兩倍。',
    },
    en: {
      name: 'counter',
      match: ['counter'],
      def: 'How many ticks a 2.4 task has left in this round. At each tick curr loses 1; when every task on the runqueue is at 0, every task in the system (sleeping ones included) is recalculated as counter = counter / 2 + NICE_TO_TICKS(nice), so tasks that sleep a lot build up to almost twice the normal amount.',
    },
  },
  {
    zh: {
      name: 'goodness',
      match: ['goodness'],
      def: '2.4 的 goodness() 給每個 task 的分數：counter 是 0 就是 0，否則是 counter + 20 − nice，和上一個 task 是同一個程式（同一個 mm）再加 1。schedule() 每次從頭掃過整條 runqueue，選分數最高的。',
    },
    en: {
      name: 'goodness',
      match: ['goodness'],
      def: 'The score 2.4\'s goodness() gives each task: 0 if counter is 0, otherwise counter + 20 − nice, plus 1 if it belongs to the same program (same mm) as the previous task. schedule() scans the whole runqueue from the start every time and picks the highest score.',
    },
  },
  {
    zh: {
      name: 'prio 與 static_prio',
      match: ['static_prio', 'prio'],
      def: 'O(1) 的優先權，100–139，數字越小越優先。static_prio = 120 + nice，只看 nice；prio = static_prio − bonus，是實際拿來排程的。',
    },
    en: {
      name: 'prio and static_prio',
      match: ['static_prio', 'prio'],
      def: 'O(1)\'s priority, 100–139; lower numbers run first. static_prio = 120 + nice depends only on nice; prio = static_prio − bonus is what scheduling actually uses.',
    },
  },
  {
    zh: {
      name: 'sleep_avg 與 bonus',
      match: ['sleep_avg', 'bonus'],
      def: 'O(1) 估計 task 有多常在睡的量，0 到 1020ms：睡覺時加（sleep_avg 越低加得越快，最多 10 倍），在 CPU 上跑時扣。換算成 bonus −5 到 +5：睡得多的 prio 最多提高 5 級，一直在跑的降 5 級。',
    },
    en: {
      name: 'sleep_avg and bonus',
      match: ['sleep_avg', 'bonus'],
      def: 'O(1)\'s estimate of how much a task sleeps, 0 to 1020ms: it goes up while sleeping (faster when sleep_avg is low, up to 10×) and down while running. It is converted to a bonus from −5 to +5: tasks that sleep a lot gain up to 5 priority levels, tasks that always run lose 5.',
    },
  },
  {
    zh: {
      name: 'TASK_INTERACTIVE',
      match: ['TASK_INTERACTIVE'],
      def: 'O(1) 判斷互動型的條件：prio 至少比 static_prio 好 DELTA 級（nice 0 是 2 級，也就是 bonus ≥ +2；nice 越大越難）。互動型的 task 用完時間片可以排回 active（這一輪），不用等到下一輪。',
    },
    en: {
      name: 'TASK_INTERACTIVE',
      match: ['TASK_INTERACTIVE'],
      def: 'O(1)\'s test for an interactive task: prio is at least DELTA levels better than static_prio (2 levels for nice 0, i.e. bonus ≥ +2; harder for higher nice). An interactive task that uses up its time slice can go back into active (this round) instead of waiting for the next round.',
    },
  },
  {
    zh: {
      name: 'prio_array',
      match: ['prio_array', 'bitmap'],
      def: 'O(1) 的資料結構：每個 prio 一條 FIFO 佇列，共 140 條，加一張 140 bit 的 bitmap，哪一條非空對應的 bit 就是 1。挑選時用 sched_find_first_bit() 找第一個 1，成本固定，和 task 數量無關。',
    },
    en: {
      name: 'prio_array',
      match: ['prio_array', 'bitmap'],
      def: 'O(1)\'s data structure: one FIFO queue per prio, 140 in all, plus a 140-bit bitmap whose bit is 1 for every non-empty queue. Picking uses sched_find_first_bit() to find the first 1, at a fixed cost that does not depend on the number of tasks.',
    },
  },
  {
    zh: {
      name: 'active 與 expired',
      match: ['active', 'expired'],
      def: 'O(1) 把 task 分成兩組，各是一個 prio_array。active 是「這一輪」：還有時間片的 task 在這裡，只從這裡挑。expired 是「下一輪」：時間片用完的 task 拿到新的時間片後排到這裡等，優先權再高也要等 active 空了才輪得到（互動型的例外，可以排回 active）。active 空了就把兩個指標對調，下一輪開始。',
    },
    en: {
      name: 'active and expired',
      match: ['active', 'expired'],
      def: 'O(1) splits tasks into two sets, each a prio_array. active is "this round": tasks with time slice left are here, and only these are picked. expired is "the next round": tasks that used up their slice get a new one and wait here; however high their priority, they only get a turn once active is empty (interactive tasks are the exception and can go back into active). When active is empty the two pointers are swapped and the next round begins.',
    },
  },
  {
    zh: {
      name: 'EXPIRED_STARVING',
      match: ['EXPIRED_STARVING', 'STARVATION_LIMIT'],
      def: 'O(1) 防止 starvation 的檢查：expired 裡最早排進去的 task 已經等超過 STARVATION_LIMIT × task 數（2.6.0 約 1 秒 × task 數），互動型的 task 用完時間片也不能再排回 active，要一起去 expired。',
    },
    en: {
      name: 'EXPIRED_STARVING',
      match: ['EXPIRED_STARVING', 'STARVATION_LIMIT'],
      def: 'O(1)\'s guard against starvation: once the first task put into expired has waited longer than STARVATION_LIMIT × the number of tasks (about 1 second × tasks in 2.6.0), interactive tasks that use up their slice can no longer go back into active and have to go to expired too.',
    },
  },
  {
    zh: {
      name: 'TIMESLICE_GRANULARITY',
      match: ['TIMESLICE_GRANULARITY'],
      def: 'O(1) 把互動型 task 的長時間片切成小段（10ms 起）。每跑完一段，就排到同優先權佇列的尾端，讓同優先權的 task 輪流，不會被一個互動型 task 一次占住上百 ms。',
    },
    en: {
      name: 'TIMESLICE_GRANULARITY',
      match: ['TIMESLICE_GRANULARITY'],
      def: 'O(1) cuts the long time slice of an interactive task into pieces (10ms and up). After each piece the task goes to the end of its priority queue so tasks with the same priority take turns, instead of one interactive task holding the CPU for over 100ms.',
    },
  },
  {
    zh: {
      name: 'HZ 與 jiffies',
      match: ['HZ', 'jiffies'],
      def: 'HZ 是每秒幾次 tick：2.4 的 i386 預設 100（每 10ms 一次），2.6.0 是 1000（每 1ms 一次）；2.6.13 起改成編譯時選 100、250、300 或 1000，預設 250。本站的 CFS 與 EEVDF 一律用 1000。jiffies 是開機以來的 tick 數，O(n) 與 O(1) 用它計時。',
    },
    en: {
      name: 'HZ and jiffies',
      match: ['HZ', 'jiffies'],
      def: 'HZ is the number of ticks per second: 100 by default on i386 in 2.4 (one every 10ms) and 1000 in 2.6.0 (one every 1ms); from 2.6.13 it is chosen at build time from 100, 250, 300 or 1000, with 250 as the default. On this site CFS and EEVDF always use 1000. jiffies is the number of ticks since boot; O(n) and O(1) use it to keep time.',
    },
  },
  {
    zh: {
      name: 'fork',
      match: ['fork'],
      def: '建立新的 task。新 task 從 parent 複製一份狀態：O(n) 與 O(1) 裡，parent 剩下的時間片對半分給自己和 child；O(1) 的 sleep_avg 也從 parent 繼承（打折）。所以剛 fork 出來的 task 會帶著 parent 的優先權一段時間。',
    },
    en: {
      name: 'fork',
      match: ['fork'],
      def: 'Creates a new task. The new task starts as a copy of its parent: in O(n) and O(1) the parent\'s remaining time slice is split in half between parent and child, and in O(1) the sleep_avg is inherited too (slightly reduced). So a freshly forked task carries its parent\'s priority for a while.',
    },
  },
  {
    zh: {
      name: 'GPS',
      match: ['GPS'],
      def: 'Generalized Processor Sharing，理想的流體模型：CPU 同時分給所有想跑的程式，每個以「權重 ÷ 總權重」的速度前進。真的 CPU 一次只能跑一個，做不到，GPS 只拿來當公平的標準。',
    },
    en: {
      name: 'GPS',
      match: ['GPS'],
      def: 'Generalized Processor Sharing, the ideal fluid model: the CPU is shared by all runnable tasks at the same time, each progressing at a rate of weight ÷ total weight. A real CPU runs one task at a time and cannot do this; GPS is only used as the yardstick for fairness.',
    },
  },
  {
    zh: {
      name: 'vruntime',
      match: ['vruntime'],
      def: '程式累計用掉的 CPU 時間，按權重換算成 nice 0 的單位：每跑 Δt 就加 Δt × 1024 ÷ 自己的權重。nice 0 跑 1ms 加 1ms，nice 5（權重 335）跑 1ms 加約 3.06ms。vruntime 小，表示按權重算它跑得少。',
    },
    en: {
      name: 'vruntime',
      match: ['vruntime'],
      def: 'The CPU time a task has used, converted to nice-0 units by its weight: each Δt of running adds Δt × 1024 ÷ its weight. A nice 0 task adds 1ms per 1ms run; a nice 5 task (weight 335) adds about 3.06ms. A small vruntime means the task has run little, relative to its weight.',
    },
  },
  {
    zh: {
      name: 'min_vruntime',
      match: ['min_vruntime'],
      def: 'CFS 佇列上最小的 vruntime，只往前走、不倒退。剛醒來或新建立的程式以它為基準放置，避免帶著很久以前的小 vruntime 回來霸佔 CPU。',
    },
    en: {
      name: 'min_vruntime',
      match: ['min_vruntime'],
      def: 'The smallest vruntime on the CFS queue; it only moves forward, never back. Waking and newly created tasks are placed relative to it, so they cannot come back with an ancient small vruntime and hog the CPU.',
    },
  },
  {
    zh: {
      name: 'V（avg_vruntime）',
      match: ['avg_vruntime', 'V'],
      def: 'EEVDF 佇列上所有程式 vruntime 的加權平均（權重當比重）。kernel 拿它近似 GPS 的虛擬時間：vruntime 在 V 左邊，表示拿得比應得的少。',
    },
    en: {
      name: 'V (avg_vruntime)',
      match: ['avg_vruntime', 'V'],
      def: 'The weighted average of the vruntime of every task on the EEVDF queue (weights as the weighting). The kernel uses it to approximate GPS virtual time: a vruntime to the left of V means the task has received less than it is entitled to.',
    },
  },
  {
    zh: {
      name: 'lag',
      match: ['lag'],
      def: '應得 − 實得。正的表示排程器欠它 CPU，負的表示它多拿了。kernel 用 權重 × (V − vruntime) 算，模擬頁下方的圖則是照 GPS 另外算的。',
    },
    en: {
      name: 'lag',
      match: ['lag'],
      def: 'Entitled − received. Positive means the scheduler owes the task CPU time; negative means it has taken more than its share. The kernel computes it as weight × (V − vruntime); the chart at the bottom of the simulation page computes it separately from GPS.',
    },
  },
  {
    zh: {
      name: 'vlag',
      match: ['vlag'],
      def: 'EEVDF 在程式離開佇列時存下的 V − vruntime（截在 ±limit 內）。睡醒回來時用它放回 V − vlag 的位置，所以睡多久都不影響。',
    },
    en: {
      name: 'vlag',
      match: ['vlag'],
      def: 'The V − vruntime EEVDF saves when a task leaves the queue (clamped to ±limit). On wakeup the task is put back at V − vlag, so how long it slept makes no difference.',
    },
  },
  {
    zh: {
      name: 'sched_latency',
      match: ['sched_latency', 'sysctl_sched_latency'],
      def: 'CFS 的目標週期：每個想跑的程式在這段時間內至少輪到一次。v2.6.24 單核是 20ms，也是喚醒補償的上限。',
    },
    en: {
      name: 'sched_latency',
      match: ['sched_latency', 'sysctl_sched_latency'],
      def: 'CFS\'s target period: every runnable task gets at least one turn within it. In v2.6.24 on a single core it is 20ms, which is also the cap on the sleeper credit.',
    },
  },
  {
    zh: {
      name: 'eligible',
      match: ['eligible'],
      def: '有資格被 EEVDF 選中：lag ≥ 0，也就是 vruntime 沒有超過 V、沒有多拿。多拿的程式要等 V 往前追過它才恢復資格。',
    },
    en: {
      name: 'eligible',
      match: ['eligible'],
      def: 'Allowed to be picked by EEVDF: lag ≥ 0, i.e. vruntime not past V, not having taken more than its share. A task that took too much has to wait for V to move past it before it becomes eligible again.',
    },
  },
  {
    zh: {
      name: 'deadline',
      match: ['deadline'],
      def: 'EEVDF 替每個程式算的虛擬截止時間：vruntime + slice × 1024 ÷ 權重。意思是照公平的速度，這一段 slice 應該在這之前跑完。eligible 的程式裡 deadline 最早的先跑，所以 slice 越短，deadline 越早。',
    },
    en: {
      name: 'deadline',
      match: ['deadline'],
      def: 'The virtual deadline EEVDF computes for each task: vruntime + slice × 1024 ÷ weight, i.e. when this slice should be finished if the task ran at its fair rate. Among eligible tasks the earliest deadline runs first, so a shorter slice means an earlier deadline.',
    },
  },
  {
    zh: {
      name: 'slice',
      match: ['slice'],
      def: 'EEVDF 一次讓程式連續跑的量。v6.6 一律 0.75ms；v6.12 可以由程式自己指定（custom_slice）。slice 短的程式 deadline 早、比較快輪到，但每次只能跑一小段。',
    },
    en: {
      name: 'slice',
      match: ['slice'],
      def: 'How long EEVDF lets a task run in one go. v6.6 always uses 0.75ms; in v6.12 a task can set its own (custom_slice). A task with a short slice has an earlier deadline and gets its turn sooner, but runs only a little each time.',
    },
  },
  {
    zh: {
      name: 'sched_slice',
      match: ['sched_slice'],
      def: 'CFS 讓 curr 這一輪可以連續跑多久：sched_latency（20ms）× 自己的權重 ÷ 總權重。三個 nice 0 的程式時每個約 6.7ms。tick 時超過就換人。',
    },
    en: {
      name: 'sched_slice',
      match: ['sched_slice'],
      def: 'How long CFS lets curr run continuously in this round: sched_latency (20ms) × own weight ÷ total weight. With three nice 0 tasks that is about 6.7ms each. At a tick, a task past this is switched out.',
    },
  },
  {
    zh: {
      name: 'wakeup_granularity',
      match: ['wakeup_granularity'],
      def: 'CFS 喚醒搶佔的門檻，10ms（按 curr 的權重換算）。醒來的程式 vruntime 要比 curr 小超過這麼多才會立刻插隊，避免太頻繁的 context switch。',
    },
    en: {
      name: 'wakeup_granularity',
      match: ['wakeup_granularity'],
      def: 'CFS\'s wakeup preemption threshold, 10ms (scaled by curr\'s weight). A waking task preempts right away only if its vruntime is smaller than curr\'s by more than this, to avoid excessive context switches.',
    },
  },
  {
    zh: {
      name: '喚醒補償',
      match: ['喚醒補償'],
      def: 'CFS 的 NEW_FAIR_SLEEPERS：睡醒的程式放在 min_vruntime − 20ms（但不會比它原本的 vruntime 小）。等於每次醒來都送它最多 20ms，讓它能馬上插隊。',
    },
    en: {
      name: 'sleeper credit',
      match: ['sleeper credit'],
      def: 'CFS\'s NEW_FAIR_SLEEPERS: a waking task is placed at min_vruntime − 20ms (but never below its own previous vruntime). In effect every wakeup is handed up to 20ms, so the task can usually preempt right away.',
    },
  },
  {
    zh: {
      name: 'context switch',
      match: ['context switch'],
      def: 'CPU 從一個程式換到另一個。每次都有成本（存取暫存器、快取和 TLB 變冷），所以排程器不會無限細切。',
    },
    en: {
      name: 'context switch',
      match: ['context switch'],
      def: 'The CPU switching from one task to another. Each switch has a cost (saving registers, cold caches and TLB), so schedulers do not slice arbitrarily finely.',
    },
  },
  {
    zh: {
      name: '喚醒延遲',
      match: ['喚醒延遲'],
      def: '程式醒來（變成想跑）到真的開始在 CPU 上跑之間等的時間。時間軸上深色段前面那一截淺色。',
    },
    en: {
      name: 'wakeup latency',
      match: ['wakeup latency'],
      def: 'The time between a task waking up (becoming runnable) and actually starting to run on the CPU: the light stretch just before a dark one in the timeline.',
    },
  },
  {
    zh: {
      name: 'p99',
      match: ['p99'],
      def: '把每次的喚醒延遲由小到大排，第 99% 位置的那一次，看的是最糟的那一小撮。p99 可能比平均還小：如果 99% 以上的喚醒都不用等、只有少數幾次等很久，平均會被那幾次拉高，p99 卻還落在不用等的那一群裡。',
    },
    en: {
      name: 'p99',
      match: ['p99'],
      def: 'Sort all wakeup latencies from small to large and take the one at the 99% position; it looks at the worst small fraction. p99 can be smaller than the average: if more than 99% of wakeups do not wait at all and only a few wait a long time, those few pull the average up while p99 still falls among the ones that did not wait.',
    },
  },
  {
    zh: {
      name: '主動 / 被搶',
      match: ['主動 / 被搶'],
      def: '主動：自己去睡、讓出 CPU 的次數（kernel 的 nvcsw）。被搶：還想跑卻被換下來的次數（nivcsw）。',
    },
    en: {
      name: 'voluntary / preempted',
      match: ['voluntary / preempted'],
      def: 'Voluntary: how many times the task gave up the CPU itself by going to sleep (the kernel\'s nvcsw). Preempted: how many times it was switched out while it still wanted to run (nivcsw).',
    },
  },
];

export const terms: Term[] = raw.map((r) => ({ ...(isEn ? r.en : r.zh), keys: r.zh.match }));

const byKey = new Map<string, Term>(terms.flatMap((t) => [...t.keys, ...t.match].map((m) => [m, t] as const)));
/** 自動標註只比對目前語言的寫法 */
const autoKeys = terms.flatMap((t) => t.match);

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** 手動標一個術語。label 是顯示文字，key 是 match 裡的任一個寫法 */
export function term(label: string, key = label): string {
  const t = byKey.get(key);
  if (!t) return label;
  return `<span class="term" tabindex="0" data-term="${escAttr(t.name)}" data-tip="${escAttr(t.def)}">${label}</span>`;
}

// 英文術語要前後不接英數字或底線（vruntime 不能吃到 min_vruntime 的一部分；V 不能吃到 Vruntime）
const pattern = new RegExp(
  autoKeys
    .sort((a, b) => b.length - a.length)
    .map((k) => {
      const e = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return /^[\w ]+$/.test(k) ? `(?<![\\w])${e}(?![\\w])` : e;
    })
    .join('|'),
  'g',
);

/**
 * 在已經跳脫過、不含標籤的 HTML 文字裡標出術語。每個術語只標第一次出現，避免整段都是底線。
 * seen 可以跨段落共用。
 */
export function linkTerms(escaped: string, seen = new Set<string>()): string {
  return escaped.replace(pattern, (m) => {
    const t = byKey.get(m)!;
    if (seen.has(t.name)) return m;
    seen.add(t.name);
    return term(m);
  });
}

/** 對一棵 DOM 裡的文字標出術語（略過程式碼、公式、SVG、連結），seen 跨元素共用 */
export function linkTermsIn(root: Element, seen = new Set<string>()): void {
  const skip = 'code, pre, figure.code, svg, a, .katex, .tex, .tex-block, .term, h2, h3, th, summary';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const n of nodes) {
    const raw = n.nodeValue ?? '';
    const esc = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = linkTerms(esc, seen);
    if (html === esc) continue;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    n.replaceWith(tpl.content);
  }
}

/** 名詞速查（入門頁） */
export function glossaryHtml(): string {
  return `<dl class="glossary">${terms.map((t) => `<dt>${t.name}</dt><dd>${t.def}</dd>`).join('')}</dl>`;
}

/** 全頁共用一個浮動提示框（放在 body 上，不會被有捲軸的表格裁掉） */
export function installTooltips(): void {
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  let current: HTMLElement | null = null;

  const show = (el: HTMLElement) => {
    current = el;
    tip.innerHTML = `<b>${escAttr(el.dataset.term ?? '')}</b>${escAttr(el.dataset.tip ?? '')}`;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, document.documentElement.clientWidth - w - 8));
    const below = r.bottom + 6;
    const top = below + tip.offsetHeight > window.innerHeight - 8 ? r.top - tip.offsetHeight - 6 : below;
    tip.style.left = `${left + window.scrollX}px`;
    tip.style.top = `${top + window.scrollY}px`;
  };
  const hide = () => {
    current = null;
    tip.hidden = true;
  };
  const target = (e: Event) => (e.target instanceof Element ? e.target.closest<HTMLElement>('.term') : null);

  document.addEventListener('mouseover', (e) => {
    const el = target(e);
    if (el) show(el);
    else if (current) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = target(e);
    if (el) show(el);
  });
  document.addEventListener('focusout', hide);
  // 觸控：點一下顯示，再點別處收起
  document.addEventListener('click', (e) => {
    const el = target(e);
    if (el) show(el);
    else hide();
  });
  window.addEventListener('scroll', () => current && show(current), { passive: true });
}
