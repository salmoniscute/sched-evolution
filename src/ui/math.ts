/// <reference types="vite/client" />
// 公式排版（KaTeX）。
// HTML 裡寫 <span class="tex">…</span>（行內）或 <div class="tex-block">…</div>（置中獨立一行），
// 內容是 TeX 原始碼；renderMathIn() 在頁面載入時換成排好的公式。
// 小圖裡會變的公式用 tex() 直接產生 HTML。
import katex from 'katex';
import 'katex/dist/katex.min.css';

export function tex(src: string, display = false): string {
  return katex.renderToString(src, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'html' });
}

export function renderMathIn(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('.tex, .tex-block').forEach((el) => {
    if (el.dataset.rendered) return;
    katex.render(el.textContent ?? '', el, { displayMode: el.classList.contains('tex-block'), throwOnError: false, strict: 'ignore', output: 'html' });
    el.dataset.rendered = '1';
  });
}
