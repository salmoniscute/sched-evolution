// 英文介面：index.html 的內文與小圖。
// 大段的內文是每個 <article> 結尾的 <template lang="en">（英文模式下整篇換掉，見 main.ts 的 applyLanguage）；
// 其他固定文字用 data-en、data-en-title、data-en-aria；小圖的字串用 tr()。
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');

// 中日韓文字與全形標點
const CJK = /[　-〿一-鿿＀-￯]/;
const where = (s: string) => {
  const i = s.search(CJK);
  return i < 0 ? '' : `…${s.slice(Math.max(0, i - 60), i + 30)}…`;
};

interface Article {
  name: string;
  open: string;
  zh: string;
  en: string | null;
}

const articles: Article[] = [...html.matchAll(/(<article\b[^>]*>)([\s\S]*?)<\/article>/g)].map((m) => {
  const open = m[1]!;
  const body = m[2]!;
  const ch = /data-ch="([^"]+)"/.exec(open)?.[1];
  const t = /<template lang="en">([\s\S]*?)<\/template>\s*$/.exec(body);
  return { name: ch ?? 'intro', open, zh: t ? body.slice(0, t.index) : body, en: t ? t[1]! : null };
});

/** 中英兩版必須一致的結構：小圖與其他 id、模擬數字的標記、章節引用、公式與區塊的數量 */
function shape(s: string) {
  const all = (re: RegExp) => [...s.matchAll(re)].map((m) => m[1]!).sort();
  const count = (re: RegExp) => (s.match(re) ?? []).length;
  return {
    ids: all(/\bid="([^"]+)"/g),
    sims: all(/data-sim="([^"]+)"/g),
    refs: all(/data-ref="([^"]+)"/g),
    links: all(/href="(http[^"]+)"/g),
    texBlocks: count(/class="tex-block"/g),
    details: count(/<details\b/g),
    figures: count(/<figure\b/g),
    tables: count(/<table\b/g),
    widgets: count(/class="widget"/g),
  };
}

test('找得到介紹頁和每一章', () => {
  expect(articles.map((a) => a.name)).toContain('intro');
  expect(articles.length).toBe(14);
});

describe.each(articles.map((a) => [a.name, a] as const))('%s', (_, a) => {
  test('有英文版，而且沒有中文', () => {
    expect(a.en, '缺 <template lang="en">').not.toBeNull();
    expect(where(a.en!)).toBe('');
  });
  test('中英兩版的結構一致', () => {
    expect(shape(a.en!)).toEqual(shape(a.zh));
  });
  if (a.name !== 'intro')
    test('章名與問題有英文', () => {
      const t = /data-title-en="([^"]+)"/.exec(a.open)?.[1];
      const q = /data-q-en="([^"]+)"/.exec(a.open)?.[1];
      expect(t && q, '缺 data-title-en / data-q-en').toBeTruthy();
      expect(where(t! + q!)).toBe('');
    });
});

test('內文以外的固定文字都有 data-en', () => {
  // 拿掉 <article> 與 <svg> 以外，看剩下的文字節點與屬性
  const rest = html.replace(/<article\b[\s\S]*?<\/article>/g, '').replace(/<head>[\s\S]*?<\/head>/, '');
  const bad: string[] = [];
  for (const m of rest.matchAll(/<([a-z]+)\b([^>]*)>([^<]*)/g)) {
    const [, , attrs, text] = m as unknown as [string, string, string, string];
    if (CJK.test(text) && !/\bdata-en="/.test(attrs)) bad.push(`${text.trim()}`);
    for (const [attr, en] of [['title', 'data-en-title'], ['aria-label', 'data-en-aria']])
      if (new RegExp(`\\b${attr}="[^"]*${CJK.source}`).test(attrs) && !attrs.includes(`${en}="`)) bad.push(`${attr}: ${attrs.trim()}`);
  }
  // 切換回中文的按鈕本來就是中文
  expect(bad.filter((b) => b !== '切換成中文')).toEqual([]);
});

/** 從 s[i] 的引號開始，跳過一個字串字面值（含 `${…}` 裡的巢狀字串），回傳結尾之後的位置 */
function skipString(s: string, i: number): number {
  const q = s[i]!;
  i++;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\') i += 2;
    else if (c === q) return i + 1;
    else if (q === '`' && c === '$' && s[i + 1] === '{') i = skipExpr(s, i + 2);
    else i++;
  }
  return i;
}
/** 跳過 `${` 之後的運算式，直到對應的 } */
function skipExpr(s: string, i: number): number {
  let depth = 1;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'" || c === '"' || c === '`') i = skipString(s, i);
    else {
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return i + 1;
      i++;
    }
  }
  return i;
}

/** 原始碼裡 tr() 以外的中文（註解、tr() 的第一個參數、throw 的錯誤訊息不算） */
function untranslated(src: string): string[] {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  let out = '';
  for (let i = 0; i < s.length; ) {
    const m = /\btr\(\s*/y;
    m.lastIndex = i;
    if (/[\w$.]/.test(s[i - 1] ?? '') === false && m.exec(s) && /['"`]/.test(s[m.lastIndex]!)) {
      out += 'tr(_';
      i = skipString(s, m.lastIndex);
    } else out += s[i++];
  }
  s = out.replace(/throw new Error\([^\n]*\n?/g, '');
  return s.split('\n').filter((l) => CJK.test(l)).map((l) => l.trim());
}

/** 要檢查的檔案：小圖與原始碼頁。模擬頁、名詞表、決策說明另有 test/i18n.test.ts 實際產生字串來檢查 */
const TS_FILES = ['learn.ts', 'start.ts', 'o1-widgets.ts', 'eevdf-widgets.ts', 'cost-widget.ts', 'source.ts', 'tour.ts'];
/** 還沒翻的（翻完一個就從這裡拿掉） */
const PENDING_TS = new Set<string>(['source.ts']);

describe.each(TS_FILES.filter((f) => !PENDING_TS.has(f)).map((f) => [f]))('src/ui/%s', (f) => {
  test('讀者看得到的字串都經過 tr()', () => {
    expect(untranslated(readFileSync(new URL(`../src/ui/${f}`, import.meta.url), 'utf8'))).toEqual([]);
  });
});

test('掃描器：tr() 的中文參數不算，其他的中文算', () => {
  expect(untranslated("x = tr('中文', 'en');")).toEqual([]);
  expect(untranslated('x = tr(`a ${f(`巢狀`)} 中`, `en`);')).toEqual([]);
  expect(untranslated("x = '沒翻';")).toEqual(["x = '沒翻';"]);
  expect(untranslated("x = tr('中', '還是中文');")).toHaveLength(1);
});
