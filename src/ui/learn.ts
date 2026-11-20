// 學習路線（#/learn/<章>）：一次只顯示一章，左邊章節目錄，底下上一章／下一章。
// 章節的標題與問題寫在 index.html 每個 <article class="chapter"> 的 data-title / data-q。

interface Chapter {
  id: string;
  /** 附錄（名詞速查）：不編號、不在上一章／下一章的串列裡 */
  appendix: boolean;
  title: string;
  q: string;
  el: HTMLElement;
}

let chapters: Chapter[] = [];
let tocLinks: HTMLAnchorElement[] = [];

const href = (id: string) => `#/learn/${id}`;

export function mountLearn(): void {
  chapters = [...document.querySelectorAll<HTMLElement>('#page-learn article.chapter')].map((el) => ({
    id: el.dataset.ch!,
    appendix: el.classList.contains('appendix'),
    title: el.dataset.title!,
    q: el.dataset.q!,
    el,
  }));
  const main = chapters.filter((c) => !c.appendix);
  const n = main.length;

  // 內文的章節引用寫成 <a class="chref" data-ref="章節 id">，章號在這裡填，插入新章時不用手動改
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a.chref')) {
    const i = main.findIndex((c) => c.id === a.dataset.ref);
    if (i < 0) throw new Error(`chref 指到不存在的章節：${a.dataset.ref}`);
    a.href = href(a.dataset.ref!);
    a.textContent = `第 ${i + 1} 章`;
  }

  const toc = document.getElementById('learnToc')!;
  tocLinks = chapters.map((c) => {
    const li = document.createElement('li');
    if (c.appendix) li.className = 'toc-appendix';
    const a = document.createElement('a');
    a.href = href(c.id);
    a.innerHTML = `<span class="toc-n">${c.appendix ? '附' : main.indexOf(c) + 1}</span><span class="toc-t"><b>${c.title}</b><span>${c.q}</span></span>`;
    li.append(a);
    toc.append(li);
    return a;
  });

  chapters.forEach((c) => {
    const i = main.indexOf(c);
    const head = document.createElement('header');
    head.className = 'ch-head';
    const no = c.appendix ? '附錄' : `第 ${i + 1} 章 <span>/ ${n}</span>`;
    head.innerHTML = `<div class="ch-no">${no}</div><h1>${c.title}</h1><p class="ch-q">${c.q}</p>`;
    c.el.prepend(head);
    if (c.appendix) return;

    const prev = main[i - 1];
    const next = main[i + 1];
    const foot = document.createElement('div');
    foot.className = 'ch-nav';
    foot.innerHTML =
      (prev ? `<a class="ch-prev" href="${href(prev.id)}"><span>← 上一章</span><b>${prev.title}</b></a>` : '<span></span>') +
      (next
        ? `<a class="ch-next" href="${href(next.id)}"><span>下一章 →</span><b>${next.title}</b></a>`
        : `<a class="ch-next" href="#/sim"><span>讀完了 →</span><b>到模擬頁把各代 CPU scheduler 並排比較</b></a>`);
    c.el.append(foot);
  });

  mountReasons();
}

/** 顯示某一章；找不到就顯示第一章。回傳實際顯示的章節 id。 */
export function showChapter(id: string | undefined): string {
  const cur = chapters.find((c) => c.id === id) ?? chapters.find((c) => !c.appendix)!;
  for (const c of chapters) c.el.hidden = c !== cur;
  tocLinks.forEach((a, i) => a.classList.toggle('active', chapters[i] === cur));
  // 手機上目錄是一列橫向捲動的圓點，把目前這章捲進畫面
  const active = tocLinks[chapters.indexOf(cur)]!;
  const ol = active.closest('ol')!;
  if (ol.scrollWidth > ol.clientWidth) ol.scrollLeft = active.offsetLeft - ol.clientWidth / 2 + active.offsetWidth / 2;
  document.title = `${cur.title}｜排程器演進模擬`;
  return cur.id;
}

/** 介紹頁「為什麼要了解 CPU scheduler」的三張卡片：點一張，下面顯示那一段 */
function mountReasons(): void {
  const box = document.getElementById('w-reasons');
  if (!box) return;
  const btns = [...box.querySelectorAll<HTMLButtonElement>('.reason')];
  const bodies = [...document.querySelectorAll<HTMLElement>('.reason-body [data-r]')];
  const pick = (r: string) => {
    for (const b of btns) b.classList.toggle('on', b.dataset.r === r);
    for (const p of bodies) p.hidden = p.dataset.r !== r;
  };
  for (const b of btns) b.addEventListener('click', () => pick(b.dataset.r!));
  pick('0');
}
