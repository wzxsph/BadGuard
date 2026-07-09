import type { SignalDefinition } from "./types";

export const SIGNAL_DEFINITIONS: SignalDefinition[] = [
  {
    id: "low-rebound",
    title: "低位反弹观察",
    signalName: "日线KDJ低位金叉 + 成交量放大",
    stance: "观察",
    summary: "KDJ在20附近或以下形成金叉，同时成交量明显高于近期均值。"
  },
  {
    id: "trend-strength",
    title: "趋势转强观察",
    signalName: "MACD金叉 + 站回5/10日均线",
    stance: "观察",
    summary: "MACD由弱转强，收盘价重新站回5日与10日均线。"
  },
  {
    id: "oversold-repair",
    title: "超跌修复观察",
    signalName: "RSI低位回升 + BOLL下轨收回",
    stance: "观察",
    summary: "RSI从低位回升，股价从BOLL下轨附近重新收回。"
  },
  {
    id: "risk-filter",
    title: "风险过滤榜",
    signalName: "跌破均线 / 放量下跌 / KDJ高位死叉",
    stance: "谨慎",
    summary: "近期均线结构走弱、放量下跌，或KDJ在高位出现死叉。"
  }
];

export const PHILOSOPHY =
  "技术指标不是预测未来，而是把价格、成交量与波动留下的痕迹变得更容易观察。看懂趋势，比预测涨跌更重要。";

export const DISCLAIMERS = [
  "本页面只描述历史交易数据形成的技术状态，不构成投资建议。",
  "所有信号仅标记为观察或谨慎，需要结合基本面、流动性与个人风险承受能力判断。"
];
