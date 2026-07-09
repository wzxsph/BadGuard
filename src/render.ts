import type { SignalBoard, SignalId, SignalRow, SignalSnapshot } from "./types";

interface SignalPresentation {
  title: string;
  professionalTitle: string;
  summary: string;
  technical: string;
  mood: string;
  scoreLabel: string;
}

const SIGNAL_COPY: Record<SignalId, SignalPresentation> = {
  "low-rebound": {
    title: "今天又来抄底啦",
    professionalTitle: "低位反弹观察",
    summary: "低位刚有点动静，量也跟着探头。可以围观，别急着把键盘拍冒烟。",
    technical: "日线 KDJ 在 20 附近或以下金叉，且成交量放大。",
    mood: "地板附近有人敲门，但门后是不是机会，还得看后续确认。",
    scoreLabel: "围观优先级"
  },
  "trend-strength": {
    title: "勇敢散户向前冲",
    professionalTitle: "趋势转强观察",
    summary: "趋势像是把鞋带系上了，但冲之前先看看路面是不是湿的。",
    technical: "MACD 金叉，并且股价重新站回 5 日和 10 日均线。",
    mood: "结构开始像那么回事了，先记一笔，别把记一笔理解成梭哈。",
    scoreLabel: "围观优先级"
  },
  "oversold-repair": {
    title: "跌麻了，先看修复",
    professionalTitle: "超跌修复观察",
    summary: "从地板上坐起来不等于马上起飞，但至少不是继续躺平。",
    technical: "RSI 从低位回升，同时价格从 BOLL 下轨附近收回。",
    mood: "修复是修复，反转是反转，中间隔着散户最容易脑补的一条河。",
    scoreLabel: "围观优先级"
  },
  "risk-filter": {
    title: "别冲了，先喝口水",
    professionalTitle: "风险过滤榜",
    summary: "市场递来一张小纸条：手慢一点，仓位轻一点，心跳稳一点。",
    technical: "近期跌破均线、放量下跌，或 KDJ 高位死叉。",
    mood: "不是说世界末日，只是这会儿更适合把手从下单按钮旁边挪开。",
    scoreLabel: "冷静指数"
  }
};

export function renderHtml(snapshot: SignalSnapshot): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BadGuard｜散户看盘小纸条</title>
  <style>${CSS}</style>
</head>
<body>
  <header class="masthead">
    <div class="masthead__copy">
      <p class="eyebrow">BadGuard · 收盘后小纸条</p>
      <h1>散户看盘小纸条</h1>
      <p class="slogan">今天又来抄底啦？先把纸条摊开看看。</p>
      <p class="lead">${escapeHtml(snapshot.philosophy)}</p>
    </div>
    <dl class="market-meta" aria-label="市场数据状态">
      <div><dt>市场日</dt><dd>${escapeHtml(snapshot.marketDate)}</dd></div>
      <div><dt>更新时间</dt><dd>${formatDateTime(snapshot.refreshedAt)}</dd></div>
      <div><dt>数据源</dt><dd>${escapeHtml(snapshot.sourceLabel)}</dd></div>
      <div><dt>数据范围</dt><dd>${escapeHtml(formatDataScope(snapshot))}</dd></div>
    </dl>
  </header>

  ${renderProfessionalNotes()}

  <main>
    ${snapshot.boards.map(renderBoard).join("")}

    <section class="section section--summary" id="daily-summary">
      <div class="section__head">
        <div>
          <p class="eyebrow">观察类 · 上行观察优先级</p>
          <h2>今日围观总览</h2>
          <p class="summary">只汇总观察类信号，按上行观察优先级排序；风险过滤榜不进这个小本本。</p>
        </div>
        <span class="count">${snapshot.topRows.length} 条</span>
      </div>
      ${renderCards(snapshot.topRows, true)}
    </section>
  </main>

  <footer class="footer" aria-label="免责声明">
    <div class="footer__paper">
      <strong>冷静免责声明</strong>
      ${snapshot.disclaimers.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}
    </div>
  </footer>
</body>
</html>`;
}

function renderProfessionalNotes(): string {
  const notes = Object.values(SIGNAL_COPY)
    .map((copy) => `<li>
      <span class="note-title">${escapeHtml(copy.title)}</span>
      <span class="note-text"><b>${escapeHtml(copy.professionalTitle)}</b>：${escapeHtml(copy.technical)}</span>
    </li>`)
    .join("");

  return `<section class="professional-notes" aria-label="专业注解">
    <div class="professional-notes__head">
      <p class="eyebrow">专业注解 · 冷静区</p>
      <h2>标题可以嘴贫，指标不能乱来</h2>
      <p>下面是每张小纸条对应的原始技术条件。玩笑只负责降低阅读血压，不负责提高收益率。</p>
    </div>
    <ul>${notes}</ul>
    <p class="compliance-note">仅用于个人学习、复盘和观察市场状态；不提供个股推荐，不构成投资建议或收益承诺。</p>
  </section>`;
}

function renderBoard(board: SignalBoard): string {
  const copy = SIGNAL_COPY[board.id];

  return `<section class="section section--board" id="${board.id}">
    <div class="section__head">
      <div>
        <p class="eyebrow">${escapeHtml(copy.professionalTitle)}</p>
        <h2>${escapeHtml(copy.title)}</h2>
        <p class="summary">${escapeHtml(copy.summary)}</p>
      </div>
      <span class="stance stance--${board.stance === "谨慎" ? "caution" : "observe"}">${board.stance}</span>
    </div>
    ${renderCards(board.rows, false)}
  </section>`;
}

function renderCards(rows: SignalRow[], showSignal: boolean): string {
  if (rows.length === 0) {
    return `<div class="empty">今日这张纸条空空如也，市场暂时没递话。</div>`;
  }

  return `<div class="signal-list">
    ${rows.map((row) => renderCard(row, showSignal)).join("")}
  </div>`;
}

function renderCard(row: SignalRow, showSignal: boolean): string {
  const stanceClass = row.stance === "谨慎" ? "caution" : "observe";
  const copy = SIGNAL_COPY[row.signalId];

  return `<article class="signal-card">
    <div class="card-topline">
      <div class="stock-title">
        <strong>${escapeHtml(row.name)}</strong>
        <span>${escapeHtml(row.code)}</span>
      </div>
      <span class="stance stance--${stanceClass}">${row.stance}</span>
    </div>

    <div class="signal-name">${escapeHtml(showSignal ? copy.title : copy.mood)}</div>

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
      <span>${escapeHtml(copy.scoreLabel)}</span>
      <meter min="0" max="100" value="${row.signalStrength}"></meter>
      <b>${row.signalStrength}</b>
    </div>

    <details class="signal-detail">
      <summary>展开指标明细</summary>
      <dl>
        <div><dt>专业注解</dt><dd>${escapeHtml(copy.professionalTitle)}：${escapeHtml(row.signalName)}</dd></div>
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
  --rice: #f3eddd;
  --paper: #fffaf0;
  --paper-deep: #f5e7c4;
  --ink: #24201a;
  --muted: #736a5d;
  --soft-ink: #4f473c;
  --line: rgba(45, 35, 23, 0.22);
  --line-strong: rgba(45, 35, 23, 0.38);
  --jade: #2f6f5f;
  --jade-soft: #e6f1ea;
  --cinnabar: #a44735;
  --cinnabar-soft: #fae8df;
  --indigo: #36537a;
  --indigo-soft: #e8edf4;
  --gold: #9b7135;
  --shadow: 0 12px 34px rgba(60, 43, 20, 0.12);
}

* {
  box-sizing: border-box;
}

html {
  background: var(--rice);
}

body {
  margin: 0;
  min-width: 320px;
  background-color: var(--rice);
  background-image:
    repeating-linear-gradient(0deg, rgba(47, 38, 24, 0.035) 0 1px, transparent 1px 7px),
    repeating-linear-gradient(90deg, rgba(47, 38, 24, 0.025) 0 1px, transparent 1px 9px);
  color: var(--ink);
  font-family: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "PingFang SC", "Microsoft YaHei", serif;
  letter-spacing: 0;
}

body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(90deg, rgba(36, 32, 26, 0.07), transparent 18%, transparent 74%, rgba(164, 71, 53, 0.06)),
    linear-gradient(180deg, rgba(255, 250, 240, 0.72), transparent 34%, rgba(47, 111, 95, 0.05));
  mix-blend-mode: multiply;
}

.masthead {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 410px);
  gap: 30px;
  align-items: end;
  padding: 42px clamp(16px, 4vw, 64px) 28px;
  background:
    linear-gradient(90deg, rgba(255, 250, 240, 0.98), rgba(248, 239, 214, 0.94) 58%, rgba(232, 237, 244, 0.82)),
    var(--paper);
  border-bottom: 1px solid var(--line-strong);
}

.masthead::after {
  content: "";
  position: absolute;
  right: clamp(16px, 4vw, 64px);
  bottom: -1px;
  left: clamp(16px, 4vw, 64px);
  height: 3px;
  background: repeating-linear-gradient(90deg, rgba(36, 32, 26, 0.38) 0 34px, transparent 34px 44px);
  opacity: 0.42;
}

.masthead__copy {
  max-width: 820px;
}

.masthead h1,
.professional-notes h2,
.section h2 {
  margin: 0;
  font-family: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", serif;
  letter-spacing: 0;
}

.masthead h1 {
  margin-top: 6px;
  font-size: clamp(2.25rem, 6vw, 5.2rem);
  line-height: 0.98;
}

.slogan {
  margin: 14px 0 10px;
  color: var(--cinnabar);
  font-size: clamp(1.08rem, 2.4vw, 1.55rem);
  font-weight: 900;
  line-height: 1.38;
}

.lead {
  max-width: 760px;
  margin: 0;
  color: var(--soft-ink);
  font-size: clamp(0.98rem, 1.8vw, 1.1rem);
  line-height: 1.78;
}

.eyebrow {
  margin: 0 0 8px;
  color: var(--cinnabar);
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 0.76rem;
  font-weight: 900;
  letter-spacing: 0;
}

.market-meta {
  position: relative;
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 16px;
  background: rgba(255, 250, 240, 0.76);
  border: 1px solid var(--line);
  border-radius: 6px;
  box-shadow: var(--shadow);
}

.market-meta::before {
  content: "收";
  position: absolute;
  right: 14px;
  top: -14px;
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  color: var(--cinnabar);
  border: 2px solid rgba(164, 71, 53, 0.72);
  border-radius: 5px;
  background: rgba(255, 250, 240, 0.9);
  font-weight: 900;
  transform: rotate(7deg);
}

.market-meta div {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 12px;
  align-items: baseline;
}

.market-meta dt {
  color: var(--muted);
  font-size: 0.78rem;
  font-weight: 800;
}

.market-meta dd {
  min-width: 0;
  margin: 0;
  font-weight: 900;
  overflow-wrap: anywhere;
}

.professional-notes {
  display: grid;
  grid-template-columns: minmax(220px, 0.8fr) minmax(0, 1.45fr);
  gap: 22px;
  padding: 22px clamp(14px, 4vw, 64px);
  background: rgba(255, 250, 240, 0.58);
  border-bottom: 1px solid var(--line);
}

.professional-notes__head p {
  margin: 8px 0 0;
  color: var(--soft-ink);
  line-height: 1.65;
}

.professional-notes h2 {
  font-size: clamp(1.24rem, 2.4vw, 1.7rem);
}

.professional-notes ul {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.professional-notes li {
  min-width: 0;
  padding: 10px 12px;
  border-left: 3px solid var(--line-strong);
  background: rgba(255, 250, 240, 0.72);
}

.note-title,
.note-text {
  display: block;
}

.note-title {
  color: var(--cinnabar);
  font-weight: 900;
  line-height: 1.35;
}

.note-text {
  margin-top: 4px;
  color: var(--soft-ink);
  font-size: 0.9rem;
  line-height: 1.55;
}

.note-text b {
  color: var(--ink);
}

.compliance-note {
  grid-column: 2;
  margin: 0;
  padding: 10px 12px;
  color: var(--indigo);
  background: rgba(232, 237, 244, 0.72);
  border: 1px dashed rgba(54, 83, 122, 0.42);
  border-radius: 6px;
  font-size: 0.9rem;
  font-weight: 800;
  line-height: 1.55;
}

main {
  display: grid;
  gap: 30px;
  max-width: 1220px;
  margin: 0 auto;
  padding: 26px clamp(12px, 4vw, 40px) 34px;
}

.section {
  min-width: 0;
  padding-top: 8px;
  border-top: 1px solid var(--line-strong);
}

.section--summary {
  border-top: 3px double rgba(54, 83, 122, 0.52);
}

.section__head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  padding: 0 2px 14px;
}

.section h2 {
  font-size: clamp(1.35rem, 2.8vw, 2rem);
  line-height: 1.18;
}

.summary {
  max-width: 760px;
  margin: 8px 0 0;
  color: var(--muted);
  line-height: 1.62;
}

.count,
.stance {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 48px;
  min-height: 30px;
  padding: 4px 9px;
  border-radius: 5px;
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 0.82rem;
  font-weight: 900;
  white-space: nowrap;
}

.count {
  color: var(--indigo);
  border: 1px solid rgba(54, 83, 122, 0.42);
  background: var(--indigo-soft);
}

.stance {
  background: rgba(255, 250, 240, 0.8);
  transform: rotate(-1.5deg);
}

.stance--observe {
  color: var(--jade);
  border: 1.5px solid rgba(47, 111, 95, 0.62);
}

.stance--caution {
  color: var(--cinnabar);
  border: 1.5px solid rgba(164, 71, 53, 0.66);
}

.signal-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.signal-card {
  position: relative;
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 15px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background-color: rgba(255, 250, 240, 0.92);
  background-image:
    linear-gradient(180deg, rgba(255, 255, 255, 0.46), transparent 46%),
    repeating-linear-gradient(0deg, rgba(45, 35, 23, 0.026) 0 1px, transparent 1px 8px);
  box-shadow: 0 8px 18px rgba(60, 43, 20, 0.09);
}

.signal-card::before {
  content: "";
  position: absolute;
  top: 0;
  right: 14px;
  left: 14px;
  height: 2px;
  background: linear-gradient(90deg, transparent, rgba(164, 71, 53, 0.55), transparent);
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
  font-size: 1.08rem;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.stock-title span {
  margin-top: 4px;
  color: var(--muted);
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 0.78rem;
  font-weight: 800;
}

.signal-name {
  color: var(--ink);
  font-size: 0.98rem;
  font-weight: 900;
  line-height: 1.52;
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
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 0.73rem;
  font-weight: 900;
}

.card-metrics dd,
.signal-detail dd {
  margin: 0;
  color: var(--soft-ink);
  font-size: 0.9rem;
  font-weight: 800;
  line-height: 1.42;
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
  border: 1px solid rgba(45, 35, 23, 0.14);
  border-radius: 4px;
  background: rgba(245, 231, 196, 0.58);
  color: #5f5445;
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 0.73rem;
  font-weight: 900;
}

.return-up {
  color: var(--jade);
  font-weight: 900;
}

.return-down {
  color: var(--cinnabar);
  font-weight: 900;
}

.score-row {
  padding-top: 2px;
  color: var(--muted);
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 0.82rem;
  font-weight: 900;
}

meter {
  flex: 1 1 auto;
  min-width: 72px;
  height: 8px;
}

meter::-webkit-meter-bar {
  background: rgba(45, 35, 23, 0.13);
  border: 0;
  border-radius: 8px;
}

meter::-webkit-meter-optimum-value {
  background: var(--jade);
  border-radius: 8px;
}

.score-row b {
  color: var(--ink);
  font-size: 0.94rem;
}

.signal-detail {
  border-top: 1px dashed var(--line-strong);
  padding-top: 10px;
}

.signal-detail summary {
  cursor: pointer;
  color: var(--indigo);
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 0.86rem;
  font-weight: 900;
  list-style-position: outside;
}

.signal-detail dl {
  grid-template-columns: 1fr;
  margin-top: 10px;
  padding: 11px;
  border-radius: 6px;
  background: rgba(232, 237, 244, 0.72);
}

.empty {
  padding: 28px 2px;
  color: var(--muted);
  font-weight: 800;
}

.footer {
  max-width: 1220px;
  margin: 0 auto;
  padding: 0 clamp(12px, 4vw, 40px) 38px;
}

.footer__paper {
  padding: 14px 16px;
  color: var(--soft-ink);
  border: 1px dashed var(--line-strong);
  border-radius: 6px;
  background: rgba(255, 250, 240, 0.78);
  font-size: 0.86rem;
  line-height: 1.65;
}

.footer__paper strong {
  display: block;
  margin-bottom: 6px;
  color: var(--cinnabar);
}

.footer p {
  margin: 5px 0;
}

@media (max-width: 900px) {
  .masthead {
    grid-template-columns: 1fr;
    padding-top: 26px;
  }

  .professional-notes {
    grid-template-columns: 1fr;
  }

  .professional-notes ul {
    grid-template-columns: 1fr;
  }

  .compliance-note {
    grid-column: auto;
  }

  .section__head {
    flex-direction: column;
  }

  .signal-list {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 520px) {
  .masthead {
    padding: 24px 14px 20px;
  }

  .masthead::after {
    right: 14px;
    left: 14px;
  }

  .masthead h1 {
    font-size: 2.45rem;
  }

  .slogan {
    font-size: 1.08rem;
  }

  .professional-notes {
    padding: 18px 12px;
  }

  main {
    gap: 24px;
    padding: 22px 10px 28px;
  }

  .section__head {
    padding-bottom: 12px;
  }

  .signal-card {
    padding: 13px;
  }

  .card-metrics {
    grid-template-columns: 1fr;
  }
}
`;
