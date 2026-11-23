// 介面語言。中英文寫在同一處（tr('中文', 'English')），改其中一個時另一個就在旁邊，兩者要一起改。
// 語言在載入時決定一次，切換時重新載入頁面，所以模組最上層的常數也可以直接用 tr()。
// 優先順序：網址的 ?lang= → localStorage → 英文。不在瀏覽器裡（測試）時預設中文；測試可以先設 globalThis.__LANG__ 再載入模組。

export type Lang = 'zh' | 'en';

const KEY = 'sched-evolution:lang';
const isLang = (x: unknown): x is Lang => x === 'zh' || x === 'en';

function detect(): Lang {
  const forced = (globalThis as { __LANG__?: unknown }).__LANG__;
  if (isLang(forced)) return forced;
  if (typeof location === 'undefined') return 'zh';
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (isLang(q)) {
      localStorage.setItem(KEY, q);
      return q;
    }
    const saved = localStorage.getItem(KEY);
    if (isLang(saved)) return saved;
  } catch {
    // 停用了儲存空間
  }
  return 'en';
}

export const lang: Lang = detect();
export const isEn = lang === 'en';

/** 依目前語言回傳其中一個 */
export const tr = (zh: string, en: string): string => (isEn ? en : zh);

/** 欄位之間的間隔：中文用全形空白，英文用 · */
export const gap = isEn ? ' · ' : '　';

/** 列舉的分隔：中文用頓號，英文用逗號 */
export const sep = (): string => (isEn ? ', ' : '、');
export const joinList = (xs: string[]): string => xs.join(sep());

/** 換語言：改網址的 ?lang= 並重新載入（保留 hash） */
export function setLang(l: Lang): void {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    // 寫不進去也沒關係，網址上的參數會帶著
  }
  const url = new URL(location.href);
  url.searchParams.set('lang', l);
  location.href = url.toString();
}
