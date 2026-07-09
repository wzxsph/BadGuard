import type { SignalBoard, SignalRow, SignalSnapshot } from "./types";

export function renderHtml(snapshot: SignalSnapshot): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BadGuard｜每日技术信号榜</title>
  <style>${CSS}</style>
</head>
<body>
  <header class="masthead">
    <div class="masthead__copy">
      <p class="eyebrow">BadGuard · A股日线 · 收盘后快照</p>
      <h1>每日技术信号榜</h1>
      <p class="lead">${escapeHtml(snapshot.philosophy)}</p>
    </div>
    <dl class="market-meta" aria-label="市场数据状态">
      <div><dt>市场日</dt><dd>${escapeHtml(snapshot.marketDate)}</dd></div>
      <div><dt>更新时间</dt><dd>${formatDateTime(snapshot.refreshedAt)}</dd></div>
      <div><dt>数据源</dt><dd>${escapeHtml(snapshot.sourceLabel)}</dd></div>
      <div><dt>数据范围</dt><dd>${escapeHtml(formatDataScope(snapshot))}</dd></div>
    </dl>
  </header>

  <main>
    ${snapshot.boards.map(renderBoard).join("")}

    <section class="section section--summary" id="daily-summary">
      <div class="section__head">
        <div>
          <p class="eyebrow">观察类 · 上行观察优先级</p>
          <h2>今日信号总览</h2>
          <p class="summary">只汇总观察类信号，风险过滤榜不参与上行排序。</p>
        </div>
        <span class="count">${snapshot.topRows.length} 条</span>
      </div>
      ${renderCards(snapshot.topRows, true, "上行优先级")}
    </section>
  </main>

  <footer class="footer">
    ${snapshot.disclaimers.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}
  </footer>
</body>
</html>`;
}

function renderBoard(board: SignalBoard): string {
  const scoreLabel = board.id === "risk-filter" ? "风险强度" : "上行优先级";

  return `<section class="section section--board" id="${board.id}">
    <div class="section__head">
      <div>
        <p class="eyebrow">${escapeHtml(board.signalName)}</p>
        <h2>${escapeHtml(board.title)}</h2>
        <p class="summary">${escapeHtml(board.summary)}</p>
      </div>
      <span class="stance stance--${board.stance === "谨慎" ? "caution" : "observe"}">${board.stance}</span>
    </div>
    ${renderCards(board.rows, false, scoreLabel)}
  </section>`;
}

function renderCards(rows: SignalRow[], showSignal: boolean, scoreLabel: string): string {
  if (rows.length === 0) {
    return `<div class="empty">今日暂无符合该条件的信号</div>`;
  }

  return `<div class="signal-list">
    ${rows.map((row) => renderCard(row, showSignal, scoreLabel)).join("")}
  </div>`;
}

function renderCard(row: SignalRow, showSignal: boolean, scoreLabel: string): string {
  const stanceClass = row.stance === "谨慎" ? "caution" : "observe";

  return `<article class="signal-card">
    <div class="card-topline">
      <div class="stock-title">
        <strong>${escapeHtml(row.name)}</strong>
        <span>${escapeHtml(row.code)}</span>
      </div>
      <span class="stance stance--${stanceClass}">${row.stance}</span>
    </div>

    <div class="signal-name">${escapeHtml(showSignal ? row.signalName : row.signalName)}</div>

    <dl class="card-metrics">
      <div><dt>触发日期</dt><dd>${escapeHtml(row.triggerDate)}</dd></div>
      <div><dt>成交额</dt><dd>${formatAmount(row.amount)}</dd></div>
      <div><dt>所属行业</dt><dd>${escapeHtml(row.industry)}</dd></div>
      <div><dt>近5/20日</dt><dd><span class="${returnClass(row.change5d)}">${formatPercent(row.change5d)}</span> / <span class="${returnClass(row.change20d)}">${formatPercent(row.change20d)}</span></dd></div>
    </dl>

    <div class="tag-row" aria-label="风险标签">
      ${row.riskTags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
    </div>

    <div class="score-row">
      <span>${escapeHtml(scoreLabel)}</span>
      <meter min="0" max="100" value="${row.signalStrength}"></meter>
      <b>${row.signalStrength}</b>
    </div>

    <details class="signal-detail">
      <summary>查看详情</summary>
      <dl>
        <div><dt>KDJ</dt><dd>K ${formatNumber(row.indicators.kdj.k)} / D ${formatNumber(row.indicators.kdj.d)} / J ${formatNumber(row.indicators.kdj.j)}</dd></div>
        <div><dt>MACD</dt><dd>DIF ${formatNumber(row.indicators.macd.dif)} / DEA ${formatNumber(row.indicators.macd.dea)} / H ${formatNumber(row.indicators.macd.histogram)}</dd></div>
        <div><dt>RSI</dt><dd>${formatNumber(row.indicators.rsi)}</dd></div>
      </dl>
    </details>
  </article>`;
}

function formatAmount(value: number): string {
  if (Math.abs(value) >= 100000000) {
    return `${formatNumber(value / 100000000)}亿`;
  }

  return `${formatNumber(value / 10000)}万`;
}

function formatPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${formatNumber(value)}%`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(value);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDataScope(snapshot: SignalSnapshot): string {
  const meta = snapshot.meta;
  if (!meta) {
    return "最近快照";
  }

  const poolLabel = meta.universeSource === "realtime"
    ? `活跃A股前${meta.scanLimit || meta.stockCount}只`
    : meta.universeSource === "code-list"
      ? meta.scanLimit > 0
        ? `固定代码池前${meta.scanLimit}只`
        : "固定代码池全量"
      : meta.universeSource === "provider"
        ? "外部行情源"
        : "随代码快照";

  const modeLabel = meta.buildMode === "production" ? "生产" : meta.buildMode === "staging" ? "调试" : "本地";
  return `${poolLabel} · ${modeLabel}`;
}

function returnClass(value: number): string {
  if (value > 0) {
    return "return-up";
  }

  if (value < 0) {
    return "return-down";
  }

  return "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const CSS = `
:root {
  color-scheme: light;
  --page: #f5f6f8;
  --panel: #ffffff;
  --ink: #1d252f;
  --muted: #687383;
  --line: #dfe4ea;
  --green: #12805c;
  --green-soft: #e7f5ef;
  --red: #b42318;
  --red-soft: #fdeceb;
  --blue: #2459a6;
  --blue-soft: #edf4ff;
  --tag: #eef2f6;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  letter-spacing: 0;
}

.masthead {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);
  gap: 28px;
  align-items: end;
  padding: 34px clamp(16px, 4vw, 56px) 24px;
  background: #ffffff;
  border-bottom: 1px solid var(--line);
}

.masthead h1 {
  margin: 4px 0 12px;
  font-size: clamp(2.1rem, 5vw, 4.6rem);
  line-height: 1;
  letter-spacing: 0;
}

.lead {
  max-width: 780px;
  margin: 0;
  color: #445060;
  font-size: clamp(1rem, 2vw, 1.16rem);
  line-height: 1.68;
}

.eyebrow {
  margin: 0 0 8px;
  color: var(--blue);
  font-size: 0.76rem;
  font-weight: 800;
  letter-spacing: 0;
}

.market-meta {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 16px;
  background: #f9fafb;
  border: 1px solid var(--line);
  border-radius: 8px;
}

.market-meta div {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr);
  gap: 12px;
  align-items: baseline;
}

.market-meta dt {
  color: var(--muted);
  font-size: 0.78rem;
}

.market-meta dd {
  min-width: 0;
  margin: 0;
  font-weight: 700;
  overflow-wrap: anywhere;
}

main {
  display: grid;
  gap: 18px;
  padding: 18px clamp(12px, 4vw, 56px) 30px;
}

.section {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}

.section--summary {
  border-color: #c8d8ee;
}

.section__head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  padding: 18px;
  border-bottom: 1px solid var(--line);
}

.section h2 {
  margin: 0;
  font-size: clamp(1.22rem, 2.2vw, 1.62rem);
  letter-spacing: 0;
}

.summary {
  margin: 6px 0 0;
  color: var(--muted);
  line-height: 1.55;
}

.count,
.stance {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 48px;
  min-height: 28px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 0.82rem;
  font-weight: 800;
  white-space: nowrap;
}

.count {
  background: var(--tag);
  color: #3f4b5c;
}

.stance--observe {
  background: var(--green-soft);
  color: var(--green);
}

.stance--caution {
  background: var(--red-soft);
  color: var(--red);
}

.signal-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 14px;
}

.signal-card {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #ffffff;
  min-width: 0;
}

.card-topline,
.score-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.stock-title {
  min-width: 0;
}

.stock-title strong,
.stock-title span {
  display: block;
}

.stock-title strong {
  font-size: 1.02rem;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.stock-title span {
  margin-top: 3px;
  color: var(--muted);
  font-size: 0.78rem;
  font-weight: 700;
}

.signal-name {
  color: #334155;
  font-size: 0.94rem;
  font-weight: 800;
  line-height: 1.45;
}

.card-metrics,
.signal-detail dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
  margin: 0;
}

.card-metrics div,
.signal-detail div {
  min-width: 0;
}

.card-metrics dt,
.signal-detail dt {
  margin-bottom: 3px;
  color: var(--muted);
  font-size: 0.74rem;
  font-weight: 800;
}

.card-metrics dd,
.signal-detail dd {
  margin: 0;
  color: #273241;
  font-size: 0.9rem;
  font-weight: 700;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 26px;
}

.tag {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 3px 7px;
  border-radius: 6px;
  background: var(--tag);
  color: #495466;
  font-size: 0.74rem;
  font-weight: 800;
}

.return-up {
  color: var(--green);
  font-weight: 900;
}

.return-down {
  color: var(--red);
  font-weight: 900;
}

.score-row {
  padding-top: 2px;
  color: #536174;
  font-size: 0.82rem;
  font-weight: 800;
}

meter {
  flex: 1 1 auto;
  min-width: 72px;
  height: 8px;
}

meter::-webkit-meter-bar {
  background: #e8edf2;
  border: 0;
}

meter::-webkit-meter-optimum-value {
  background: var(--blue);
}

.score-row b {
  color: var(--ink);
  font-size: 0.92rem;
}

.signal-detail {
  border-top: 1px solid var(--line);
  padding-top: 10px;
}

.signal-detail summary {
  cursor: pointer;
  color: var(--blue);
  font-size: 0.86rem;
  font-weight: 900;
  list-style-position: outside;
}

.signal-detail dl {
  grid-template-columns: 1fr;
  margin-top: 10px;
  padding: 10px;
  border-radius: 8px;
  background: var(--blue-soft);
}

.empty {
  padding: 28px 18px;
  color: var(--muted);
}

.footer {
  padding: 0 clamp(14px, 4vw, 56px) 34px;
  color: #687383;
  font-size: 0.84rem;
  line-height: 1.6;
}

.footer p {
  margin: 5px 0;
}

@media (max-width: 860px) {
  .masthead {
    grid-template-columns: 1fr;
    padding-top: 24px;
  }

  .section__head {
    flex-direction: column;
  }

  .signal-list {
    grid-template-columns: 1fr;
    padding: 12px;
  }
}

@media (max-width: 520px) {
  .masthead {
    padding: 22px 14px 18px;
  }

  .masthead h1 {
    font-size: 2.25rem;
  }

  main {
    gap: 14px;
    padding: 14px 10px 24px;
  }

  .section__head {
    padding: 15px 14px;
  }

  .signal-list {
    padding: 10px;
  }

  .signal-card {
    padding: 12px;
  }

  .card-metrics {
    grid-template-columns: 1fr;
  }
}
`;
