// 說明文字裡引用的模擬數字。寫成 <span data-sim="情境 排程器 [±開關] [@時間] 指標">數字</span>，
// test/sim-claims.test.ts 會照標記重跑模擬，並以字面上的單位與小數位數四捨五入後比對，
// 改了模擬核心或工作負載而忘了改文字，測試就會失敗。scenarios.ts 裡用 src/sim-tag.ts 的 simIn() 產生標記。
//
//   情境：scenarios.ts 的 id
//   排程器：variants.ts 的 id，或 gps（流體模型，只有 .share）
//   開關：-KEY 關掉、+KEY 打開，其餘用預設值
//   時間：@1s、@500ms，預設 2s（和模擬頁相同）
//   指標：switches（context switch 次數）、ops（每次 schedule() 的平均成本），
//        或 <task>.<share | lat | p99 | max | lag | lagmin | lagmax>，task 用名稱
//        （lat / p99 / max 是喚醒延遲；lag 是相對 GPS 的 lag 在結束時的值）
import { Simulator } from './core/engine.ts';
import { summarize, type Summary } from './core/metrics.ts';
import { NSEC_PER_MSEC, NSEC_PER_SEC, NSEC_PER_USEC, type Ns } from './core/types.ts';
import { GpsShadow, simulateGps } from './ref/gps.ts';
import { scenarios } from './scenarios.ts';
import { defaultFlags, variants, type Flags } from './variants.ts';

export interface ClaimSpec {
  scenario: string;
  variant: string;
  flags: Record<string, boolean>;
  duration: Ns;
  task: string | null;
  metric: string;
}

const TASK_METRICS = ['share', 'lat', 'p99', 'max', 'lag', 'lagmin', 'lagmax'];
const RUN_METRICS = ['switches', 'ops'];
const TIME_METRICS = ['lat', 'p99', 'max', 'lag', 'lagmin', 'lagmax'];

export function parseSpec(spec: string): ClaimSpec {
  const [scenario, variant, ...rest] = spec.trim().split(/\s+/);
  const last = rest.pop();
  if (!scenario || !variant || !last) throw new Error(`data-sim="${spec}"：至少要有情境、排程器、指標`);
  if (!scenarios.some((s) => s.id === scenario)) throw new Error(`data-sim="${spec}"：沒有情境 ${scenario}`);
  if (variant !== 'gps' && !variants.some((v) => v.id === variant)) throw new Error(`data-sim="${spec}"：沒有排程器 ${variant}`);

  const flags: Record<string, boolean> = {};
  let duration = 2 * NSEC_PER_SEC;
  for (const tok of rest) {
    const d = /^@(\d+(?:\.\d+)?)(s|ms)$/.exec(tok);
    if (d) duration = Number(d[1]) * (d[2] === 's' ? NSEC_PER_SEC : NSEC_PER_MSEC);
    else if (/^[+-]\w+$/.test(tok)) flags[tok.slice(1)] = tok[0] === '+';
    else throw new Error(`data-sim="${spec}"：看不懂 ${tok}`);
  }

  const dot = last.lastIndexOf('.');
  const task = dot < 0 ? null : last.slice(0, dot);
  const metric = dot < 0 ? last : last.slice(dot + 1);
  if (task === null ? !RUN_METRICS.includes(metric) : !TASK_METRICS.includes(metric))
    throw new Error(`data-sim="${spec}"：沒有指標 ${last}`);
  if (variant === 'gps' && metric !== 'share') throw new Error(`data-sim="${spec}"：gps 只有 .share`);
  return { scenario, variant, flags, duration, task, metric };
}

interface Run {
  summary: Summary | null;
  gpsShare: number[];
  lag: { end: number; min: number; max: number }[];
}

const cache = new Map<string, Run>();

function run(c: ClaimSpec): Run {
  const key = JSON.stringify([c.scenario, c.variant, c.flags, c.duration]);
  const hit = cache.get(key);
  if (hit) return hit;
  const sc = scenarios.find((s) => s.id === c.scenario)!;
  let r: Run;
  if (c.variant === 'gps') {
    const g = simulateGps(sc.tasks, { duration: c.duration });
    r = { summary: null, gpsShare: g.tasks.map((t) => t.runtime / c.duration), lag: [] };
  } else {
    const def = variants.find((v) => v.id === c.variant)!;
    for (const k of Object.keys(c.flags))
      if (!def.features.some((f) => f.key === k)) throw new Error(`${c.variant} 沒有開關 ${k}`);
    const flags: Flags = { ...defaultFlags(def), ...c.flags };
    const shadow = new GpsShadow();
    const res = new Simulator(def.make(flags), def.tasks(sc.tasks, flags), { duration: c.duration, hz: def.hz, observers: [shadow] }).run();
    const summary = summarize(res);
    const states = new Map(shadow.states.map((st) => [st.pid, st]));
    const lag = summary.tasks.map((t) => {
      const st = states.get(t.pid);
      return { end: shadow.lag(t.pid), min: st?.lagMin ?? 0, max: st?.lagMax ?? 0 };
    });
    r = { summary, gpsShare: [], lag };
  }
  cache.set(key, r);
  return r;
}

/** 指標的原始值：時間是 ns，比例是 0–1，次數是整數 */
export function measure(c: ClaimSpec): number {
  const r = run(c);
  const sc = scenarios.find((s) => s.id === c.scenario)!;
  if (c.task === null) {
    const s = r.summary!;
    return c.metric === 'switches' ? s.nr_switches : s.opsPerSchedule;
  }
  const i = sc.tasks.findIndex((t) => t.name === c.task);
  if (i < 0) throw new Error(`情境 ${c.scenario} 沒有 task ${c.task}`);
  if (c.variant === 'gps') return r.gpsShare[i]!;
  const t = r.summary!.tasks[i]!;
  switch (c.metric) {
    case 'share':
      return t.share;
    case 'lat':
      return t.wakeupLatencyAvg;
    case 'p99':
      return t.wakeupLatencyP99;
    case 'max':
      return t.wakeupLatencyMax;
    case 'lag':
      return r.lag[i]!.end;
    case 'lagmin':
      return r.lag[i]!.min;
    default:
      return r.lag[i]!.max;
  }
}

/**
 * 字面上的數字和模擬結果是否一致。單位與小數位數取自字面：「1.96 ms」比到 0.01ms，「623 µs」比到 1µs。
 * 時間指標沒寫單位時當作 µs（表格裡的「0」）；比例要寫 %。
 */
export function checkText(c: ClaimSpec, text: string, value: number): { ok: boolean; want: string } {
  const m = /^\s*([−-]?)\s*(\d+(?:\.\d+)?)\s*(µs|ms|s|%)?\s*$/.exec(text);
  if (!m) return { ok: false, want: `看不懂的數字「${text}」` };
  const [, sign, num, unit] = m;
  const isTime = TIME_METRICS.includes(c.metric);
  let scaled: number;
  if (c.metric === 'share') {
    if (unit !== '%') return { ok: false, want: '比例要寫 %' };
    scaled = value * 100;
  } else if (isTime) {
    const u = unit ?? 'µs';
    if (u === '%') return { ok: false, want: '時間不能寫 %' };
    scaled = value / (u === 'µs' ? NSEC_PER_USEC : u === 'ms' ? NSEC_PER_MSEC : NSEC_PER_SEC);
  } else {
    if (unit) return { ok: false, want: '次數不寫單位' };
    scaled = value;
  }
  const digits = num!.split('.')[1]?.length ?? 0;
  const want = scaled.toFixed(digits);
  const got = (sign ? '-' : '') + num;
  const ok = Number(want) === Number(got);
  return { ok, want: `${want.replace('-', '−')}${unit ?? ''}` };
}

/** 從 HTML 字串裡找出所有標記 */
export function findClaims(html: string): { spec: string; text: string }[] {
  return [...html.matchAll(/<span data-sim="([^"]+)">([^<]*)<\/span>/g)].map((m) => ({ spec: m[1]!, text: m[2]! }));
}
