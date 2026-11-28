// 数据层：两条链的只读客户端、状态快照、队列请求、增量扫日志、按 originTxHash 跨链关联。
// 全部是链上实时数据，没有任何模拟值；读不到就显示空状态。
import { type Abi, type Address, type Hex, type PublicClient, createPublicClient, decodeEventLog, defineChain, http, toHex } from "viem";
import { baseEventsAbi, lasnaEventsAbi, poolAbi, reactiveAbi, usdcAbi, vaultAbi } from "./abi";
import {
  BASE_RPC,
  type ChainKey,
  DEPLOYMENTS,
  IS_DEVNET,
  LASNA_RPC,
  LOG_CHUNK,
  LOOKBACK,
  MULTICALL3,
  hasReactive,
  hasSettler,
} from "./config";
import { history } from "./history";

const baseChain = defineChain({
  id: 84532,
  name: "Base Sepolia",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [BASE_RPC] } },
  ...(IS_DEVNET ? {} : { contracts: { multicall3: { address: MULTICALL3 } } }),
});

export const clients: Record<ChainKey, PublicClient> = {
  // 测试网上用 multicall 把十几个 view 合成一次请求，减轻公共 RPC 的限流压力
  base: createPublicClient({ chain: baseChain, transport: http(BASE_RPC), batch: { multicall: !IS_DEVNET } }) as PublicClient,
  lasna: createPublicClient({ transport: http(LASNA_RPC) }) as PublicClient,
};

// ───────────── 状态快照 ─────────────

export type Snapshot = {
  at: number;
  baseBlock: bigint;
  vault: {
    totalAssets: bigint;
    totalSupply: bigint;
    assetsPerShare: bigint; // 1 份额（12 位小数）值多少 USDC 最小单位
    cash: bigint;
    queueCash: bigint;
    instantCash: bigint;
    poolPosition: bigint;
    pendingCount: bigint;
    head: bigint;
    tail: bigint;
    totalQueued: bigint;
    totalClaimable: bigint;
    seq: bigint;
    bufferBps: number;
  };
  pool: { liquidity: bigint; owed: bigint; totalAssets: bigint; aprBps: bigint };
  reactive?: {
    lasnaBlock: bigint;
    paused: boolean;
    subscribed: boolean;
    remainingCallbacks: bigint;
    reactCount: bigint;
    callbackCount: bigint;
    maxPerCallback: bigint;
    minSettleAssets: bigint;
    callbackGasLimit: bigint;
    windowCount: number;
    maxReactsPerWindow: number;
    windowSeconds: number;
    balance: bigint;
    mirror: { seq: bigint; queueCash: bigint; headId: bigint; headRemaining: bigint; pendingCount: bigint };
  };
  settlerBalance?: bigint;
};

type R = <T>(address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) => Promise<T>;
const reader =
  (c: PublicClient): R =>
  (address, abi, functionName, args = []) =>
    c.readContract({ address, abi, functionName, args } as never) as never;

let lastReactive: Snapshot["reactive"];

/** Base 读失败直接抛错（调用方保留上一次快照）；Lasna 读失败只记错误，沿用上一次的 Reactive 状态 */
export async function readSnapshot(): Promise<{ snap: Snapshot; lasnaError?: string }> {
  const d = DEPLOYMENTS!;
  const rb = reader(clients.base);
  const v = <T>(fn: string, args?: readonly unknown[]) => rb<T>(d.vault, vaultAbi, fn, args);
  const p = <T>(fn: string) => rb<T>(d.pool, poolAbi, fn);

  const [baseBlock, vault, pool, settlerBalance] = await Promise.all([
    clients.base.getBlockNumber(),
    Promise.all([
      v<bigint>("totalAssets"),
      v<bigint>("totalSupply"),
      v<bigint>("convertToAssets", [10n ** 12n]),
      rb<bigint>(d.usdc, usdcAbi, "balanceOf", [d.vault]),
      v<bigint>("queueCash"),
      v<bigint>("instantCash"),
      v<bigint>("poolPosition"),
      v<bigint>("pendingCount"),
      v<bigint>("head"),
      v<bigint>("tail"),
      v<bigint>("totalQueuedAssets"),
      v<bigint>("totalClaimable"),
      v<bigint>("snapshotSeq"),
      v<number>("BUFFER_BPS"),
    ]),
    Promise.all([p<bigint>("liquidity"), p<bigint>("owed"), p<bigint>("totalAssets"), p<bigint>("APR_BPS")]),
    hasSettler() ? clients.base.getBalance({ address: d.settler }) : Promise.resolve(undefined),
  ]);

  const snap: Snapshot = {
    at: Date.now(),
    baseBlock,
    vault: {
      totalAssets: vault[0],
      totalSupply: vault[1],
      assetsPerShare: vault[2],
      cash: vault[3],
      queueCash: vault[4],
      instantCash: vault[5],
      poolPosition: vault[6],
      pendingCount: vault[7],
      head: vault[8],
      tail: vault[9],
      totalQueued: vault[10],
      totalClaimable: vault[11],
      seq: vault[12],
      bufferBps: Number(vault[13]),
    },
    pool: { liquidity: pool[0], owed: pool[1], totalAssets: pool[2], aprBps: pool[3] },
    settlerBalance,
  };

  if (!hasReactive()) return { snap };
  try {
    snap.reactive = await readReactive();
    lastReactive = snap.reactive;
    return { snap };
  } catch (e) {
    snap.reactive = lastReactive;
    return { snap, lasnaError: (e as Error).message.split("\n")[0].slice(0, 160) };
  }
}

async function readReactive(): Promise<NonNullable<Snapshot["reactive"]>> {
  const d = DEPLOYMENTS!;
  {
    const rl = reader(clients.lasna);
    const r = <T>(fn: string) => rl<T>(d.reactive, reactiveAbi, fn);
    const x = await Promise.all([
      clients.lasna.getBlockNumber(),
      r<boolean>("paused"),
      r<boolean>("subscribed"),
      r<bigint>("remainingCallbacks"),
      r<bigint>("reactCount"),
      r<bigint>("callbackCount"),
      r<bigint>("maxPerCallback"),
      r<bigint>("minSettleAssets"),
      r<bigint>("callbackGasLimit"),
      r<number>("windowCount"),
      r<number>("maxReactsPerWindow"),
      r<number>("windowSeconds"),
      clients.lasna.getBalance({ address: d.reactive }),
      r<readonly bigint[]>("mirror"),
    ]);
    const m = x[13];
    return {
      lasnaBlock: x[0],
      paused: x[1],
      subscribed: x[2],
      remainingCallbacks: x[3],
      reactCount: x[4],
      callbackCount: x[5],
      maxPerCallback: x[6],
      minSettleAssets: x[7],
      callbackGasLimit: x[8],
      windowCount: Number(x[9]),
      maxReactsPerWindow: Number(x[10]),
      windowSeconds: Number(x[11]),
      balance: x[12],
      mirror: { seq: m[0], queueCash: m[1], headId: m[3], headRemaining: m[4], pendingCount: m[6] },
    };
  }
}

// ───────────── 队列请求（热力图） ─────────────

export type RedeemRequest = {
  id: number;
  owner: Address;
  receiver: Address;
  assetsTotal: bigint;
  assetsRemaining: bigint;
  requestedAt: number;
  settledAt: number;
};

const requestCache = new Map<number, RedeemRequest>();

/** 读最近 count 个请求。已结清的请求不会再变，只读一次；未结清的每轮重读 */
export async function readRequests(tail: bigint, count: number): Promise<RedeemRequest[]> {
  const d = DEPLOYMENTS!;
  const last = Number(tail) - 1;
  const first = Math.max(1, last - count + 1);
  const ids: number[] = [];
  for (let id = first; id <= last; id++) {
    const c = requestCache.get(id);
    if (!c || c.assetsRemaining > 0n) ids.push(id);
  }
  const rb = reader(clients.base);
  const rows = await Promise.all(
    ids.map((id) =>
      rb<{ owner: Address; receiver: Address; assetsTotal: bigint; assetsRemaining: bigint; requestedAt: bigint; settledAt: bigint }>(
        d.vault,
        vaultAbi,
        "getRequest",
        [BigInt(id)],
      ),
    ),
  );
  rows.forEach((r, i) =>
    requestCache.set(ids[i], {
      id: ids[i],
      owner: r.owner,
      receiver: r.receiver,
      assetsTotal: r.assetsTotal,
      assetsRemaining: r.assetsRemaining,
      requestedAt: Number(r.requestedAt),
      settledAt: Number(r.settledAt),
    }),
  );
  const out: RedeemRequest[] = [];
  for (let id = first; id <= last; id++) out.push(requestCache.get(id)!);
  return out;
}

// ───────────── 增量扫日志 ─────────────

export type Ev = {
  key: string;
  chain: ChainKey;
  name: string;
  args: Record<string, unknown>;
  address: Address;
  tx: Hex;
  block: bigint;
  logIndex: number;
  ts?: number; // 区块时间戳（秒）
};

const tsCache = new Map<string, number>();

/** Base Sepolia 出块间隔（实测 815 个区块跨 163 秒） */
export const BASE_BLOCK_S = 0.2;
/** 离最新区块这么近的 Lasna 事件才逐块精确查时间戳（实时链路要准）；更早的用推算 */
const EXACT_WINDOW_S = 300;

/**
 * 区块时间推算：最新区块的时间戳 −（区块号差 × 平均出块间隔）。
 * 回填到实验时段时一次会冒出几百个事件，逐块 getBlock 会瞬间打出几百个请求（Base 公共 RPC 直接 429，Lasna 一轮要 10 秒）。
 * Base 出块间隔固定 0.2s，推算误差 ±1s；Lasna 约 1.07s/块（用部署区块到最新区块的平均值），离最新区块越远误差越大，
 * 所以最近 5 分钟内的 Lasna 事件仍逐块精确查询。推算值只用于「N 秒前」、排序和两段拆分；端到端延迟一律用 Base 区块差。
 */
type Anchor = { block: bigint; ts: number; rate: number; at: number };
const anchors: Partial<Record<ChainKey, Anchor>> = {};
async function refreshAnchor(chain: ChainKey, floor: bigint) {
  const a = anchors[chain];
  if (a && Date.now() - a.at < 60_000) return;
  const head = await clients[chain].getBlock();
  let rate = chain === "base" ? BASE_BLOCK_S : a?.rate;
  if (rate === undefined) {
    const f = await clients[chain].getBlock({ blockNumber: floor });
    const n = Number(head.number! - floor);
    rate = n > 0 ? (Number(head.timestamp) - Number(f.timestamp)) / n : 1;
  }
  anchors[chain] = { block: head.number!, ts: Number(head.timestamp), rate, at: Date.now() };
}

export async function blockTs(chain: ChainKey, block: bigint): Promise<number> {
  const a = anchors[chain];
  if (a) {
    const ageS = Number(a.block - block) * a.rate;
    if (chain === "base" || ageS > EXACT_WINDOW_S) return a.ts - Math.round(ageS);
  }
  const k = `${chain}:${block}`;
  if (!tsCache.has(k)) tsCache.set(k, Number((await clients[chain].getBlock({ blockNumber: block })).timestamp));
  return tsCache.get(k)!;
}

/** 事件里自带时间戳的直接用，省一次 getBlock */
const tsFromArgs = (a: Record<string, unknown>) => (a.timestamp ?? a.requestedAt) as bigint | undefined;

/**
 * 日志扫描器：先跟上最新区块（实时），再从新往旧回填历史。
 *
 * 为什么不从部署区块正向扫：Base Sepolia 200ms 一个块，一天约 43 万块，而 sepolia.base.org 每次 getLogs 最多 200 块。
 * 部署几天后正向扫要上万次请求，公共 RPC 很快返回 429，「同步日志」卡在 0%，最新事件和实时链路都出不来。
 * 现在首屏只扫最新一段，实时数据立刻可用；历史按「新 → 旧」限速回填，最近的链路最先出现。
 */
const BLOCK_SECONDS: Record<ChainKey, number> = { base: 0.2, lasna: 1 };

export class Scanner {
  private fwd?: bigint; // 实时：下一个要扫的区块
  private back?: bigint; // 回填：下一段的上界（含），小于 floor 表示回填完成
  private floor = 0n; // 回填下限：部署区块
  private liveStart = 0n;
  head = 0n;
  constructor(
    readonly chain: ChainKey,
    private readonly addresses: Address[],
    private readonly abi: Abi,
    private readonly startBlock?: number,
    /** 每次 step 最多回填几段：限速，避免触发公共 RPC 的 429 */
    private readonly backfillChunks = 2,
  ) {}

  /** 已回填覆盖的最近时长（秒）：按出块间隔估算（Base 0.2s、Lasna 1s），回填完成时为 Infinity */
  get coveredSeconds() {
    if (this.back === undefined) return 0;
    if (this.back < this.floor) return Infinity;
    return Number(this.head - this.back) * BLOCK_SECONDS[this.chain];
  }

  /** 历史回填进度 0..1，用于显示「同步日志」 */
  get progress() {
    if (this.back === undefined) return 0;
    const total = this.liveStart - this.floor;
    if (total <= 0n || this.back < this.floor) return 1;
    return Math.min(1, Number(this.liveStart - 1n - this.back) / Number(total));
  }

  private async scan(from: bigint, to: bigint): Promise<Ev[]> {
    const logs = await clients[this.chain].getLogs({ address: this.addresses, fromBlock: from, toBlock: to });
    const out: Ev[] = [];
    for (const l of logs) {
      let decoded: { eventName: string; args: unknown };
      try {
        decoded = decodeEventLog({ abi: this.abi, data: l.data, topics: l.topics });
      } catch {
        continue; // ERC20 Transfer、LiquiditySnapshot 等不展示的事件
      }
      const args = (decoded.args ?? {}) as Record<string, unknown>;
      const t = tsFromArgs(args);
      out.push({
        key: `${this.chain}:${l.transactionHash}:${l.logIndex}`,
        chain: this.chain,
        name: decoded.eventName,
        args,
        address: l.address,
        tx: l.transactionHash!,
        block: l.blockNumber!,
        logIndex: l.logIndex!,
        ts: t !== undefined ? Number(t) : undefined,
      });
    }
    return out;
  }

  async step(): Promise<Ev[]> {
    const span = LOG_CHUNK[this.chain];
    this.head = await clients[this.chain].getBlockNumber();
    if (this.fwd === undefined) {
      const start = this.startBlock && this.startBlock > 0 ? BigInt(this.startBlock) : this.head - LOOKBACK;
      this.floor = start > 0n ? start : 0n;
      this.liveStart = this.head - span + 1n > this.floor ? this.head - span + 1n : this.floor;
      this.fwd = this.liveStart;
      this.back = this.liveStart - 1n;
    }
    await refreshAnchor(this.chain, this.floor);
    const out: Ev[] = [];

    // ① 实时：跟上最新区块。正常每轮只需 1 段；失败直接抛出，由上层记错并退避
    for (let i = 0; i < 4; i++) {
      const from: bigint = this.fwd!;
      if (from > this.head) break;
      const to: bigint = from + span - 1n < this.head ? from + span - 1n : this.head;
      out.push(...(await this.scan(from, to)));
      this.fwd = to + 1n; // 每段成功后才推进，失败的段下一轮重扫
    }

    // ② 回填：从新往旧，每批 4 段并发（串行时每段约 0.6s 往返，太慢；全并发会触发 429）。
    //    只推进到「从最新一段开始连续成功」的位置，失败的段下一轮重扫
    let budget = this.backfillChunks;
    while (budget > 0 && this.back! >= this.floor) {
      const ranges: [bigint, bigint][] = [];
      for (let to = this.back!; ranges.length < Math.min(4, budget) && to >= this.floor; ) {
        const from: bigint = to - span + 1n > this.floor ? to - span + 1n : this.floor;
        ranges.push([from, to]);
        to = from - 1n;
      }
      budget -= ranges.length;
      const res = await Promise.allSettled(ranges.map(([f, t]) => this.scan(f, t)));
      let ok = 0;
      for (const r of res) {
        if (r.status !== "fulfilled") break;
        out.push(...r.value);
        ok++;
      }
      if (ok > 0) this.back = ranges[ok - 1][0] - 1n;
      if (ok < ranges.length) break;
    }

    // 没自带时间戳的事件按区块补齐（同一区块只算一次；多数是本地推算，只有最近 5 分钟内的 Lasna 区块才查 RPC，每批 8 个并发）
    const blocks = [...new Set(out.filter((e) => e.ts === undefined).map((e) => e.block))];
    const tsOf = new Map<bigint, number>();
    for (let i = 0; i < blocks.length; i += 8) {
      const batch = blocks.slice(i, i + 8);
      const res = await Promise.allSettled(batch.map((b) => blockTs(this.chain, b)));
      res.forEach((r, j) => r.status === "fulfilled" && tsOf.set(batch[j], r.value));
    }
    for (const e of out) if (e.ts === undefined) e.ts = tsOf.get(e.block);
    return out;
  }
}

export function makeScanners(): Scanner[] {
  const d = DEPLOYMENTS!;
  const base = [d.vault, d.pool, ...(hasSettler() ? [d.settler] : [])];
  // 每轮回填段数：Base 每段只有 200 块（约 40 秒），要多扫几段；Lasna 每段 5,000 块（约 83 分钟），少扫几段就够。
  // 段与段之间串行发送，实测约 2 次请求/秒，不会触发公共 RPC 的 429
  // 有预打包历史（history.json）时，回填只补导出之后的区块
  const from = (chain: ChainKey, deployed?: number) => {
    const covered = history.coveredTo[chain];
    const start = BigInt(deployed ?? 0);
    return Number(covered !== undefined && covered + 1n > start ? covered + 1n : start);
  };
  const s = [new Scanner("base", base, baseEventsAbi as Abi, from("base", d.baseBlock), 8)];
  if (hasReactive()) s.push(new Scanner("lasna", [d.reactive], lasnaEventsAbi as Abi, from("lasna", d.lasnaBlock), 3));
  return s;
}

// ───────────── 跨链关联：Base 触发 → Lasna react → Base 回调 ─────────────

export type Trace = {
  origin: Hex;
  source: "REPAY" | "SNAPSHOT";
  originEvent?: string; // 触发交易里能识别的事件，例如 Repaid / RedeemRequested
  t0?: number; // Base 触发交易的区块时间（秒，Base 侧为推算值，±1s）
  b0?: bigint; // Base 触发交易所在区块
  e2eS?: number; // ⭐ 链上端到端：(回调区块 − 触发区块) × 0.2s，与 bench 报告同口径
  react?: Ev; // Lasna SettleRequested
  skipped?: Ev; // Lasna Skipped
  callback?: Ev; // Base ReactiveSettled
  t1?: number;
  t2?: number;
  status: "SETTLED" | "IN FLIGHT" | "SKIPPED" | "WAITING";
};

const hexOf = (x: unknown) => toHex(x as bigint, { size: 32 }) as Hex;
const originBlock = new Map<string, bigint>();

/**
 * 触发交易所在区块：先从已扫到的同一笔交易的事件里找（快照触发的交易里总有 RedeemRequested / Deposit / RedeemSettled 等事件），
 * 找不到才查回执，并且每轮最多查 budget 次，避免一次性打出几十个 getTransactionReceipt 被限流
 */
async function originBlockOf(origin: Hex, known: Ev | undefined, budget: { left: number }): Promise<bigint | undefined> {
  if (known) return known.block;
  if (originBlock.has(origin)) return originBlock.get(origin);
  if (budget.left-- <= 0) return undefined;
  try {
    const r = await clients.base.getTransactionReceipt({ hash: origin });
    originBlock.set(origin, r.blockNumber);
    return r.blockNumber;
  } catch {
    return undefined;
  }
}

/**
 * 以 originTxHash 为主键把三段串起来。来源：
 * - 每个 Repaid 都是一次潜在的触发（即使 Reactive 判定跳过，也能看到 SKIPPED）
 * - 每个 SettleRequested / ReactiveSettled 都带 originTxHash（可能来自金库快照，例如排队交易本身）
 */
export async function buildTraces(all: Ev[], limit = 60): Promise<Trace[]> {
  const byOrigin = new Map<string, Trace>();
  // 同一笔 Base 交易里任意一个事件都能给出区块号；命名优先用 Repaid / RedeemRequested
  const baseByTx = new Map<string, Ev>();
  for (const e of all)
    if (e.chain === "base") {
      const cur = baseByTx.get(e.tx);
      if (!cur || e.name === "Repaid" || e.name === "RedeemRequested") baseByTx.set(e.tx, e);
    }

  const get = (origin: Hex, src: number | "REPAY") => {
    let t = byOrigin.get(origin);
    if (!t) {
      t = { origin, source: src === "REPAY" || src === 2 ? "REPAY" : "SNAPSHOT", status: "WAITING" };
      byOrigin.set(origin, t);
    }
    return t;
  };
  for (const e of all) {
    if (e.chain === "base" && e.name === "Repaid") get(e.tx, "REPAY");
    if (e.name === "SettleRequested") get(hexOf(e.args.originTxHash), Number(e.args.source)).react = e;
    if (e.name === "Skipped") get(hexOf(e.args.originTxHash), "REPAY").skipped ??= e;
    if (e.name === "ReactiveSettled") {
      const t = get(hexOf(e.args.originTxHash), Number(e.args.source));
      if (!t.callback) t.callback = e;
    }
  }

  const sortKey = (t: Trace) => Math.max(t.callback?.ts ?? 0, t.react?.ts ?? 0, t.skipped?.ts ?? 0, baseByTx.get(t.origin)?.ts ?? 0);
  // 最新 limit 条（实时链路、事件表用）∪ 最新 limit 条已完成兑付（延迟图用）。
  // 只取最新 limit 条时，若最近全是没有回调的还款（例如轮询对照组期间 Reactive 暂停），已完成的兑付会被挤掉，延迟图变空
  const sorted = [...byOrigin.values()].sort((a, b) => sortKey(b) - sortKey(a));
  const picked = new Set([...sorted.slice(0, limit), ...sorted.filter((t) => t.callback).slice(0, limit)]);
  const traces = sorted.filter((t) => picked.has(t));
  const budget = { left: 4 };
  await Promise.all(
    traces.map(async (t) => {
      const ev = baseByTx.get(t.origin);
      t.originEvent = ev?.name === "Repaid" || ev?.name === "RedeemRequested" ? ev.name : undefined;
      t.b0 = await originBlockOf(t.origin, ev, budget);
      t.t0 = t.b0 !== undefined ? await blockTs("base", t.b0) : undefined;
      t.e2eS = t.callback && t.b0 !== undefined ? Number(t.callback.block - t.b0) * BASE_BLOCK_S : undefined;
      t.t1 = t.react?.ts;
      if (t.callback) t.t2 = t.callback.ts;
      t.status = t.callback ? "SETTLED" : t.react ? "IN FLIGHT" : t.skipped ? "SKIPPED" : "WAITING";
    }),
  );
  return traces;
}

