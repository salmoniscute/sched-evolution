// 決策檢視：論文版 EEVDF（src/sched/eevdf-paper.ts）的說明。
// 快照和 kernel 的 EEVDF 同形狀，但圓點是 request 的 ve（不是 vruntime），線段是 [ve, vd]。
import { NSEC_PER_MSEC as MS, type Ns } from '../core/types.ts';
import { NICE_0_LOAD } from '../core/weights.ts';
import { joinList, tr } from '../i18n.ts';
import { rowsOf, type Explained, type InspectCtx, type Row } from './inspect.ts';

const ms = (ns: Ns, digits = 3) => `${(ns / MS).toFixed(digits)}ms`;
const sms = (ns: Ns, digits = 3) => (ns > 0.5 ? '+' : ns < -0.5 ? '−' : '') + ms(Math.abs(ns), digits);
const dur = (ns: Ns) => (ns >= MS ? `${+(ns / MS).toFixed(2)}ms` : `${Math.round(ns / 1000)}µs`);

export function explainPaper(ctx: InspectCtx, idx: number): Explained {
  const e = ctx.events[idx]!;
  const rows = rowsOf(e.snapshot);
  const nm = (pid: number | null) => (pid === null ? 'idle' : (ctx.names[pid - 1] ?? `pid ${pid}`));
  const row = (pid: number | null) => rows.find((r) => r.pid === pid);
  const where = (r: Row) => tr(`ve 在 V ${sms(r.rel)}、vd 在 V ${sms(r.dl!)}`, `ve at V ${sms(r.rel)}, vd at V ${sms(r.dl!)}`);
  const why: string[] = [];

  // ---- 醒來，但 curr 繼續跑：論文只在 quantum 開始時分配 ----
  if (e.kind === 'wakeup') {
    const w = row(e.causePid);
    const c = row(e.next);
    const verb = e.cause === 'new' ? tr('加入', 'joins') : tr('醒來', 'wakes up');
    const title = tr(`${nm(e.causePid)} ${verb}，${nm(e.next)} 繼續跑`, `${nm(e.causePid)} ${verb}, ${nm(e.next)} keeps running`);
    const plain = tr(
      `${nm(e.causePid)} ${verb}了，但論文的演算法只在每一小段時間（quantum）結束時重新分配，${nm(e.next)} 先把這一段跑完。`,
      `${nm(e.causePid)} ${verb}, but the paper's algorithm only reallocates when the current short time unit (quantum) ends, so ${nm(e.next)} finishes this one first.`,
    );
    if (w) {
      why.push(
        e.cause === 'new'
          ? tr(`${nm(w.pid)} 第一次加入，lag 是 0，V 不變，第一個 request 從 ve = V 開始，${where(w)}。`, `${nm(w.pid)} joins for the first time with lag 0, so V does not move and its first request starts at ve = V; ${where(w)}.`)
          : tr(
              `${nm(w.pid)} 重新加入：照論文式 (19)，V 減掉它的 lag ÷ 加入後的總權重，它自己只帶回 W/(W + w) 的 lag。新 request 的 ${where(w)}。`,
              `${nm(w.pid)} rejoins: by Eq. (19) of the paper, V moves by its lag divided by the total weight after joining, and it keeps only W/(W + w) of that lag itself. Its new request has ${where(w)}.`,
            ),
      );
      why.push(
        w.eligible
          ? tr(`ve ≤ V，request 已經 eligible，但要等目前的 quantum 結束才會重新分配（最多 0.1ms）。`, `ve ≤ V, so the request is already eligible, but it waits for the current quantum to end before anything is reallocated (at most 0.1ms).`)
          : tr(
              `ve 在 V 右邊：它之前拿得比應得的多，request 還沒 eligible，要等 V 走到 ve 才能被分配。`,
              `ve is to the right of V: it received more than its share earlier, so the request is not eligible yet and cannot be allocated until V reaches ve.`,
            ),
      );
    }
    if (c && c !== w) why.push(tr(`${nm(c.pid)} 的 request：${where(c)}，這個 quantum 由它用完。`, `${nm(c.pid)}'s request: ${where(c)}; it uses up this quantum.`));
    return { title, plain, why, rows, chosen: e.next };
  }

  // ---- 分配一個 quantum ----
  const title = e.prev === e.next ? tr(`下一個 quantum 還是 ${nm(e.next)}`, `Next quantum still goes to ${nm(e.next)}`) : `${nm(e.prev)} → ${nm(e.next)}`;
  const p = row(e.prev);
  /** prev 的 request 剛換新：vd − ve 剛好是一個完整的 r/w */
  const renewed = p ? Math.abs(p.dl! - p.rel - (p.slice * NICE_0_LOAD) / p.weight) <= 1 : false;
  let reason: string;
  if (e.cause === 'sleep') {
    reason = tr(`${nm(e.causePid)} 去睡了，`, `${nm(e.causePid)} went to sleep; `);
    why.push(
      tr(
        `${nm(e.causePid)} 去睡，離開競爭：照論文式 (18)，V 加上它離開時的 lag ÷ 剩下的總權重，它多拿或少拿的由其他程式按權重分攤。`,
        `${nm(e.causePid)} goes to sleep and leaves the competition: by Eq. (18) of the paper, V moves by its lag at leaving divided by the remaining total weight, so whatever it took too much or too little is shared by the others in proportion to their weights.`,
      ),
    );
  } else if (e.cause === 'tick' && p && renewed) {
    reason = tr(`${nm(p.pid)} 的 request（${dur(p.slice)}）用完了，`, `${nm(p.pid)} has used up its request (${dur(p.slice)}); `);
    why.push(
      tr(
        `${nm(p.pid)} 的 request 用完，發出下一個：ve 接在用掉的服務後面（ve + u/w），vd = ve + r/w。新的 ${where(p)}。`,
        `${nm(p.pid)}'s request is used up and it issues the next one: ve continues after the service used (ve + u/w) and vd = ve + r/w. The new request has ${where(p)}.`,
      ),
    );
  } else if (e.cause === 'tick') {
    reason = tr(`${nm(e.prev)} 的這個 quantum（0.1ms）到期了，`, `${nm(e.prev)}'s quantum (0.1ms) has expired; `);
    why.push(
      tr(
        `quantum 到期。${nm(e.prev)} 的 request 還沒用完，但論文每個 quantum 都重新分配一次。`,
        `The quantum expires. ${nm(e.prev)}'s request is not finished, but the paper reallocates at every quantum.`,
      ),
    );
  } else {
    const verb = e.cause === 'new' ? tr('加入', 'joins') : tr('醒來', 'wakes up');
    reason = tr(`CPU 閒著，${nm(e.causePid)} ${verb}，`, `The CPU is idle and ${nm(e.causePid)} ${verb}; `);
    why.push(tr(`${nm(e.causePid)} ${verb}時 CPU 是閒的，馬上分配。`, `The CPU is idle when ${nm(e.causePid)} ${verb}, so it allocates right away.`));
  }

  const elig = rows.filter((r) => r.eligible);
  const notElig = rows.filter((r) => !r.eligible);
  const c = row(e.next);
  if (c) {
    const others = elig.filter((r) => r.pid !== c.pid);
    why.push(
      others.length
        ? tr(
            `eligible 的 request（ve ≤ V）有 ${joinList([c, ...others].map((r) => nm(r.pid)))}，deadline 最早的是 ${nm(c.pid)}（vd 在 V ${sms(c.dl!)}），把下一個 quantum 給它。`,
            `The eligible requests (ve ≤ V) belong to ${joinList([c, ...others].map((r) => nm(r.pid)))}; the earliest deadline is ${nm(c.pid)}'s (vd at V ${sms(c.dl!)}), so it gets the next quantum.`,
          )
        : tr(
            `只有 ${nm(c.pid)} 的 request 是 eligible（ve ≤ V），下一個 quantum 給它，vd 在 V ${sms(c.dl!)}。`,
            `Only ${nm(c.pid)}'s request is eligible (ve ≤ V), so it gets the next quantum; vd is at V ${sms(c.dl!)}.`,
          ),
    );
  } else {
    why.push(tr('沒有程式在競爭，CPU 閒置。', 'No task is competing, so the CPU goes idle.'));
  }
  if (notElig.length)
    why.push(
      tr(
        `${joinList(notElig.map((r) => nm(r.pid)))} 的 request 還沒 eligible（ve 在 V 右邊），這次不參加比較。`,
        `The requests of ${joinList(notElig.map((r) => nm(r.pid)))} are not eligible yet (ve is to the right of V) and take no part this time.`,
      ),
    );

  const choice = c
    ? e.prev === e.next
      ? tr(`在有資格的程式裡，${nm(c.pid)} 的截止時間還是最早，繼續跑。`, `among the tasks allowed to run, ${nm(c.pid)} still has the earliest deadline and keeps running.`)
      : tr(`在有資格的程式裡挑截止時間最早的 ${nm(c.pid)}。`, `among the tasks allowed to run, it picks ${nm(c.pid)}, which has the earliest deadline.`)
    : tr('沒有程式要跑。', 'no task wants to run.');
  return { title, plain: reason + choice, why, rows, chosen: e.next };
}
