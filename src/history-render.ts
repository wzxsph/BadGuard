import type { SignalBoard, SignalRow, SignalSnapshot } from "./types";

export interface HistoryPageEntry {
  date: string;
  source: "live" | "backfill";
  status: "ready";
  bootstrapSeed?: boolean;
  publishedAt?: string;
}

export interface HistoryReturnView {
  status: "complete" | "pending" | "missing";
  tradingDate: string | null;
  returnPct: number | null;
}

export interface HistoryPageRow extends SignalRow {
  forwardReturns: {
    t1: HistoryReturnView;
    t2: HistoryReturnView;
  };
}

export interface HistoryPageBoard extends Omit<SignalBoard, "rows"> {
  rows: HistoryPageRow[];
}

export interface HistoryPageDetail {
  date: string;
  source: "live" | "backfill";
  entry: HistoryPageEntry;
  snapshot: Omit<SignalSnapshot, "boards" | "topRows"> & {
    boards: HistoryPageBoard[];
    topRows: HistoryPageRow[];
  };
}

export function renderHistoryHtml(
  entries: HistoryPageEntry[],
  detail: HistoryPageDetail | null,
  initialError = ""
): string {
  const readyEntries = normalizeEntries(entries);
  const activeDate = detail?.date || readyEntries[0]?.date || "";
  const initialPayload = serializeForScript(detail);

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BadGuard｜历史复盘</title>
  <style>${HISTORY_CSS}</style>
</head>
<body>
  <nav class="site-nav" aria-label="榜单视图">
    <a href="/">今日榜单</a>
    <a href="/history" aria-current="page">历史复盘</a>
  </nav>

  <header class="history-hero">
    <div>
      <p class="eyebrow">BadGuard · 收盘后的旧纸条</p>
      <h1>历史复盘</h1>
      <p>从 2026-07-08 起逐个交易日留存四类榜单，后续涨跌统一以入榜日收盘价为基准。</p>
    </div>
    <div class="hero-rule">
      <strong>大票优先过滤</strong>
      <span>观察榜要求流通市值 ≥ 50 亿元且当日成交额 ≥ 2 亿元；风险榜不受此门槛限制。</span>
    </div>
  </header>

  <main>
    <section class="date-section" aria-labelledby="history-date-title">
      <div class="section-head">
        <div>
          <p class="eyebrow">按交易日查看</p>
          <h2 id="history-date-title">选择一张旧纸条</h2>
        </div>
        <p class="source-caption" data-history-source>${detail ? sourceLabel(detail.source, detail.entry.bootstrapSeed) : ""}</p>
      </div>
      ${renderDateStrip(readyEntries, activeDate)}
    </section>

    <section class="history-board" aria-labelledby="history-board-title">
      <div class="section-head">
        <div>
          <p class="eyebrow">四类榜单 · 入榜后表现</p>
          <h2 id="history-board-title" data-history-title>${activeDate ? `${escapeHtml(activeDate)} 榜单` : "暂无历史榜单"}</h2>
        </div>
        <span class="loading" data-history-loading hidden>正在翻旧纸条…</span>
      </div>
      <p class="history-alert" data-history-error role="alert"${initialError ? "" : " hidden"}>${escapeHtml(initialError)}</p>
      <div data-history-content${detail ? "" : " hidden"}>
        ${renderTabs(detail?.snapshot.boards || [])}
        <div data-history-panels>${detail ? renderPanels(detail.snapshot.boards) : ""}</div>
      </div>
      <div class="empty" data-history-empty${detail || initialError ? " hidden" : ""}>
        暂无可用历史数据。第一份历史纸条会从 2026-07-08 开始出现。
      </div>
    </section>

    <aside class="review-note" aria-label="复盘说明">
      <strong>复盘边界</strong>
      <p>后续涨跌仅用于复盘，不代表策略胜率或交易建议。T+1、T+2 指交易所交易日，均为相对入榜日前复权收盘价的累计涨跌幅；停牌或价格缺失不会顺延。</p>
      <a class="repo-link" href="https://github.com/wzxsph/BadGuard" target="_blank" rel="noopener noreferrer">在 GitHub 查看源码</a>
    </aside>
  </main>

  <script type="application/json" id="history-initial-payload">${initialPayload}</script>
  <script>${HISTORY_JS}</script>
</body>
</html>`;
}

function normalizeEntries(entries: HistoryPageEntry[]): HistoryPageEntry[] {
  const byDate = new Map<string, HistoryPageEntry>();
  for (const entry of entries) {
    if (entry.status === "ready" && /^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
      byDate.set(entry.date, entry);
    }
  }
  return [...byDate.values()].sort((left, right) => right.date.localeCompare(left.date));
}

function renderDateStrip(entries: HistoryPageEntry[], activeDate: string): string {
  if (entries.length === 0) {
    return `<div class="date-strip date-strip--empty" data-history-dates>暂无日期</div>`;
  }

  return `<div class="date-strip" data-history-dates aria-label="历史交易日">
    ${entries.map((entry) => `<button type="button" class="date-chip" data-history-date="${entry.date}"${entry.date === activeDate ? ' aria-current="date"' : ""}>
      <span>${escapeHtml(formatShortDate(entry.date))}</span>
      <small>${sourceLabel(entry.source, entry.bootstrapSeed)}</small>
    </button>`).join("")}
  </div>`;
}

function renderTabs(boards: HistoryPageBoard[]): string {
  const fallbackBoards: HistoryPageBoard[] = boards.length > 0
    ? boards
    : BOARD_LABELS.map((board) => ({
        ...board,
        signalName: "",
        stance: board.id === "risk-filter" ? "谨慎" : "观察",
        summary: "",
        rows: []
      }));
  return `<div class="board-tabs" role="tablist" aria-label="历史榜单分类" data-history-tabs>
    ${fallbackBoards.map((board, index) => `<button type="button" role="tab" id="tab-${board.id}" aria-controls="panel-${board.id}" aria-selected="${index === 0 ? "true" : "false"}" tabindex="${index === 0 ? "0" : "-1"}" data-board-tab="${board.id}">${escapeHtml(boardTitle(board))}</button>`).join("")}
  </div>`;
}

function renderPanels(boards: HistoryPageBoard[]): string {
  return boards.map((board, index) => `<section class="board-panel" id="panel-${board.id}" role="tabpanel" aria-labelledby="tab-${board.id}" data-board-panel="${board.id}"${index === 0 ? "" : " hidden"}>
    <div class="board-summary">
      <div><h3>${escapeHtml(boardTitle(board))}</h3><p>${escapeHtml(board.summary)}</p></div>
      <span>${board.rows.length} 条</span>
    </div>
    ${board.rows.length > 0 ? `<div class="history-cards">${board.rows.map(renderHistoryCard).join("")}</div>` : `<div class="empty">这一天该榜没有入榜股票。</div>`}
  </section>`).join("");
}

function renderHistoryCard(row: HistoryPageRow): string {
  const scoreLabel = row.signalId === "risk-filter" ? "风险强度" : "结构确认分";
  return `<article class="history-card">
    <div class="stock-line">
      <div><strong>${escapeHtml(row.name)}</strong><span>${escapeHtml(row.code)}</span></div>
      <b class="stance stance--${row.stance === "谨慎" ? "caution" : "observe"}">${escapeHtml(row.stance)}</b>
    </div>
    <dl class="history-metrics">
      <div><dt>入榜日</dt><dd>${escapeHtml(row.triggerDate)}</dd></div>
      <div><dt>成交额</dt><dd>${formatAmount(row.amount)}</dd></div>
      <div><dt>流通市值</dt><dd>${formatMarketCap(row.floatMarketCap)}</dd></div>
      <div><dt>换手率</dt><dd>${formatTurnover(row.turnoverRate)}</dd></div>
    </dl>
    <div class="return-grid" aria-label="入榜后累计涨跌">
      ${renderForwardReturn("T+1", row.forwardReturns.t1)}
      ${renderForwardReturn("T+2", row.forwardReturns.t2)}
    </div>
    <div class="score-line"><span>${scoreLabel}</span><meter min="0" max="100" value="${row.signalStrength}"></meter><b>${row.signalStrength}</b></div>
    ${(row.liquidityTags || []).length > 0 ? `<div class="tag-row">${(row.liquidityTags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
  </article>`;
}

function renderForwardReturn(label: string, result: HistoryReturnView): string {
  if (result.status === "pending") {
    return `<div class="return return--pending"><span>${label}</span><strong>待收盘</strong><small>${result.tradingDate ? escapeHtml(result.tradingDate) : "对应交易日未到"}</small></div>`;
  }
  if (result.status === "missing" || result.returnPct === null) {
    return `<div class="return return--missing"><span>${label}</span><strong>暂无数据</strong><small>${result.tradingDate ? escapeHtml(result.tradingDate) : "交易日数据缺失"}</small></div>`;
  }

  const className = result.returnPct > 0 ? "positive" : result.returnPct < 0 ? "negative" : "flat";
  const stateLabel = result.returnPct > 0 ? "正收益" : result.returnPct < 0 ? "负收益" : "持平";
  return `<div class="return return--${className}"><span>${label}</span><strong>${formatPercent(result.returnPct)}</strong><small>${result.tradingDate ? escapeHtml(result.tradingDate) : "已收盘"} · ${stateLabel}</small></div>`;
}

function boardTitle(board: Pick<SignalBoard, "id" | "title">): string {
  return BOARD_LABELS.find((item) => item.id === board.id)?.title || board.title;
}

function sourceLabel(source: HistoryPageEntry["source"], bootstrapSeed = false): string {
  if (bootstrapSeed) return "仓库恢复";
  return source === "backfill" ? "回溯生成" : "实时留存";
}

function formatShortDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${month}-${day}`;
}

function formatAmount(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return "暂无数据";
  return value >= 100_000_000 ? `${formatNumber(value / 100_000_000)}亿` : `${formatNumber(value / 10_000)}万`;
}

function formatMarketCap(value: number | null | undefined): string {
  return isFiniteNumber(value) ? `${formatNumber(value / 100_000_000)}亿` : "暂无数据";
}

function formatTurnover(value: number | null | undefined): string {
  return isFiniteNumber(value) ? `${formatNumber(value)}%` : "暂无数据";
}

function formatPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${formatNumber(value)}%`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/-->/g, "--\\u003e");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;"
  })[character] || character);
}

const BOARD_LABELS = [
  { id: "low-rebound", title: "低位反弹" },
  { id: "trend-strength", title: "趋势转强" },
  { id: "oversold-repair", title: "超跌修复" },
  { id: "risk-filter", title: "风险过滤" }
] as const;

const HISTORY_CSS = `
:root {
  color-scheme: light;
  --paper: #f3ead4;
  --paper-light: #fffaf0;
  --ink: #27231f;
  --soft: #5f574d;
  --muted: #746b60;
  --line: rgba(82, 67, 51, .22);
  --indigo: #36537a;
  --red: #a44735;
  --green: #26705a;
  --amber: #9a6818;
}
* { box-sizing: border-box; }
body { margin: 0; color: var(--ink); background: radial-gradient(circle at 12% 4%, rgba(255,255,255,.7), transparent 28%), var(--paper); font-family: "Noto Serif SC", "Songti SC", serif; }
button, a { font: inherit; }
.site-nav { display: flex; justify-content: center; gap: 8px; padding: 12px 16px 0; }
.site-nav a { min-height: 38px; padding: 8px 14px; color: var(--soft); text-decoration: none; border: 1px solid var(--line); border-radius: 999px; background: rgba(255,250,240,.76); font-weight: 900; }
.site-nav a[aria-current="page"] { color: white; border-color: var(--indigo); background: var(--indigo); }
.history-hero { display: grid; grid-template-columns: minmax(0,1.5fr) minmax(240px,.7fr); gap: 24px; max-width: 1180px; margin: 0 auto; padding: 42px 28px 28px; }
.history-hero h1 { margin: 0; font-size: clamp(2.2rem, 7vw, 5rem); line-height: 1; }
.history-hero p { max-width: 720px; color: var(--soft); line-height: 1.75; }
.eyebrow { margin: 0 0 8px; color: var(--red); font-size: .78rem; font-weight: 900; }
.hero-rule { align-self: end; display: grid; gap: 8px; padding: 18px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,250,240,.72); }
.hero-rule strong { color: var(--red); }
.hero-rule span { color: var(--soft); line-height: 1.6; }
main { display: grid; gap: 26px; max-width: 1180px; margin: 0 auto; padding: 0 28px 48px; }
.date-section, .history-board, .review-note { padding: 22px; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,250,240,.72); box-shadow: 0 12px 30px rgba(77,61,41,.08); }
.section-head, .board-summary, .stock-line, .score-line { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
.section-head h2, .board-summary h3 { margin: 0; }
.source-caption { color: var(--indigo); font-weight: 900; }
.date-strip { display: flex; gap: 10px; margin-top: 18px; padding: 4px 2px 12px; overflow-x: auto; scrollbar-width: thin; }
.date-chip { flex: 0 0 auto; display: grid; gap: 3px; min-width: 112px; padding: 10px 12px; text-align: left; color: var(--ink); border: 1px solid var(--line); border-radius: 7px; background: var(--paper-light); cursor: pointer; }
.date-chip span { font-weight: 900; }
.date-chip small { color: var(--muted); }
.date-chip[aria-current="date"] { color: white; border-color: var(--indigo); background: var(--indigo); }
.date-chip[aria-current="date"] small { color: rgba(255,255,255,.78); }
.board-tabs { display: flex; gap: 8px; margin: 18px 0; overflow-x: auto; }
.board-tabs button { flex: 0 0 auto; padding: 9px 14px; color: var(--soft); border: 1px solid var(--line); border-radius: 5px; background: transparent; cursor: pointer; font-weight: 900; }
.board-tabs button[aria-selected="true"] { color: white; border-color: var(--red); background: var(--red); }
.board-summary { padding: 4px 0 14px; border-bottom: 1px solid var(--line); }
.board-summary p { margin: 5px 0 0; color: var(--muted); }
.board-summary > span { white-space: nowrap; color: var(--indigo); font-weight: 900; }
.history-cards { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 14px; padding-top: 14px; }
.history-card { min-width: 0; padding: 16px; border: 1px solid var(--line); border-radius: 7px; background: rgba(255,255,255,.42); }
.stock-line > div { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.stock-line strong { font-size: 1.15rem; }
.stock-line span { color: var(--muted); font-family: ui-monospace, monospace; }
.stance { padding: 4px 8px; border-radius: 999px; font-size: .76rem; }
.stance--observe { color: var(--indigo); background: rgba(54,83,122,.12); }
.stance--caution { color: var(--red); background: rgba(164,71,53,.12); }
.history-metrics { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 9px 14px; margin: 15px 0; }
.history-metrics div { min-width: 0; }
.history-metrics dt { color: var(--muted); font-size: .75rem; }
.history-metrics dd { margin: 3px 0 0; font-weight: 900; overflow-wrap: anywhere; }
.return-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; }
.return { display: grid; gap: 3px; padding: 10px; border-radius: 5px; border: 1px solid var(--line); background: var(--paper-light); }
.return span, .return small { color: var(--muted); font-size: .74rem; }
.return strong { font-size: 1.08rem; }
.return--positive strong { color: var(--red); }
.return--negative strong { color: var(--green); }
.return--flat strong { color: var(--indigo); }
.return--pending strong { color: var(--amber); }
.return--missing strong { color: var(--muted); }
.score-line { margin-top: 14px; }
.score-line span { color: var(--muted); font-size: .82rem; }
.score-line meter { flex: 1; min-width: 60px; }
.tag-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.tag-row span { padding: 3px 7px; color: var(--soft); border: 1px dashed var(--line); border-radius: 4px; font-size: .72rem; }
.empty { padding: 24px; color: var(--muted); text-align: center; border: 1px dashed var(--line); border-radius: 6px; }
.history-alert { padding: 12px; color: #7d2e26; border: 1px solid rgba(164,71,53,.38); border-radius: 6px; background: rgba(164,71,53,.08); }
.loading { color: var(--indigo); font-weight: 900; }
.review-note { border-left: 5px solid var(--indigo); }
.review-note p { margin: 7px 0 0; color: var(--soft); line-height: 1.7; }
.repo-link { display: inline-flex; margin-top: 8px; color: var(--indigo); font-size: .8rem; font-weight: 900; text-underline-offset: 3px; }
[hidden] { display: none !important; }
@media (max-width: 760px) {
  .history-hero { grid-template-columns: 1fr; padding: 32px 14px 20px; }
  main { padding: 0 12px 32px; }
  .date-section, .history-board, .review-note { padding: 16px; }
  .history-cards { grid-template-columns: 1fr; }
  .section-head { align-items: flex-start; }
}
@media (max-width: 420px) {
  .history-metrics, .return-grid { grid-template-columns: 1fr 1fr; }
  .date-chip { min-width: 100px; }
}
`;

const HISTORY_JS = `
(() => {
  const payloadNode = document.getElementById("history-initial-payload");
  let current = payloadNode ? JSON.parse(payloadNode.textContent || "null") : null;
  let activeBoard = current?.snapshot?.boards?.[0]?.id || "low-rebound";
  let controller = null;
  const errorNode = document.querySelector("[data-history-error]");
  const contentNode = document.querySelector("[data-history-content]");
  const emptyNode = document.querySelector("[data-history-empty]");
  const loadingNode = document.querySelector("[data-history-loading]");
  const panelsNode = document.querySelector("[data-history-panels]");
  const titleNode = document.querySelector("[data-history-title]");
  const sourceNode = document.querySelector("[data-history-source]");

  const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
  const number = (value) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
  const amount = (value) => Number.isFinite(value) ? (value >= 1e8 ? number(value / 1e8) + "亿" : number(value / 1e4) + "万") : "暂无数据";
  const cap = (value) => Number.isFinite(value) ? number(value / 1e8) + "亿" : "暂无数据";
  const turnover = (value) => Number.isFinite(value) ? number(value) + "%" : "暂无数据";
  const boardName = (id) => ({"low-rebound":"低位反弹","trend-strength":"趋势转强","oversold-repair":"超跌修复","risk-filter":"风险过滤"}[id] || id);
  const sourceName = (source, bootstrapSeed = false) => bootstrapSeed ? "仓库恢复" : source === "backfill" ? "回溯生成" : "实时留存";

  function returnHtml(label, result) {
    const date = result?.tradingDate ? esc(result.tradingDate) : "对应交易日未到";
    if (result?.status === "pending") return '<div class="return return--pending"><span>' + label + '</span><strong>待收盘</strong><small>' + date + '</small></div>';
    if (result?.status !== "complete" || !Number.isFinite(result.returnPct)) return '<div class="return return--missing"><span>' + label + '</span><strong>暂无数据</strong><small>' + date + '</small></div>';
    const kind = result.returnPct > 0 ? "positive" : result.returnPct < 0 ? "negative" : "flat";
    const state = result.returnPct > 0 ? "正收益" : result.returnPct < 0 ? "负收益" : "持平";
    const value = (result.returnPct > 0 ? "+" : "") + number(result.returnPct) + "%";
    return '<div class="return return--' + kind + '"><span>' + label + '</span><strong>' + value + '</strong><small>' + date + ' · ' + state + '</small></div>';
  }

  function cardHtml(row) {
    const tags = (row.liquidityTags || []).map((tag) => '<span>' + esc(tag) + '</span>').join("");
    const score = row.signalId === "risk-filter" ? "风险强度" : "结构确认分";
    return '<article class="history-card"><div class="stock-line"><div><strong>' + esc(row.name) + '</strong><span>' + esc(row.code) + '</span></div><b class="stance stance--' + (row.stance === "谨慎" ? "caution" : "observe") + '">' + esc(row.stance) + '</b></div>' +
      '<dl class="history-metrics"><div><dt>入榜日</dt><dd>' + esc(row.triggerDate) + '</dd></div><div><dt>成交额</dt><dd>' + amount(row.amount) + '</dd></div><div><dt>流通市值</dt><dd>' + cap(row.floatMarketCap) + '</dd></div><div><dt>换手率</dt><dd>' + turnover(row.turnoverRate) + '</dd></div></dl>' +
      '<div class="return-grid" aria-label="入榜后累计涨跌">' + returnHtml("T+1", row.forwardReturns?.t1) + returnHtml("T+2", row.forwardReturns?.t2) + '</div>' +
      '<div class="score-line"><span>' + score + '</span><meter min="0" max="100" value="' + row.signalStrength + '"></meter><b>' + row.signalStrength + '</b></div>' + (tags ? '<div class="tag-row">' + tags + '</div>' : "") + '</article>';
  }

  function panelHtml(board) {
    const cards = board.rows?.length ? '<div class="history-cards">' + board.rows.map(cardHtml).join("") + '</div>' : '<div class="empty">这一天该榜没有入榜股票。</div>';
    return '<section class="board-panel" id="panel-' + board.id + '" role="tabpanel" aria-labelledby="tab-' + board.id + '" data-board-panel="' + board.id + '"' + (board.id === activeBoard ? "" : " hidden") + '><div class="board-summary"><div><h3>' + boardName(board.id) + '</h3><p>' + esc(board.summary) + '</p></div><span>' + (board.rows?.length || 0) + ' 条</span></div>' + cards + '</section>';
  }

  function activateTab(tab, focus = false) {
      if (!tab) return;
      activeBoard = tab.dataset.boardTab;
      document.querySelectorAll("[data-board-tab]").forEach((item) => {
        item.setAttribute("aria-selected", String(item === tab));
        item.setAttribute("tabindex", item === tab ? "0" : "-1");
      });
      document.querySelectorAll("[data-board-panel]").forEach((panel) => panel.hidden = panel.dataset.boardPanel !== activeBoard);
      if (focus) tab.focus();
  }

  function bindTabs() {
    const tabs = [...document.querySelectorAll("[data-board-tab]")];
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => activateTab(tab));
      tab.addEventListener("keydown", (event) => {
        let nextIndex = null;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = tabs.length - 1;
        if (nextIndex === null) return;
        event.preventDefault();
        activateTab(tabs[nextIndex], true);
      });
    });
  }

  function renderDetail(detail) {
    current = detail;
    const boards = detail.snapshot?.boards || [];
    if (!boards.some((board) => board.id === activeBoard)) activeBoard = boards[0]?.id || "low-rebound";
    panelsNode.innerHTML = boards.map(panelHtml).join("");
    titleNode.textContent = detail.date + " 榜单";
    sourceNode.textContent = sourceName(detail.source, detail.entry?.bootstrapSeed === true);
    document.querySelectorAll("[data-history-date]").forEach((button) => {
      if (button.dataset.historyDate === detail.date) button.setAttribute("aria-current", "date");
      else button.removeAttribute("aria-current");
    });
    document.querySelectorAll("[data-board-tab]").forEach((tab) => {
      const selected = tab.dataset.boardTab === activeBoard;
      tab.setAttribute("aria-selected", String(selected));
      tab.setAttribute("tabindex", selected ? "0" : "-1");
    });
    contentNode.hidden = false;
    emptyNode.hidden = true;
    errorNode.hidden = true;
  }

  async function loadDate(date) {
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    loadingNode.hidden = false;
    errorNode.hidden = true;
    try {
      const response = await fetch("/api/history/" + encodeURIComponent(date), { signal: requestController.signal, headers: { accept: "application/json" } });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message || payload?.error || "历史数据读取失败");
      renderDetail(payload);
    } catch (error) {
      if (error?.name === "AbortError") return;
      errorNode.textContent = error?.message || "历史数据读取失败";
      errorNode.hidden = false;
    } finally {
      if (controller === requestController) loadingNode.hidden = true;
    }
  }

  document.querySelectorAll("[data-history-date]").forEach((button) => button.addEventListener("click", () => loadDate(button.dataset.historyDate)));
  bindTabs();
})();
`;
