// 說明文字裡引用的模擬數字（<span data-sim="…">），要和現在的模擬核心跑出來的一致。
// 標記的寫法見 src/sim-claims.ts。
import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { checkText, findClaims, measure, parseSpec } from '../src/sim-claims.ts';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function checkAll(where: string, claims: { spec: string; text: string }[]) {
  const bad: string[] = [];
  for (const { spec, text } of claims) {
    const c = parseSpec(spec);
    const r = checkText(c, text, measure(c));
    if (!r.ok) bad.push(`${where}「${text}」(${spec})：模擬結果是 ${r.want}`);
  }
  expect(bad).toEqual([]);
}

describe('index.html', () => {
  const claims = findClaims(html);

  test('有標記，而且沒有寫錯的標記', () => {
    expect(claims.length).toBeGreaterThan(40);
    // 標記裡不能再包其他標籤（findClaims 只認純文字）
    expect(html.match(/data-sim=/g)!.length).toBe(claims.length);
  });

  test('數字和模擬結果一致', () => checkAll('index.html', claims));
});

/** 物件裡所有的字串 */
function allStrings(x: unknown, out: string[] = []): string[] {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) for (const y of x) allStrings(y, out);
  else if (x && typeof x === 'object') for (const y of Object.values(x)) allStrings(y, out);
  return out;
}

describe.each(['zh', 'en'])('scenarios.ts（%s）', (lang) => {
  test('數字和模擬結果一致', async () => {
    vi.resetModules();
    (globalThis as { __LANG__?: string }).__LANG__ = lang;
    const { scenarios } = await import('../src/scenarios.ts');
    delete (globalThis as { __LANG__?: string }).__LANG__;
    const claims = scenarios.flatMap((sc) => allStrings(sc).flatMap(findClaims));
    expect(claims.length).toBeGreaterThan(25);
    checkAll(`scenarios.ts（${lang}）`, claims);
  });
});

describe('checkText', () => {
  const c = parseSpec('latency eevdf-v6.6 audio.lat');
  test('照字面的單位與小數位數比對', () => {
    expect(checkText(c, '623 µs', 623_400).ok).toBe(true);
    expect(checkText(c, '0.62 ms', 623_400).ok).toBe(true);
    expect(checkText(c, '624 µs', 623_400).ok).toBe(false);
    expect(checkText(c, '0', 400).ok).toBe(true);
  });
  test('負數與單位錯誤', () => {
    const lag = parseSpec('interactive cfs-v2.6.24 @1s editor.lag');
    expect(checkText(lag, '−75.6ms', -75_600_000).ok).toBe(true);
    expect(checkText(lag, '75.6ms', -75_600_000).ok).toBe(false);
    expect(checkText(parseSpec('latency gps audio.share'), '5.49', 0.0549).ok).toBe(false);
  });
  test('寫錯的標記會被擋下', () => {
    expect(() => parseSpec('latency nope audio.lat')).toThrow();
    expect(() => parseSpec('latency eevdf-v6.6 audio.speed')).toThrow();
    expect(() => parseSpec('latency gps audio.lat')).toThrow();
    expect(() => measure(parseSpec('latency eevdf-v6.6 -NO_SUCH audio.lat'))).toThrow();
  });
});
