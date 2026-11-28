// Live Pipeline：最近一次（或搜索命中的）还款 → Lasna react → Base 回调，三节点 + 发光连线 + 同期 LiquidityTaken
import type { ReactNode } from "react";
import type { Ev, Trace } from "../chain";
import { DEPLOYMENTS } from "../config";
import { clock, secs, usdc } from "../format";
import { type T, useI18n } from "../i18n";
import type { ScanState } from "../useScan";
import { useNow } from "../useScan";
import { Badge, ChainBadge, GlassCard, Pill, TxLink } from "./ui";

const NO_ACTION_AFTER_S = 60;
const skipReason = (t: T, code: number) => (code === 1 ? t("skip.1") : code === 2 ? t("skip.2") : "—");

type NodeState = "done" | "live" | "idle";

function Node(props: {
  step: string;
  chain: "base" | "lasna";
  name: string;
  state: NodeState;
  tx?: string;
  time?: number;
  live?: boolean;
  liveLabel: string;
  badge?: ReactNode;
  rows: [string, ReactNode][];
}) {
  return (
    <div className={`node ${props.state}`}>
      <div className="node-head">
        <span className="node-step">{props.step}</span>
        <ChainBadge chain={props.chain} />
      </div>
      <div className="node-name">{props.name}</div>
      <div className={`node-time num ${props.time === undefined ? "pending" : "gradient-text"}`}>
        {props.time === undefined ? "—" : secs(props.time)}
        {props.live && <span style={{ fontSize: 14, marginLeft: 8, color: "var(--base)" }}>{props.liveLabel}</span>}
      </div>
      <div style={{ marginBottom: 8, minHeight: 22, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <TxLink chain={props.chain} hash={props.tx} />
        {props.badge}
      </div>
      {props.rows.map(([k, v]) => (
        <div className="kv" key={k}>
          <span>{k}</span>
          <span className="num">{v}</span>
        </div>
      ))}
    </div>
  );
}

const Connector = ({ on, flow }: { on: boolean; flow: boolean }) => (
  <div className={`connector ${on ? "on" : ""} ${flow ? "flow" : ""}`}>
    <div className="line" />
  </div>
);

export function Pipeline({ scan, selected, highlight }: { scan: ScanState; selected?: string; highlight: boolean }) {
  const { t } = useI18n();
  const now = useNow(100);
  const nowS = now / 1000;
  const repaids = scan.events.filter((e) => e.chain === "base" && e.name === "Repaid");
  const latest = repaids[0] ? scan.traces.find((tr) => tr.origin === repaids[0].tx) : undefined;
  const latestAge = latest?.t0 !== undefined ? nowS - latest.t0 : undefined;
  // 最近一条由 Reactive 完成的链路：优先还款触发的，其次快照触发的
  const lastSettled =
    scan.traces.find((tr) => tr.status === "SETTLED" && tr.source === "REPAY") ?? scan.traces.find((tr) => tr.status === "SETTLED");
  // 选择顺序：搜索命中 > 正在进行中的最新还款（现场演示时实时计时）> 最近一条 Reactive 完成的链路 > 最新还款。
  // 不能无条件展示最新还款：轮询对照组期间 Reactive 处于暂停状态，最新还款会显示「未触发」，误导成 Reactive 没在工作
  const latestActive =
    !!latest && (latest.status === "SETTLED" || latest.status === "IN FLIGHT" || (latestAge !== undefined && latestAge <= NO_ACTION_AFTER_S));
  const trace: Trace | undefined = selected
    ? scan.traces.find((tr) => tr.origin === selected)
    : latestActive
      ? latest
      : (lastSettled ?? latest);
  const pinned = !selected && !!latest && !!trace && trace !== latest;
  const repaid: Ev | undefined = trace ? repaids.find((e) => e.tx === trace.origin) : undefined;
  const originEv = repaid ?? (trace ? scan.events.find((e) => e.chain === "base" && e.tx === trace.origin) : undefined);

  const t0 = trace?.t0;
  const elapsed = t0 !== undefined ? nowS - t0 : undefined;
  const react = trace?.react;
  const cb = trace?.callback;
  const noAction = !!trace && !react && !trace.skipped && elapsed !== undefined && elapsed > NO_ACTION_AFTER_S;

  const reactLive = !!trace && !react && !trace.skipped && !noAction;
  const cbLive = !!react && !cb;

  // 同一笔还款期间（这次还款之后、下一次还款之前）的池子流动性去向
  const taken = repaid
    ? (() => {
        const next = repaids.filter((e) => order(e) > order(repaid)).sort((a, b) => order(a) - order(b))[0];
        return scan.events
          .filter((e) => e.name === "LiquidityTaken" && order(e) > order(repaid) && (!next || order(e) < order(next)))
          .sort((a, b) => order(a) - order(b));
      })()
    : [];

  const vault = DEPLOYMENTS?.vault.toLowerCase();
  // 同一笔交易里有 ReactiveSettled = 金库是被 Reactive 回调取回的；否则是别人调用了 settleQueue（例如轮询机器人）
  const callbackTxs = new Set(scan.events.filter((e) => e.name === "ReactiveSettled").map((e) => e.tx));
  // 某个时刻 Reactive 是否处于退订（暂停）状态：看在那之前最后一条 SubscriptionChanged
  const pausedAt = (ts?: number) => {
    if (ts === undefined) return false;
    const sc = scan.events.find((e) => e.name === "SubscriptionChanged" && e.ts !== undefined && e.ts <= ts);
    return !!sc && sc.args.subscribed === false;
  };
  const wasPaused = !!trace && !trace.react && pausedAt(trace.t0);
  const latestPaused = !!latest && pausedAt(latest.t0);
  const originKind = trace ? (trace.source === "REPAY" ? "Repaid" : (trace.originEvent ?? t("pipe.snapshot"))) : "";

  return (
    <GlassCard
      id="pipeline"
      highlight={highlight}
      error={scan.errors.base ?? scan.errors.lasna}
      title={t("pipe.title")}
      sub={
        trace ? (
          <>
            {t("pipe.sub", { kind: originKind, time: clock(t0) })}
            {pinned && (
              <div style={{ marginTop: 4 }}>
                {t(latestPaused ? "pipe.pinnedPaused" : "pipe.pinned", { time: clock(latest?.t0) })}
              </div>
            )}
          </>
        ) : (
          t("pipe.subEmpty")
        )
      }
      right={
        <>
          {selected && <Pill small>{t("pipe.searchResult")}</Pill>}
          {pinned && <Pill small>{t("pipe.pinnedPill")}</Pill>}
          {trace && <StatusBadge trace={trace} noAction={noAction} t={t} />}
        </>
      }
    >
      {!trace ? (
        <div className="empty">
          {t("pipe.empty")}
          <code className="code">bash bin/loop.sh{"\n"}# or: cd bench && npm run bench -- --rounds 3</code>
        </div>
      ) : (
        <>
          <div className="pipeline">
            <Node
              step={t("pipe.step0")}
              chain="base"
              name={trace.source === "REPAY" ? "MockPool · Repaid" : `QueueVault · ${trace.originEvent ?? t("pipe.snapshot")}`}
              state="done"
              tx={trace.origin}
              time={t0 !== undefined ? 0 : undefined}
              liveLabel={t("pipe.live")}
              rows={
                repaid
                  ? [
                      [t("pipe.repaid"), `${usdc(repaid.args.amount as bigint)} USDC`],
                      [t("pipe.liqAfter"), `${usdc(repaid.args.availableLiquidity as bigint)} USDC`],
                    ]
                  : [[t("pipe.event"), originEv?.name ?? "LiquiditySnapshot"]]
              }
            />
            <Connector on={!!react} flow={reactLive} />
            <Node
              step={t("pipe.step1")}
              chain="lasna"
              name="QueueReactive · react()"
              state={react ? "done" : reactLive ? "live" : "idle"}
              tx={react?.tx ?? trace.skipped?.tx}
              // 跨链时间戳各自取整到整秒且有时钟偏差，T1 − T0 可能为负（实测中位数 −1s）；与延迟图一致，截断到 [0, 端到端]
              time={
                react && t0 !== undefined && trace.t1 !== undefined
                  ? Math.min(trace.e2eS ?? Infinity, Math.max(0, trace.t1 - t0))
                  : reactLive
                    ? elapsed
                    : undefined
              }
              live={reactLive}
              liveLabel={t("pipe.live")}
              badge={
                trace.skipped && !react ? (
                  <Badge tone="warn" title={skipReason(t, Number(trace.skipped.args.reason))}>
                    {t("pipe.skippedBadge", { r: String(trace.skipped.args.reason) })}
                  </Badge>
                ) : noAction ? (
                  <Badge tone="warn" title={wasPaused ? t("pipe.pausedWhy") : t("pipe.noActionTitle")}>
                    {t("pipe.noAction")}
                  </Badge>
                ) : undefined
              }
              rows={
                react
                  ? [
                      [t("pipe.cashForQueue"), `${usdc(react.args.cashForQueue as bigint)} USDC`],
                      [t("pipe.headRemaining"), `${usdc(react.args.headRemaining as bigint)} USDC`],
                      [t("pipe.maxPer"), String(react.args.maxCount)],
                    ]
                  : trace.skipped
                    ? [[t("pipe.reason"), skipReason(t, Number(trace.skipped.args.reason))]]
                    : noAction
                      ? [[t("pipe.why"), wasPaused ? t("pipe.pausedWhy") : t("pipe.noActionWhy")]]
                      : [[t("pipe.status"), t("pipe.waitingReact")]]
              }
            />
            <Connector on={!!cb} flow={cbLive} />
            <Node
              step={t("pipe.step2")}
              chain="base"
              name="QueueSettler · callback"
              state={cb ? "done" : cbLive ? "live" : "idle"}
              tx={cb?.tx}
              time={cb && trace.e2eS !== undefined ? trace.e2eS : cbLive ? elapsed : undefined}
              live={cbLive}
              liveLabel={t("pipe.live")}
              rows={
                cb
                  ? [
                      [t("pipe.recalled"), `${usdc(cb.args.recalled as bigint)} USDC`],
                      [t("pipe.paid"), `${usdc(cb.args.paid as bigint)} USDC`],
                      [t("pipe.processed"), t("pipe.newHead", { n: String(cb.args.processed), head: String(cb.args.newHead) })],
                    ]
                  : [[t("pipe.status"), cbLive ? t("pipe.inFlight") : "—"]]
              }
            />
          </div>

          <div className="taken">
            <div className="card-head" style={{ marginBottom: 8 }}>
              <div>
                <div className="card-title" style={{ fontSize: 14 }}>
                  {t("pipe.takenTitle")}
                </div>
                <div className="card-sub">{t("pipe.takenSub")}</div>
              </div>
            </div>
            {taken.length === 0 ? (
              <div className="empty" style={{ padding: 16 }}>
                {t("pipe.takenEmpty")}
              </div>
            ) : (
              taken.map((e) => {
                const mine = String(e.args.lender).toLowerCase() === vault;
                const viaReactive = mine && callbackTxs.has(e.tx);
                return (
                  <div className="taken-row" key={e.key}>
                    <span className="num gradient-text" style={{ fontSize: 15 }}>
                      {t0 !== undefined && e.ts !== undefined ? secs(e.ts - t0) : "—"}
                    </span>
                    <span>
                      {viaReactive ? (
                        <Badge tone="mint">{t("pipe.takenMine")}</Badge>
                      ) : mine ? (
                        <Badge tone="base" title={t("pipe.takenMineOtherTitle")}>
                          {t("pipe.takenMineOther")}
                        </Badge>
                      ) : (
                        <Badge tone="bad">{t("pipe.takenOther")}</Badge>
                      )}
                    </span>
                    <TxLink chain="base" hash={e.tx} />
                    <span className="num" style={{ textAlign: "right", color: mine ? "var(--mint)" : "var(--bad)" }}>
                      {usdc(e.args.amount as bigint)} USDC
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </GlassCard>
  );
}

/** 事件的全局顺序：Base 上按区块号 + logIndex */
const order = (e: Ev) => Number(e.block) * 10_000 + e.logIndex;

function StatusBadge({ trace, noAction, t }: { trace: Trace; noAction: boolean; t: T }) {
  if (trace.status === "SETTLED") return <Badge tone="mint">{t("trace.settled")}</Badge>;
  if (trace.status === "IN FLIGHT") return <Badge tone="lasna">{t("trace.inFlight")}</Badge>;
  if (trace.status === "SKIPPED") return <Badge tone="warn">{t("trace.skipped")}</Badge>;
  return noAction ? <Badge tone="warn">{t("pipe.noAction")}</Badge> : <Badge tone="base">{t("trace.waiting")}</Badge>;
}
