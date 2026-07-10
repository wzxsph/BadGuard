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
  /** 当日换手率，单位为百分比（例如 3.2 表示 3.2%）。 */
  turnoverRate?: number | null;
  /** 当日流通市值，单位为人民币元。 */
  floatMarketCap?: number | null;
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
  triggerClose: number;
  indicators: IndicatorValues;
  amount: number;
  turnoverRate: number | null;
  floatMarketCap: number | null;
  liquidityEligible: boolean;
  liquidityTags: string[];
  industry: string;
  change5d: number;
  change20d: number;
  riskTags: string[];
  signalStrength: number;
}

export interface CompanyProfile {
  code: string;
  name: string;
  industry: string;
  companyName?: string;
  englishName?: string;
  formerName?: string;
  market?: string;
  legalRepresentative?: string;
  registeredCapital?: string;
  establishedDate?: string;
  listingDate?: string;
  region?: string;
  mainBusiness?: string;
  businessScope?: string;
  organizationProfile?: string;
  registeredAddress?: string;
  officeAddress?: string;
  postalCode?: string;
  email?: string;
  phone?: string;
  website?: string;
  businessComposition?: BusinessSegment[];
  profileSource: "akshare-f10" | "signal-snapshot";
  updatedAt: string;
  note?: string;
}

export interface BusinessSegment {
  category?: string;
  name: string;
  reportDate?: string;
  revenueRatioPct?: number;
  grossMarginPct?: number | null;
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

export interface SnapshotMeta {
  scanLimit: number;
  stockCount: number;
  universeSource: "code-list" | "realtime" | "provider" | "bundled";
  historySource: "sina" | "eastmoney" | "provider" | "bundled";
  failureCount: number;
  buildMode: "production" | "staging" | "local" | "bundled";
}

export interface SignalSnapshot {
  marketDate: string;
  refreshedAt: string;
  source: DataSourceKind;
  sourceLabel: string;
  meta: SnapshotMeta;
  boards: SignalBoard[];
  topRows: SignalRow[];
  philosophy: string;
  disclaimers: string[];
}
