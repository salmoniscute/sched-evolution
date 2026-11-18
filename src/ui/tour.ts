// 模擬頁的導覽：一步一步把注意力帶到某個區塊。被框起來的區塊照樣可以點，
// 暗下來的背景只是陰影，不會擋住滑鼠。第一次進模擬頁時自動開始，之後按「導覽」重看。

export interface TourStep {
  /** 要框起來的元素；找不到就跳過這一步 */
  target: () => HTMLElement | null;
  title: string;
  body: string;
}

const DONE_KEY = 'sched-evolution.tourDone';

export function tourDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === '1';
  } catch {
    return false;
  }
}

function markDone(): void {
  try {
    localStorage.setItem(DONE_KEY, '1');
  } catch {
    /* 私密視窗等情況寫不進去，下次會再出現一次，沒關係 */
  }
}

let stopCurrent: (() => void) | null = null;

export function startTour(steps: TourStep[]): void {
  stopCurrent?.();
  const pop = document.createElement('div');
  pop.className = 'tour-pop';
  pop.setAttribute('role', 'dialog');
  document.body.append(pop);
  let i = 0;
  let focus: HTMLElement | null = null;

  const place = () => {
    if (!focus) return;
    const r = focus.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const left = Math.max(8, Math.min(r.left, document.documentElement.clientWidth - w - 8));
    // 放在下面；下面放不下就放上面；都放不下就貼在視窗底部
    let top = r.bottom + 10;
    if (top + h > window.innerHeight - 8) top = r.top - h - 10;
    const bar = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
    if (top < bar + 8) top = window.innerHeight - h - 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  };

  const show = (k: number) => {
    focus?.classList.remove('tour-focus');
    // 找不到目標的步驟往同一個方向跳過
    const dir = k >= i ? 1 : -1;
    while (k >= 0 && k < steps.length && !steps[k]!.target()) k += dir;
    if (k < 0 || k >= steps.length) return stop();
    i = k;
    const st = steps[i]!;
    focus = st.target()!;
    focus.classList.add('tour-focus');
    pop.innerHTML = `<div class="tour-head"><b>${st.title}</b><span class="tour-n">${i + 1} / ${steps.length}</span></div>
      <p>${st.body}</p>
      <div class="tour-btns">
        <button type="button" data-t="skip" class="quiet">結束導覽</button>
        <span class="grow"></span>
        ${i > 0 ? '<button type="button" data-t="prev">上一步</button>' : ''}
        <button type="button" data-t="next" class="primary">${i === steps.length - 1 ? '開始玩' : '下一步'}</button>
      </div>`;
    focus.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    place();
    pop.querySelector<HTMLButtonElement>('[data-t="next"]')!.focus({ preventScroll: true });
  };

  const stop = () => {
    focus?.classList.remove('tour-focus');
    pop.remove();
    window.removeEventListener('scroll', place);
    window.removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey);
    stopCurrent = null;
    markDone();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') stop();
  };

  pop.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.t;
    if (t === 'skip') stop();
    else if (t === 'prev') show(i - 1);
    else if (t === 'next') (i === steps.length - 1 ? stop() : show(i + 1));
  });
  window.addEventListener('scroll', place, { passive: true });
  window.addEventListener('resize', place);
  document.addEventListener('keydown', onKey);
  stopCurrent = stop;
  show(0);
}

/** 離開模擬頁時收起導覽 */
export function stopTour(): void {
  stopCurrent?.();
}
