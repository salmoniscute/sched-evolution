// 內文裡的行內 <code> 依種類上色：函式、資料（陣列、欄位、變數）、常數與 flag、路徑與指令。
// 沒有包 <code> 的 kernel 名稱（min_vruntime、NICE_0_LOAD、schedule() 這類）也會自動包起來，
// 所以寫內文時不必手動加標籤。浮動提示框（.tip）顯示前要量寬度，也不處理。概念詞（vruntime、lag、curr）不在此列，照一般文字顯示。
// 內容大多由 innerHTML 動態產生，所以用 MutationObserver 處理之後才插入的節點。
// 原始碼區塊（figure.code、pre）、SVG、表單元件、sched_feat 開關列不處理。

export type CodeKind = 'fn' | 'data' | 'const' | 'path' | 'expr';

const IDENT = /^[A-Za-z_][\w.]*$/;

export function classifyCode(text: string): CodeKind {
  const t = text.trim();
  if (/^[A-Za-z_]\w*\(\)$/.test(t)) return 'fn';
  if (/^[A-Za-z_]\w*\[\]$/.test(t)) return 'data';
  if (/^[A-Z][A-Z0-9_]*$/.test(t) && t.length > 1) return 'const';
  if (t.includes('/') || /\s/.test(t) && /^[a-z][\w.-]*( -?[\w.-]+)+$/.test(t)) return 'path';
  if (IDENT.test(t)) return 'data';
  return 'expr';
}

function decorate(el: HTMLElement): void {
  if (el.dataset.kind || el.closest('figure.code, pre')) return;
  const kind = classifyCode(el.textContent ?? '');
  el.dataset.kind = kind;
  el.classList.add('ic');
  // 把結尾的 () 或 [] 包起來，讓它比名稱淡一點。
  if ((kind === 'fn' || kind === 'data') && el.childNodes.length === 1 && el.firstChild?.nodeType === Node.TEXT_NODE) {
    const m = /^(.*?)(\(\)|\[\])$/.exec(el.textContent ?? '');
    if (m) {
      el.textContent = m[1] ?? "";
      const tail = document.createElement('span');
      tail.className = 'ic-tail';
      tail.textContent = m[2] ?? "";
      el.append(tail);
    }
  }
}

/** 不加底線、單獨一個字的 kernel 名稱（全大寫的 CFS、GPS、HZ 是縮寫，不算） */
const BARE_NAMES = ['HRTICK', 'MIGRATION'];

// snake_case（可帶 .欄位 或 ()）、任何 name()、帶底線的全大寫常數，再加上 BARE_NAMES。
export const KERNEL_NAME = new RegExp(
  String.raw`(?<![\w./-])(?:` +
    String.raw`[a-z_][a-z0-9]*_[a-z0-9_]*(?:\.[a-z_]\w*)*(?:\(\))?` +
    String.raw`|[a-z_]\w*\(\)` +
    String.raw`|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+` +
    `|${BARE_NAMES.join('|')}` +
    String.raw`)(?![\w(/-])`,
  'g',
);
const HAS_NAME = new RegExp(KERNEL_NAME.source); // 不帶 g，test() 才不會受 lastIndex 影響

const SKIP = 'code, pre, figure.code, svg, script, style, textarea, select, option, input, nav, .brand, .feat-row, .tip, .katex, .tex, .tex-block';

function wrapNames(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      HAS_NAME.test(n.nodeValue ?? '') && !n.parentElement?.closest(SKIP)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const n of nodes) {
    const text = n.nodeValue ?? '';
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(KERNEL_NAME)) {
      frag.append(text.slice(last, m.index), Object.assign(document.createElement('code'), { textContent: m[0] }));
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    n.replaceWith(frag);
  }
}

function scan(root: Node): void {
  if (root instanceof Element && root.closest(SKIP) && root.tagName !== 'CODE') return;
  if (!(root instanceof Element) || !root.closest('code')) wrapNames(root);
  if (root instanceof HTMLElement && root.tagName === 'CODE') decorate(root);
  if (root instanceof Element || root instanceof DocumentFragment) root.querySelectorAll<HTMLElement>('code').forEach(decorate);
}

export function installCodeChips(root: HTMLElement = document.body): void {
  scan(root);
  new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n instanceof HTMLElement) scan(n);
        else if (n instanceof Text && n.parentNode) scan(n.parentNode);
      });
    }
  }).observe(root, { childList: true, subtree: true });
}
