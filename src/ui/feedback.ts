// 回饋：連到 GitHub 開新 issue，標題與內文先填好讀者正在看的頁面（章節、情境、比較的排程器、改過的開關）。
// issue 一律用英文（不管介面語言），repo 的 issue 才好統一管理；附的資訊用 id（頁面路徑、情境 id、排程器 id），不用會隨語言變的標題。
// 網站是靜態的，沒有後端；連結的 href 在讀者按下去（或聚焦）的那一刻才組，才會帶到當下的狀態。

const REPO = 'https://github.com/salmoniscute/sched-evolution';

/** 由 main.ts 提供：目前頁面的補充資訊（模擬頁的情境與排程器），一行一項 */
let extra: () => string[] = () => [];

export function feedbackUrl(): string {
  const page = location.hash.replace(/^#\//, '') || 'intro';
  const title = `Feedback: #/${page}`;
  const body = [
    '<!-- What was unclear, wrong, or could be better? -->',
    '',
    '',
    '---',
    `Page: \`#/${page}\` (${location.href})`,
    ...extra(),
    `Browser: ${navigator.userAgent}`,
  ].join('\n');
  return `${REPO}/issues/new?${new URLSearchParams({ title, body })}`;
}

/** 頁面上所有 a.feedback 在被按下或聚焦時更新 href */
export function installFeedback(context: () => string[]): void {
  extra = context;
  const refresh = (e: Event) => {
    const a = (e.target as Element | null)?.closest?.('a.feedback');
    if (a instanceof HTMLAnchorElement) a.href = feedbackUrl();
  };
  for (const type of ['pointerdown', 'focusin', 'click']) document.addEventListener(type, refresh, true);
}

/** 建一個回饋連結（新分頁開啟） */
export function feedbackLink(text: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'feedback';
  a.href = `${REPO}/issues/new`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  return a;
}
