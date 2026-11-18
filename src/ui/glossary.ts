// 名詞表：網頁上出現的術語，滑鼠移上去（或用 Tab 聚焦、在手機上點一下）會顯示定義。
// 決策說明的文字由 linkTerms() 自動標出術語；表頭等固定文字用 term() 手動標。

export interface Term {
  /** 顯示在名詞速查的名稱 */
  name: string;
  /** 在文字中要被認出來的寫法（第一個是主要的） */
  match: string[];
  def: string;
}

export const terms: Term[] = [
  {
    name: '想跑（runnable）',
    match: ['runnable'],
    def: '程式有事要做，在佇列（run queue）上等 CPU。時間軸上的淺色段。正在 CPU 上跑的那一個叫 curr，也算在想跑的程式裡。',
  },
  {
    name: 'curr',
    match: ['curr'],
    def: '目前在 CPU 上跑的程式。單核只有一個。',
  },
  {
    name: 'tick',
    match: ['tick'],
    def: '每 1ms 一次的時鐘中斷（HZ=1000）。排程器在 tick 時檢查 curr 是不是跑太久了。沒有人睡覺或醒來的話，換人只會發生在 tick 上，所以 0.75ms 的 slice 實際上會跑到 1ms。',
  },
  {
    name: 'nice 與權重',
    match: ['權重', 'nice'],
    def: '使用者設定的優先權，−20 到 19，越小越優先。CFS 以後換算成權重：nice 0 是 1024，每差 1 大約差 1.25 倍（nice −5 是 3121，nice 5 是 335）。公平的份 = 自己的權重 ÷ 所有想跑程式的權重總和。',
  },
  {
    name: 'starvation（飢餓）',
    match: ['starvation'],
    def: 'task 想執行，卻長時間拿不到 CPU。常見於嚴格的優先權排程、SJF，以及「被虧欠的一次討回全部」的規則。CFS 在喚醒時把落後的幅度限制在 20ms 以內，就是為了避免醒來的 task 讓其他 task 餓太久。',
  },
  {
    name: 'preemptive 與 non-preemptive',
    match: ['preemptive'],
    def: 'non-preemptive：task 拿到 CPU 後一直執行到自己讓出（去睡或結束）才重新挑選。preemptive：CPU scheduler 可以把 CPU 從正在執行的 task 手上拿走。Linux 在 tick（curr 用完該拿的）和喚醒（醒來的 task 能否插隊）兩個時機搶占。',
  },
  {
    name: 'throughput（吞吐量）',
    match: ['throughput', '吞吐量'],
    def: '單位時間完成的工作量。context switch 越頻繁，花在切換（以及 cache、TLB 重新填）的時間越多，throughput 越低；但切換太少，醒來的 task 要等得久。本站的模擬不計切換成本，以 context switch 次數當作指標。',
  },
  {
    name: 'GPS',
    match: ['GPS'],
    def: 'Generalized Processor Sharing，理想的流體模型：CPU 同時分給所有想跑的程式，每個以「權重 ÷ 總權重」的速度前進。真的 CPU 一次只能跑一個，做不到，GPS 只拿來當公平的標準。',
  },
  {
    name: 'vruntime',
    match: ['vruntime'],
    def: '程式累計用掉的 CPU 時間，按權重換算成 nice 0 的單位：每跑 Δt 就加 Δt × 1024 ÷ 自己的權重。nice 0 跑 1ms 加 1ms，nice 5（權重 335）跑 1ms 加約 3.06ms。vruntime 小，表示按權重算它跑得少。',
  },
  {
    name: 'min_vruntime',
    match: ['min_vruntime'],
    def: 'CFS 佇列上最小的 vruntime，只往前走、不倒退。剛醒來或新建立的程式以它為基準放置，避免帶著很久以前的小 vruntime 回來霸佔 CPU。',
  },
  {
    name: 'V（avg_vruntime）',
    match: ['avg_vruntime', 'V'],
    def: 'EEVDF 佇列上所有程式 vruntime 的加權平均（權重當比重）。kernel 拿它近似 GPS 的虛擬時間：vruntime 在 V 左邊，表示拿得比應得的少。',
  },
  {
    name: 'lag',
    match: ['lag'],
    def: '應得 − 實得。正的表示排程器欠它 CPU，負的表示它多拿了。kernel 用 權重 × (V − vruntime) 算，模擬頁下方的圖則是照 GPS 另外算的。',
  },
  {
    name: 'vlag',
    match: ['vlag'],
    def: 'EEVDF 在程式離開佇列時存下的 V − vruntime（截在 ±limit 內）。睡醒回來時用它放回 V − vlag 的位置，所以睡多久都不影響。',
  },
  {
    name: 'sched_latency',
    match: ['sched_latency', 'sysctl_sched_latency'],
    def: 'CFS 的目標週期：每個想跑的程式在這段時間內至少輪到一次。v2.6.24 單核是 20ms，也是喚醒補償的上限。',
  },
  {
    name: 'eligible',
    match: ['eligible'],
    def: '有資格被 EEVDF 選中：lag ≥ 0，也就是 vruntime 沒有超過 V、沒有多拿。多拿的程式要等 V 往前追過它才恢復資格。',
  },
  {
    name: 'deadline',
    match: ['deadline'],
    def: 'EEVDF 替每個程式算的虛擬截止時間：vruntime + slice × 1024 ÷ 權重。意思是照公平的速度，這一段 slice 應該在這之前跑完。eligible 的程式裡 deadline 最早的先跑，所以 slice 越短，deadline 越早。',
  },
  {
    name: 'slice',
    match: ['slice'],
    def: 'EEVDF 一次讓程式連續跑的量。v6.6 一律 0.75ms；v6.12 可以由程式自己指定（custom_slice）。slice 短的程式 deadline 早、比較快輪到，但每次只能跑一小段。',
  },
  {
    name: 'sched_slice',
    match: ['sched_slice'],
    def: 'CFS 讓 curr 這一輪可以連續跑多久：sched_latency（20ms）× 自己的權重 ÷ 總權重。三個 nice 0 的程式時每個約 6.7ms。tick 時超過就換人。',
  },
  {
    name: 'wakeup_granularity',
    match: ['wakeup_granularity'],
    def: 'CFS 喚醒搶佔的門檻，10ms（按 curr 的權重換算）。醒來的程式 vruntime 要比 curr 小超過這麼多才會立刻插隊，避免太頻繁的 context switch。',
  },
  {
    name: '喚醒補償',
    match: ['喚醒補償'],
    def: 'CFS 的 NEW_FAIR_SLEEPERS：睡醒的程式放在 min_vruntime − 20ms（但不會比它原本的 vruntime 小）。等於每次醒來都送它最多 20ms，讓它能馬上插隊。',
  },
  {
    name: 'context switch',
    match: ['context switch'],
    def: 'CPU 從一個程式換到另一個。每次都有成本（存取暫存器、快取和 TLB 變冷），所以排程器不會無限細切。',
  },
  {
    name: '喚醒延遲',
    match: ['喚醒延遲'],
    def: '程式醒來（變成想跑）到真的開始在 CPU 上跑之間等的時間。時間軸上深色段前面那一截淺色。',
  },
  {
    name: 'p99',
    match: ['p99'],
    def: '把每次的喚醒延遲由小到大排，第 99% 位置的那一次，看的是最糟的那一小撮。p99 可能比平均還小：如果 99% 以上的喚醒都不用等、只有少數幾次等很久，平均會被那幾次拉高，p99 卻還落在不用等的那一群裡。',
  },
  {
    name: '主動 / 被搶',
    match: ['主動 / 被搶'],
    def: '主動：自己去睡、讓出 CPU 的次數（kernel 的 nvcsw）。被搶：還想跑卻被換下來的次數（nivcsw）。',
  },
];

const byKey = new Map<string, Term>(terms.flatMap((t) => t.match.map((m) => [m, t] as const)));

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** 手動標一個術語。label 是顯示文字，key 是 match 裡的任一個寫法 */
export function term(label: string, key = label): string {
  const t = byKey.get(key);
  if (!t) return label;
  return `<span class="term" tabindex="0" data-term="${escAttr(t.name)}" data-tip="${escAttr(t.def)}">${label}</span>`;
}

// 英文術語要前後不接英數字或底線（vruntime 不能吃到 min_vruntime 的一部分；V 不能吃到 Vruntime）
const pattern = new RegExp(
  [...byKey.keys()]
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
