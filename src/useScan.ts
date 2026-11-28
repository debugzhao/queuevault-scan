// 轮询主循环：快照 + 队列请求 + 两条链的增量日志 + 跨链关联，统一放进一个 state。
// 任何一路 RPC 失败都只记错误、保留上一次的数据，页面不会白屏。
import { useEffect, useRef, useState } from "react";
import {
  type Ev,
  type RedeemRequest,
  type Snapshot,
  type Trace,
  buildTraces,
  makeScanners,
  readRequests,
  readSnapshot,
} from "./chain";
import { type ChainKey, DEPLOYMENTS, POLL_MS } from "./config";
import { history } from "./history";

export const HEATMAP_CELLS = 120;
const MAX_EVENTS = 2_000;
/** buildTraces 关联三段链路所需的事件，不参与裁剪（数量与实验轮数同阶，几百到几千条） */
const TRACE_EVENTS = new Set(["Repaid", "RedeemRequested", "SettleRequested", "Skipped", "ReactiveSettled"]);

export type ScanState = {
  snap?: Snapshot;
  requests: RedeemRequest[];
  events: Ev[]; // 新的在前
  traces: Trace[];
  syncing: number; // 历史日志同步进度 0..1
  coveredSeconds: number; // 历史已回填覆盖的最近时长（秒，两条链取较短者）
  errors: Partial<Record<ChainKey, string>>;
  updatedAt?: number;
};

const msg = (e: unknown) => (e as Error).message.split("\n")[0].slice(0, 160);

export function useScan(): ScanState {
  const [state, setState] = useState<ScanState>({ requests: [], events: [], traces: [], syncing: 0, coveredSeconds: 0, errors: {} });
  const events = useRef<Map<string, Ev>>(new Map());
  const last = useRef<{ snap?: Snapshot; requests: RedeemRequest[]; traces: Trace[] }>({ requests: [], traces: [] });

  useEffect(() => {
    if (!DEPLOYMENTS) return;
    let alive = true;
    const scanners = makeScanners();
    // 先放入预打包的历史事件（实验期的完整链路），实时扫描到同一条日志时按 key 去重
    for (const e of history.events) events.current.set(e.key, e);

    const tick = async () => {
      const errors: Partial<Record<ChainKey, string>> = {};
      const [snapR, ...scanR] = await Promise.allSettled([readSnapshot(), ...scanners.map((s) => s.step())]);

      if (snapR.status === "fulfilled") {
        last.current.snap = snapR.value.snap;
        if (snapR.value.lasnaError) errors.lasna = snapR.value.lasnaError;
      } else errors.base = msg(snapR.reason);

      scanR.forEach((r, i) => {
        if (r.status === "fulfilled") for (const e of r.value) events.current.set(e.key, e);
        else errors[scanners[i].chain] ??= msg(r.reason);
      });

      const all = [...events.current.values()].sort(
        (a, b) => (b.ts ?? 0) - (a.ts ?? 0) || Number(b.block - a.block) || b.logIndex - a.logIndex,
      );
      // 只裁剪非关键事件：拼链路要用的还款、排队、react、回调必须全部保留。
      // 否则回填扫到大量较新的事件后，较早的回调和 react 会被挤掉，链路拼不起来，延迟图变空
      let kept = 0;
      for (let i = 0; i < all.length; i++) {
        if (TRACE_EVENTS.has(all[i].name) || ++kept <= MAX_EVENTS) continue;
        events.current.delete(all[i].key);
        all.splice(i--, 1);
      }

      const snap = last.current.snap;
      const [reqR, trR] = await Promise.allSettled([
        snap ? readRequests(snap.vault.tail, HEATMAP_CELLS) : Promise.resolve(last.current.requests),
        buildTraces(all),
      ]);
      if (reqR.status === "fulfilled") last.current.requests = reqR.value;
      else errors.base ??= msg(reqR.reason);
      if (trR.status === "fulfilled") last.current.traces = trR.value;
      else errors.base ??= msg(trR.reason);

      const syncing = Math.min(...scanners.map((s) => s.progress));
      const coveredSeconds = Math.min(...scanners.map((s) => s.coveredSeconds));
      if (alive)
        setState({
          snap,
          requests: last.current.requests,
          events: all,
          traces: last.current.traces,
          syncing,
          coveredSeconds,
          errors,
          updatedAt: Date.now(),
        });
      return Object.keys(errors).length > 0;
    };

    let timer: ReturnType<typeof setTimeout>;
    let backoff = 0;
    const loop = async () => {
      const failed = await tick();
      // 历史回填期间每轮间隔 300ms（每轮回填段数见 makeScanners），回填完按 POLL_MS 轮询；
      // 出错（多半是公共 RPC 429）时指数退避，最长 15 秒
      backoff = failed ? Math.min(15_000, Math.max(1_000, backoff * 2)) : 0;
      const behind = scanners.some((s) => s.progress < 1);
      if (alive) timer = setTimeout(loop, backoff || (behind ? 300 : POLL_MS));
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  return state;
}

/** 定时刷新，用于「N seconds ago」和进行中链路的计时 */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
