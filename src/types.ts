export type SignalId = "low-rebound" | "trend-strength" | "oversold-repair" | "risk-filter";
export type Stance = "观察" | "谨慎";
export type DataSourceKind = "provider";

export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

export interface StockSeries {
  code: string;
  name: string;
  industry: string;
  bars: DailyBar[];
}

export interface KdjValue {
  k: number;
  d: number;
  j: number;
}

export interface MacdValue {
  dif: number;
  dea: number;
  histogram: number;
}

export interface BollValue {
  middle: number;
  upper: number;
  lower: number;
}

export interface IndicatorValues {
  kdj: KdjValue;
  macd: MacdValue;
  rsi: number;
}

export interface SignalRow {
  code: string;
  name: string;
  signalId: SignalId;
  signalName: string;
  stance: Stance;
  triggerDate: string;
  indicators: IndicatorValues;
  amount: number;
  industry: string;
  change5d: number;
  change20d: number;
  riskTags: string[];
  signalStrength: number;
}

export interface SignalDefinition {
  id: SignalId;
  title: string;
  signalName: string;
  stance: Stance;
  summary: string;
}

export interface SignalBoard {
  id: SignalId;
  title: string;
  signalName: string;
  stance: Stance;
  summary: string;
  rows: SignalRow[];
}

export interface SignalSnapshot {
  marketDate: string;
  refreshedAt: string;
  source: DataSourceKind;
  sourceLabel: string;
  boards: SignalBoard[];
  topRows: SignalRow[];
  philosophy: string;
  disclaimers: string[];
}
