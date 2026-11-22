// 學習路線第 4 章的小圖（比較情境 1）：N 個 CPU-bound task 時，每次 schedule() 的成本。
// 數字用模擬核心現場跑（src/cost.ts），成本是「比較／走訪節點的次數」的模型，不是 CPU cycle。
import { COST_NS, COST_VARIANTS, costCurves, type CostPoint } from '../cost.ts';
import { joinList, tr } from '../i18n.ts';
import { variants } from '../variants.ts';

const SHORT: Record<string, string> = {
  'on-v2.4.0': 'O(n) 2.4',
  'o1-v2.6.0': 'O(1) 2.6.0',
  'cfs-v2.6.24': 'CFS v2.6.24',
  'eevdf-v6.6': 'EEVDF v6.6',
};

const f1 = (x: number) => (Math.abs(x - Math.round(x)) < 0.05 ? String(Math.round(x)) : x.toFixed(1));

function costWidget(box: HTMLElement): void {
  let curves: Map<string, CostPoint[]> | null = null;
  let idx = COST_NS.indexOf(64);
  let zoom = false;

  box.innerHTML = `<div class="w-btns">
      <button type="button" data-z="0">${tr('全部', 'All')}</button>
      <button type="button" data-z="1">${tr('放大看 O(1)、CFS、EEVDF', 'Zoom in on O(1), CFS, EEVDF')}</button>
    </div>
    <div class="w-sliders">
      <label class="w-slice s4">${tr('runqueue 上有', 'tasks on the runqueue:')} <input type="range" min="0" max="${COST_NS.length - 1}" step="1" aria-label="${tr('task 數', 'number of tasks')}"><output></output>${tr(' 個 task', '')}</label>
    </div>
    <div class="w-svg"></div>
    <table class="mini eq-ex w-cost"></table>
    <p class="w-out"></p>`;
  const svgBox = box.querySelector<HTMLElement>('.w-svg')!;
  const table = box.querySelector<HTMLElement>('table')!;
  const out = box.querySelector<HTMLElement>('.w-out')!;
  const input = box.querySelector<HTMLInputElement>('input')!;
  const zbtn = [...box.querySelectorAll<HTMLButtonElement>('button[data-z]')];
  input.addEventListener('input', () => {
    idx = Number(input.value);
    render();
  });
  for (const b of zbtn)
    b.addEventListener('click', () => {
      zoom = b.dataset.z === '1';
      render();
    });

  const render = () => {
    curves ??= costCurves();
    const n = COST_NS[idx]!;
    input.value = String(idx);
    input.nextElementSibling!.textContent = String(n);
    zbtn.forEach((b) => b.classList.toggle('on', (b.dataset.z === '1') === zoom));

    const X0 = 56;
    const X1 = 520;
    const Y0 = 200;
    const Y1 = 16;
    const maxAll = Math.max(...[...curves.values()].flat().map((p) => p.total));
    const yMax = zoom ? 30 : Math.ceil(maxAll / 50) * 50;
    const x = (i: number) => X0 + (i / (COST_NS.length - 1)) * (X1 - X0);
    const y = (v: number) => Y0 - (Math.min(v, yMax * 1.04) / yMax) * (Y0 - Y1);
    const step = zoom ? 10 : 50;
    const grid = Array.from({ length: Math.floor(yMax / step) + 1 }, (_, k) => k * step)
      .map((v) => `<line class="dg-grid" x1="${X0}" x2="${X1}" y1="${y(v)}" y2="${y(v)}"/><text class="dg-s" x="${X0 - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`)
      .join('');
    const xt = COST_NS.map((m, i) => `<text class="dg-s" x="${x(i)}" y="${Y0 + 16}" text-anchor="middle">${m}</text>`).join('');
    const paths: string[] = [];
    const labels: { y: number; cls: string; text: string }[] = [];
    COST_VARIANTS.forEach((id, k) => {
      const pts = curves!.get(id)!;
      const cls = `s${k + 1}`;
      const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join(' ');
      const dots = pts.map((p, i) => `<circle class="dg-dot" cx="${x(i)}" cy="${y(p.total)}" r="${i === idx ? 4.5 : 2.5}"/>`).join('');
      paths.push(`<g class="${cls}"><polyline class="dg-lag" points="${line}"/>${dots}</g>`);
      // 超出放大範圍的線，標籤放在右上角並加箭頭
      const last = pts.at(-1)!.total;
      const over = last > yMax;
      labels.push({ y: over ? Y1 + 4 : y(last) + 4, cls, text: `${SHORT[id]}${over ? ' ↑' : ''}` });
    });
    // 線的終點靠得太近時，標籤由下往上推開，至少隔 14px
    labels.sort((a, b) => b.y - a.y);
    for (let i = 1; i < labels.length; i++) labels[i]!.y = Math.min(labels[i]!.y, labels[i - 1]!.y - 14);
    const labelSvg = labels.map((l) => `<text class="dg-l ${l.cls}" x="${X1 + 8}" y="${l.y}" style="fill:var(--c)">${l.text}</text>`).join('');
    svgBox.innerHTML = `<svg viewBox="0 0 640 228" role="img" aria-label="${tr('每次 schedule() 的成本隨 task 數的變化', 'Cost of each schedule() as the number of tasks grows')}">
      <defs><clipPath id="cost-clip"><rect x="${X0 - 6}" y="${Y1 - 6}" width="${X1 - X0 + 12}" height="${Y0 - Y1 + 12}"/></clipPath></defs>
      ${grid}
      <line class="dg-ref" x1="${x(idx)}" x2="${x(idx)}" y1="${Y1}" y2="${Y0}"/>
      <line class="dg-axis" x1="${X0}" x2="${X1}" y1="${Y0}" y2="${Y0}"/>
      <g clip-path="url(#cost-clip)">${paths.join('')}</g>
      ${labelSvg}
      <text class="dg-s" x="${X0 - 44}" y="${Y1 - 4}">${tr('次數', 'steps')}</text>
      <text class="dg-s" x="${X1 + 24}" y="${Y0 + 16}">${tr('task 數', 'tasks')}</text>
      ${xt}
    </svg>`;

    const rows = COST_VARIANTS.map((id, k) => {
      const p = curves!.get(id)![idx]!;
      return `<tr><td><span class="swatch" style="background:var(--series-${k + 1})"></span>${variants.find((v) => v.id === id)!.title}</td>
        <td>${f1(p.by.pick)}</td><td>${f1(p.by.queue)}</td><td>${p.by.recalc ? f1(p.by.recalc) : '—'}</td><td><b>${f1(p.total)}</b></td></tr>`;
    }).join('');
    table.innerHTML = `<thead><tr><th>${tr(`${n} 個 task`, `${n} tasks`)}</th><th>${tr('挑選', 'pick')}</th><th>${tr('進出佇列', 'enqueue / dequeue')}</th><th>${tr('重算時間片', 'recalculate slices')}</th><th>${tr('每次 schedule() 合計', 'total per schedule()')}</th></tr></thead><tbody>${rows}</tbody>`;

    const at = (id: string) => curves!.get(id)![idx]!.total;
    const on = at('on-v2.4.0');
    const o1 = at('o1-v2.6.0');
    out.textContent =
      n === 1
        ? tr('只有一個 task 時，大家都差不多。把拉桿往右拖。', 'With only one task they are all about the same. Drag the slider to the right.')
        : tr(
            `${n} 個 task 時，2.4 每次 schedule() 要做 ${f1(on)} 次比較，是 2.6.0 的 ${f1(on / o1)} 倍；CFS 和 EEVDF 是 ${joinList([f1(at('cfs-v2.6.24')), f1(at('eevdf-v6.6'))])} 次，task 數每翻一倍，只多兩三次。`,
            `With ${n} tasks, each schedule() in 2.4 makes ${f1(on)} comparisons, ${f1(on / o1)}× as many as 2.6.0. CFS and EEVDF make ${f1(at('cfs-v2.6.24'))} and ${f1(at('eevdf-v6.6'))}, only two or three more each time the number of tasks doubles.`,
          );
  };
  render();
}

export function mountCostWidget(): void {
  const box = document.getElementById('w-cost');
  if (box) costWidget(box);
}
