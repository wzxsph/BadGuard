import type { SignalDefinition } from "./types";

export const SIGNAL_DEFINITIONS: SignalDefinition[] = [
  {
    id: "low-rebound",
    title: "今天又来抄底啦",
    signalName: "日线KDJ低位金叉 + 成交量放大",
    stance: "观察",
    summary: "低位刚有点动静，量也跟着探头。可以围观，别急着把键盘拍冒烟。"
  },
  {
    id: "trend-strength",
    title: "勇敢散户向前冲",
    signalName: "MACD金叉 + 站回5/10日均线",
    stance: "观察",
    summary: "趋势像是把鞋带系上了，但冲之前先看看路面是不是湿的。"
  },
  {
    id: "oversold-repair",
    title: "跌麻了，先看修复",
    signalName: "RSI低位回升 + BOLL下轨收回",
    stance: "观察",
    summary: "从地板上坐起来不等于马上起飞，但至少不是继续躺平。"
  },
  {
    id: "risk-filter",
    title: "别冲了，先喝口水",
    signalName: "跌破均线 / 放量下跌 / KDJ高位死叉",
    stance: "谨慎",
    summary: "市场递来一张小纸条：手慢一点，仓位轻一点，心跳稳一点。"
  }
];

export const PHILOSOPHY =
  "不算命，不喊单，不替任何人按买卖键。BadGuard 只是把日线留下的痕迹摊在纸上：哪里像在修复，哪里像在转强，哪里像在提醒散户先别上头。看懂趋势，比预测涨跌更重要。";

export const DISCLAIMERS = [
  "本页面仅用于个人学习和技术指标观察，只描述历史交易数据形成的状态，不构成投资建议或收益承诺。",
  "所有信号只标记为观察或谨慎，不代表任何交易指令；请结合基本面、流动性、仓位和个人风险承受能力判断。"
];
