// 英文介面：切到英文後，讀者看得到的字串不能還有中文（漏翻的會在這裡被抓到）。
// 語言在模組載入時決定，所以先設 globalThis.__LANG__ 再動態載入。
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { NSEC_PER_SEC } from '../src/core/types.ts';

type Mods = {
  i18n: typeof import('../src/i18n.ts');
  scenarios: typeof import('../src/scenarios.ts');
  variants: typeof import('../src/variants.ts');
  glossary: typeof import('../src/ui/glossary.ts');
  inspect: typeof import('../src/ui/inspect.ts');
  engine: typeof import('../src/core/engine.ts');
  recorder: typeof import('../src/ref/recorder.ts');
};
let m: Mods;

beforeAll(async () => {
  vi.resetModules();
  (globalThis as { __LANG__?: string }).__LANG__ = 'en';
  m = {
    i18n: await import('../src/i18n.ts'),
    scenarios: await import('../src/scenarios.ts'),
    variants: await import('../src/variants.ts'),
    glossary: await import('../src/ui/glossary.ts'),
    inspect: await import('../src/ui/inspect.ts'),
    engine: await import('../src/core/engine.ts'),
    recorder: await import('../src/ref/recorder.ts'),
  };
  delete (globalThis as { __LANG__?: string }).__LANG__;
});

// 中日韓文字與全形標點
const CJK = /[　-〿一-鿿＀-￯]/;
const noCjk = (where: string, s: string) => {
  const i = s.search(CJK);
  expect(i, `${where}: …${s.slice(Math.max(0, i - 80), i + 40)}…`).toBe(-1);
};

/** 物件裡所有字串（略過識別用的欄位） */
function strings(x: unknown, path: string, out: [string, string][] = []): [string, string][] {
  const SKIP = new Set(['id', 'compare', 'variant', 'key', 'name', 'tasks']);
  if (typeof x === 'string') out.push([path, x]);
  else if (Array.isArray(x)) x.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (x && typeof x === 'object')
    for (const [k, v] of Object.entries(x)) if (!SKIP.has(k) && typeof v !== 'function') strings(v, `${path}.${k}`, out);
  return out;
}

test('語言是英文', () => {
  expect(m.i18n.lang).toBe('en');
  expect(m.i18n.tr('中', 'en')).toBe('en');
});

test('情境的說明、結論、開關說明都有英文', () => {
  for (const sc of m.scenarios.scenarios) for (const [p, s] of strings(sc, sc.id)) noCjk(p, s);
});

test('排程器說明與開關說明都有英文', () => {
  for (const v of m.variants.variants) for (const [p, s] of strings(v, v.id)) noCjk(p, s);
});

test('名詞表都有英文，名稱不重複', () => {
  const { terms, glossaryHtml } = m.glossary;
  for (const t of terms) {
    noCjk(`${t.name}.name`, t.name);
    noCjk(`${t.name}.def`, t.def);
    for (const k of t.match) noCjk(`${t.name}.match`, k);
  }
  expect(new Set(terms.map((t) => t.name)).size).toBe(terms.length);
  noCjk('glossaryHtml', glossaryHtml());
});

test('term() 用中文的鍵也查得到英文定義', () => {
  const html = m.glossary.term('wakeup latency', '喚醒延遲');
  expect(html).toContain('data-term="wakeup latency"');
  noCjk('term', html);
});

describe('決策說明', () => {
  // 每個排程器：預設值，加上每個開關各關一次
  const cases = () =>
    m.variants.variants.flatMap((v) =>
      [m.variants.defaultFlags(v), ...v.features.map((f) => ({ ...m.variants.defaultFlags(v), [f.key]: false }))].map((flags) => ({ v, flags })),
    );

  test('每個情境、每個排程器的每一個決策都沒有中文', () => {
    let n = 0;
    for (const sc of m.scenarios.scenarios) {
      for (const { v, flags } of cases()) {
        const rec = new m.recorder.RunRecorder();
        new m.engine.Simulator(v.make(flags), v.tasks(sc.tasks, flags), { duration: 2 * NSEC_PER_SEC, hz: v.hz, observers: [rec] }).run();
        const ctx = { family: v.family, names: sc.tasks.map((t) => t.name), color: () => '', flags, events: rec.events };
        const where = `${sc.id} ${v.id} ${m.variants.changedFlags(v, flags).join(',') || 'default'}`;
        for (let i = 0; i < rec.events.length; i++) {
          const d = m.inspect.renderDecision(ctx, i, true);
          noCjk(`${where} #${i} title`, d.title);
          noCjk(`${where} #${i} html`, d.html);
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(1000);
  }, 120_000);
});
