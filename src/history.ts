// 预打包的历史事件：构建时读入 bench/results/history.json（npm run history 导出），页面一打开就有实验期的完整链路和延迟图。
// 为什么需要：浏览器从新往旧回填历史，Base 每 200ms 一个块、公共 RPC 每次只能查 200 块，离实验越久回填越慢，
// 评委打开页面时延迟图多半还是空的。导出的是原始日志，这里用和实时扫描同一套 ABI 解码，口径一致；没有文件就是空历史。
import { type Abi, type Address, type Hex, decodeEventLog } from "viem";
import { baseEventsAbi, lasnaEventsAbi } from "./abi";
import type { Ev } from "./chain";
import { type ChainKey, IS_DEVNET } from "./config";

type RawLog = { c: ChainKey; a: Address; t: Hex[]; d: Hex; h: Hex; b: number; i: number; s?: number };
type HistoryFile = {
  generatedAt: string;
  coverage: { base: { to: number }; lasna: { to: number } };
  logs: RawLog[];
};

const files = import.meta.glob<HistoryFile>("../../bench/results/history.json", { eager: true, import: "default" });
// devnet 用的是本地链，测试网的历史对它没有意义
const file = IS_DEVNET ? undefined : Object.values(files)[0];

const ABI: Record<ChainKey, Abi> = { base: baseEventsAbi as Abi, lasna: lasnaEventsAbi as Abi };

export const history: {
  generatedAt?: string;
  events: Ev[];
  /** 各条链已导出到哪个区块：实时回填只需要补这之后的部分 */
  coveredTo: Partial<Record<ChainKey, bigint>>;
} = {
  generatedAt: file?.generatedAt,
  coveredTo: file ? { base: BigInt(file.coverage.base.to), lasna: BigInt(file.coverage.lasna.to) } : {},
  events: (file?.logs ?? []).flatMap((l): Ev[] => {
    try {
      const { eventName, args } = decodeEventLog({ abi: ABI[l.c], data: l.d, topics: l.t as [Hex, ...Hex[]] });
      if (!eventName) return [];
      return [
        {
          key: `${l.c}:${l.h}:${l.i}`, // 与 Scanner 生成的 key 相同，实时扫到同一条日志时自动去重
          chain: l.c,
          name: eventName,
          args: (args ?? {}) as Record<string, unknown>,
          address: l.a,
          tx: l.h,
          block: BigInt(l.b),
          logIndex: l.i,
          ts: l.s,
        },
      ];
    } catch {
      return [];
    }
  }),
};
