import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSnippets } from '../src/source/build.ts';
import { elixirUrl, extractSnippet } from '../src/source/extract.ts';
import { manifest } from '../src/source/manifest.ts';
import snippets from '../src/source/snippets.json';

const root = join(import.meta.dirname, '..');

describe('原始碼片段', () => {
  it('snippets.json 和 kernel-src/ 一致（改了 manifest 要重跑 npm run extract-snippets）', () => {
    const fresh = buildSnippets((tag, file) => readFileSync(join(root, 'kernel-src', tag, file), 'utf8'));
    expect(fresh).toEqual(snippets);
  });

  it('每個 mark 指到的行真的含那段字串', () => {
    const all = fresh();
    for (const spec of manifest) {
      const s = all[spec.id]!;
      for (const [k, needle] of Object.entries(spec.marks ?? {})) {
        expect(s.lines[s.marks[k]! - s.start], `${spec.id} ${k}`).toContain(needle);
      }
    }
  });

  it('函式從回傳型別那行開始、到第 0 欄的 } 結束', () => {
    const src = ['int x;', 'static void', 'foo(int a)', '{', '\tif (a) {', '\t}', '}', ''].join('\n');
    const s = extractSnippet({ id: 't', tag: 'v6.6', file: 'f.c', fn: 'foo', marks: { if: 'if (a)' } }, src);
    expect([s.start, s.end]).toEqual([2, 7]);
    expect(s.marks.if).toBe(5);
  });

  it('宣告（以 ; 結尾）不算定義', () => {
    const src = ['static void foo(int a);', '', 'static void foo(int a)', '{', '}'].join('\n');
    const s = extractSnippet({ id: 't', tag: 'v6.6', file: 'f.c', fn: 'foo' }, src);
    expect(s.start).toBe(3);
  });

  it('mark 出現不只一次就報錯', () => {
    const src = ['void foo(void)', '{', '\tbar();', '\tbar();', '}'].join('\n');
    expect(() => extractSnippet({ id: 't', tag: 'v6.6', file: 'f.c', fn: 'foo', marks: { b: 'bar();' } }, src)).toThrow(/2 次/);
  });

  it('Elixir 的 2.4 版本名稱沒有 v', () => {
    expect(elixirUrl('v2.4.0', 'kernel/sched.c', 10)).toBe('https://elixir.bootlin.com/linux/2.4.0/source/kernel/sched.c#L10');
    expect(elixirUrl('v2.6.24', 'kernel/sched_fair.c', 1, 3)).toContain('/linux/v2.6.24/source/kernel/sched_fair.c#L1-L3');
  });
});

function fresh() {
  return buildSnippets((tag, file) => readFileSync(join(root, 'kernel-src', tag, file), 'utf8')).snippets;
}
