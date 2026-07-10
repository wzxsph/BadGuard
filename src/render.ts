import companyProfilesJson from "../data/company-profiles.json";
import type { CompanyProfile, SignalBoard, SignalId, SignalRow, SignalSnapshot } from "./types";

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
    scoreLabel: "结构确认分"
  },
  "trend-strength": {
    title: "勇敢散户向前冲",
    professionalTitle: "趋势转强观察",
    summary: "趋势像是把鞋带系上了，但冲之前先看看路面是不是湿的。",
    technical: "MACD 金叉，并且股价重新站回 5 日和 10 日均线。",
    mood: "结构开始像那么回事了，先记一笔，别把记一笔理解成梭哈。",
    scoreLabel: "结构确认分"
  },
  "oversold-repair": {
    title: "跌麻了，先看修复",
    professionalTitle: "超跌修复观察",
    summary: "从地板上坐起来不等于马上起飞，但至少不是继续躺平。",
    technical: "RSI 从低位回升，同时价格从 BOLL 下轨附近收回。",
    mood: "修复是修复，反转是反转，中间隔着散户最容易脑补的一条河。",
    scoreLabel: "结构确认分"
  },
  "risk-filter": {
    title: "别冲了，先喝口水",
    professionalTitle: "风险过滤榜",
    summary: "市场递来一张小纸条：手慢一点，仓位轻一点，心跳稳一点。",
    technical: "近期跌破均线、放量下跌，或 KDJ 高位死叉。",
    mood: "不是说世界末日，只是这会儿更适合把手从下单按钮旁边挪开。",
    scoreLabel: "风险强度"
  }
};

const COMPANY_PROFILES = companyProfilesJson as Record<string, CompanyProfile>;
const INITIAL_VISIBLE_CARDS = 5;
const CARD_REVEAL_STEP = 10;
const INITIAL_VISIBLE_DIRECTORY_ITEMS = 30;
const DIRECTORY_REVEAL_STEP = 30;

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
  ${renderEntryNotice()}
  ${renderSiteNavigation("today")}
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
  ${renderCompanyDirectory(snapshot)}

  <main>
    ${snapshot.boards.map(renderBoard).join("")}

    <section class="section section--summary" id="daily-summary">
      <div class="section__head">
        <div>
          <p class="eyebrow">观察类 · 结构确认分</p>
          <h2>今日围观总览</h2>
          <p class="summary">只汇总观察类信号，按结构确认分排序；风险过滤榜不进这个小本本。</p>
        </div>
        <span class="count">${snapshot.topRows.length} 条</span>
      </div>
      ${renderCards(snapshot.topRows, true, "summary", "daily-summary-signals")}
    </section>
  </main>

  <footer class="footer" aria-label="免责声明">
    <div class="footer__paper">
      <strong>冷静免责声明</strong>
      ${snapshot.disclaimers.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}
    </div>
  </footer>
  <script>${JS}</script>
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

function renderSiteNavigation(active: "today" | "history"): string {
  return `<nav class="site-nav" aria-label="榜单视图">
    <a href="/"${active === "today" ? ' aria-current="page"' : ""}>今日榜单</a>
    <a href="/history"${active === "history" ? ' aria-current="page"' : ""}>历史复盘</a>
  </nav>`;
}

function renderEntryNotice(): string {
  return `<section class="entry-notice" data-entry-notice role="dialog" aria-modal="true" aria-labelledby="entry-notice-title" hidden>
    <div class="entry-notice__paper">
      <p class="eyebrow">进入前先冷静 10 秒</p>
      <h2 id="entry-notice-title">免责声明与名词注解</h2>
      <p>BadGuard 仅用于个人学习、复盘和技术指标观察，只描述历史交易数据形成的市场状态，不构成投资建议、个股推荐或收益承诺。</p>
      <dl>
        <div><dt>观察 / 谨慎</dt><dd>只是状态标签，不是交易指令。</dd></div>
        <div><dt>结构确认分</dt><dd>用于观察类信号排序，综合趋势、量能、修复质量、近期表现和风险扣分；它不是上涨概率。</dd></div>
        <div><dt>风险强度</dt><dd>用于风险过滤榜排序，来自跌破均线、放量下跌、KDJ 高位死叉等风险项。</dd></div>
        <div><dt>大票优先门槛</dt><dd>三个观察榜只保留流通市值不少于 50 亿元、当日成交额不少于 2 亿元的股票；这是流动性控制，不是收益保证。</dd></div>
        <div><dt>KDJ / MACD / RSI / BOLL</dt><dd>均为日线技术指标，只是把价格、成交量和波动痕迹量化，不负责预测未来。</dd></div>
      </dl>
      <p class="entry-notice__fineprint">市场没有确定性，只有概率。看懂趋势，比预测涨跌更重要。</p>
      <button class="entry-notice__accept" type="button" data-entry-accept>我已知晓，进入小纸条</button>
    </div>
  </section>`;
}

function renderCompanyDirectory(snapshot: SignalSnapshot): string {
  const rows = getDirectoryRows(snapshot);
  if (rows.length === 0) {
    return "";
  }

  const links = rows
    .map((row, index) => {
      const copy = SIGNAL_COPY[row.signalId];
      return `<a class="directory-link" href="#${cardId(row, "board")}" aria-label="${escapeHtml(row.name)}，${escapeHtml(copy.professionalTitle)}" data-progress-item${index >= INITIAL_VISIBLE_DIRECTORY_ITEMS ? " hidden" : ""}>${escapeHtml(row.name)}</a>`;
    })
    .join("");
  const moreButton = rows.length > INITIAL_VISIBLE_DIRECTORY_ITEMS
    ? `<button class="show-more show-more--directory" type="button" data-progress-more aria-controls="company-directory-list">
        <span>【展示更多】</span>
        <small data-progress-hint>再看 ${Math.min(DIRECTORY_REVEAL_STEP, rows.length - INITIAL_VISIBLE_DIRECTORY_ITEMS)} 个，还剩 ${rows.length - INITIAL_VISIBLE_DIRECTORY_ITEMS} 个</small>
      </button>`
    : "";

  return `<nav class="company-directory" id="company-directory" aria-label="公司名称目录">
    <div class="company-directory__head">
      <p class="eyebrow">公司名目录 · 只看名字</p>
      <h2>先别看指标，看看今天谁递纸条</h2>
      <p>只列公司名称。点一下名字，直接跳到对应纸条；适合先扫一眼有没有熟脸。</p>
    </div>
    <div class="directory-shell" data-progressive-list data-step="${DIRECTORY_REVEAL_STEP}">
      <div class="directory-list" id="company-directory-list">${links}</div>
      ${moreButton}
    </div>
  </nav>`;
}

function getDirectoryRows(snapshot: SignalSnapshot): SignalRow[] {
  const seen = new Set<string>();
  const rows: SignalRow[] = [];

  for (const board of snapshot.boards) {
    for (const row of board.rows) {
      if (seen.has(row.code)) {
        continue;
      }

      seen.add(row.code);
      rows.push(row);
    }
  }

  return rows;
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
    ${renderCards(board.rows, false, "board", `${board.id}-signals`)}
  </section>`;
}

function renderCards(rows: SignalRow[], showSignal: boolean, variant: "board" | "summary", listId: string): string {
  if (rows.length === 0) {
    return `<div class="empty">今日这张纸条空空如也，市场暂时没递话。</div>`;
  }

  const moreButton = rows.length > INITIAL_VISIBLE_CARDS
    ? `<button class="show-more" type="button" data-progress-more aria-controls="${escapeHtml(listId)}">
        <span>【展示更多】</span>
        <small data-progress-hint>再看 ${Math.min(CARD_REVEAL_STEP, rows.length - INITIAL_VISIBLE_CARDS)} 个，还剩 ${rows.length - INITIAL_VISIBLE_CARDS} 个</small>
      </button>`
    : "";

  return `<div class="signal-list-shell" data-progressive-list data-step="${CARD_REVEAL_STEP}">
    <div class="signal-list" id="${escapeHtml(listId)}">
      ${rows.map((row, index) => renderCard(row, showSignal, variant, index >= INITIAL_VISIBLE_CARDS)).join("")}
    </div>
    ${moreButton}
  </div>`;
}

function renderCard(row: SignalRow, showSignal: boolean, variant: "board" | "summary", hidden: boolean): string {
  const stanceClass = row.stance === "谨慎" ? "caution" : "observe";
  const copy = SIGNAL_COPY[row.signalId];
  const companyProfile = getCompanyProfile(row);

  return `<article class="signal-card" id="${cardId(row, variant)}" data-progress-card data-progress-item${hidden ? " hidden" : ""}>
    <div class="card-topline">
      <div class="stock-title">
        <strong>${escapeHtml(row.name)}</strong>
        <span>${escapeHtml(row.code)}</span>
      </div>
      <span class="stance stance--${stanceClass}">${row.stance}</span>
    </div>

    <div class="signal-name">${escapeHtml(showSignal ? copy.title : copy.mood)}</div>

    <dl class="card-metrics">
      <div class="metric-pair metric-pair--date-return">
        <div><dt>触发日期</dt><dd>${escapeHtml(row.triggerDate)}</dd></div>
        <div><dt>近5/20日</dt><dd><span class="${returnClass(row.change5d)}">${formatPercent(row.change5d)}</span> / <span class="${returnClass(row.change20d)}">${formatPercent(row.change20d)}</span></dd></div>
      </div>
      <div class="metric-pair metric-pair--amount-industry">
        <div><dt>成交额</dt><dd>${formatAmount(row.amount)}</dd></div>
        <div><dt>所属行业</dt><dd>${escapeHtml(row.industry)}</dd></div>
      </div>
      <div class="metric-pair metric-pair--liquidity">
        <div><dt>流通市值</dt><dd>${formatMarketCap(row.floatMarketCap)}</dd></div>
        <div><dt>换手率</dt><dd>${formatTurnoverRate(row.turnoverRate)}</dd></div>
      </div>
    </dl>

    <div class="tag-row" aria-label="风险标签">
      ${row.riskTags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
      ${(row.liquidityTags || []).map((tag) => `<span class="tag tag--liquidity">${escapeHtml(tag)}</span>`).join("")}
    </div>

    <div class="score-row">
      <span>${escapeHtml(copy.scoreLabel)}</span>
      <meter min="0" max="100" value="${row.signalStrength}"></meter>
      <b>${row.signalStrength}</b>
    </div>

    <details class="signal-detail">
      <summary>展开详情</summary>
      ${renderCompanyProfile(companyProfile)}
      <dl class="indicator-detail">
        <div><dt>专业注解</dt><dd>${escapeHtml(copy.professionalTitle)}：${escapeHtml(row.signalName)}</dd></div>
        <div><dt>KDJ</dt><dd>K ${formatNumber(row.indicators.kdj.k)} / D ${formatNumber(row.indicators.kdj.d)} / J ${formatNumber(row.indicators.kdj.j)}</dd></div>
        <div><dt>MACD</dt><dd>DIF ${formatNumber(row.indicators.macd.dif)} / DEA ${formatNumber(row.indicators.macd.dea)} / H ${formatNumber(row.indicators.macd.histogram)}</dd></div>
        <div><dt>RSI</dt><dd>${formatNumber(row.indicators.rsi)}</dd></div>
      </dl>
    </details>
  </article>`;
}

function cardId(row: Pick<SignalRow, "code" | "signalId">, variant: "board" | "summary"): string {
  return `${variant === "board" ? "stock" : "summary"}-${row.code}-${row.signalId}`;
}

function getCompanyProfile(row: Pick<SignalRow, "code" | "name" | "industry">): CompanyProfile {
  const profile = COMPANY_PROFILES[row.code];
  if (profile) {
    return {
      ...profile,
      name: profile.name || row.name,
      industry: profile.industry || row.industry
    };
  }

  return {
    code: row.code,
    name: row.name,
    industry: row.industry || "未分类",
    market: inferMarket(row.code),
    profileSource: "signal-snapshot",
    updatedAt: "",
    mainBusiness: "",
    businessScope: "",
    organizationProfile: "",
    businessComposition: [],
    note: "暂未抓到完整 F10，只保留信号快照里的基础识别信息；别急，这家公司资料还在路上。"
  };
}

function renderCompanyProfile(profile: CompanyProfile): string {
  const sourceLabel = profile.profileSource === "akshare-f10" ? "F10 已收录" : "资料待补";
  const rows = buildCompanyProfileRows(profile);

  return `<section class="company-profile" aria-label="公司概况F10">
    <div class="company-profile__title">
      <h3>公司概况 F10 小抄</h3>
      <span>${escapeHtml(sourceLabel)}</span>
    </div>
    <dl>
      ${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
    </dl>
    ${profile.note ? `<p>${escapeHtml(profile.note)}</p>` : ""}
  </section>`;
}

function buildCompanyProfileRows(profile: CompanyProfile): Array<[string, string]> {
  const profileRows: Array<[string, string]> = [
    ["主营业务", profile.mainBusiness || ""],
    ["主营构成", formatBusinessComposition(profile)],
    ["经营范围", profile.businessScope || ""],
    ["公司小传", profile.organizationProfile || ""],
    ["上市/成立", formatProfileDates(profile)],
    ["注册/办公", formatProfileAddress(profile)],
    ["法人/注册资本", formatRepresentative(profile)],
    ["官网/联系", formatProfileContact(profile)]
  ];
  const rows = profileRows.filter(([, value]) => value.trim().length > 0);

  if (rows.length === 0) {
    return [["资料状态", "F10 还没收集到，当前只展示技术信号；这家公司先记在小本本上。"]];
  }

  return rows;
}

function formatBusinessComposition(profile: CompanyProfile): string {
  const segments = (profile.businessComposition || [])
    .filter((segment) => segment.name)
    .slice(0, 4);

  if (segments.length === 0) {
    return "";
  }

  const reportDate = segments[0].reportDate ? `${segments[0].reportDate}：` : "";
  const summary = segments
    .map((segment) => {
      const revenueRatio = typeof segment.revenueRatioPct === "number" ? `收入占比 ${formatNumber(segment.revenueRatioPct)}%` : "";
      const grossMargin = typeof segment.grossMarginPct === "number" ? `毛利率 ${formatNumber(segment.grossMarginPct)}%` : "";
      return [segment.name, revenueRatio, grossMargin].filter(Boolean).join(" / ");
    })
    .join("；");

  return `${reportDate}${summary}`;
}

function formatProfileDates(profile: CompanyProfile): string {
  const items = [
    profile.listingDate ? `上市 ${profile.listingDate}` : "",
    profile.establishedDate ? `成立 ${profile.establishedDate}` : ""
  ].filter(Boolean);
  return items.join("；");
}

function formatProfileAddress(profile: CompanyProfile): string {
  const items = [
    profile.region ? `地区 ${profile.region}` : "",
    profile.officeAddress ? `办公 ${profile.officeAddress}` : "",
    profile.registeredAddress && profile.registeredAddress !== profile.officeAddress ? `注册 ${profile.registeredAddress}` : ""
  ].filter(Boolean);
  return items.join("；");
}

function formatRepresentative(profile: CompanyProfile): string {
  const items = [
    profile.legalRepresentative ? `法人 ${profile.legalRepresentative}` : "",
    profile.registeredCapital ? `注册资金 ${profile.registeredCapital}` : ""
  ].filter(Boolean);
  return items.join("；");
}

function formatProfileContact(profile: CompanyProfile): string {
  const items = [
    profile.website ? `官网 ${profile.website}` : "",
    profile.phone ? `电话 ${profile.phone}` : "",
    profile.email ? `邮箱 ${profile.email}` : ""
  ].filter(Boolean);
  return items.join("；");
}

function inferMarket(code: string): string {
  if (code.startsWith("6")) {
    return "上交所";
  }

  if (code.startsWith("8") || code.startsWith("4")) {
    return "北交所";
  }

  return "深交所";
}

function formatAmount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "暂无数据";
  }

  if (Math.abs(value) >= 100000000) {
    return `${formatNumber(value / 100000000)}亿`;
  }

  return `${formatNumber(value / 10000)}万`;
}

function formatMarketCap(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "暂无数据";
  }

  return `${formatNumber(value / 100000000)}亿`;
}

function formatTurnoverRate(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "暂无数据";
  }

  return `${formatNumber(value)}%`;
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
  min-width: 0;
  background-color: var(--rice);
  background-image:
    repeating-linear-gradient(0deg, rgba(47, 38, 24, 0.035) 0 1px, transparent 1px 7px),
    repeating-linear-gradient(90deg, rgba(47, 38, 24, 0.025) 0 1px, transparent 1px 9px);
  color: var(--ink);
  font-family: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", "PingFang SC", "Microsoft YaHei", serif;
  letter-spacing: 0;
}

.site-nav {
  display: flex;
  justify-content: center;
  gap: 8px;
  padding: 12px clamp(12px, 4vw, 40px) 0;
}

.site-nav a {
  display: inline-flex;
  align-items: center;
  min-height: 38px;
  padding: 7px 14px;
  color: var(--soft-ink);
  text-decoration: none;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: rgba(255, 250, 240, 0.72);
  font-weight: 900;
}

.site-nav a[aria-current="page"] {
  color: #fffaf0;
  border-color: var(--indigo);
  background: var(--indigo);
}

body.notice-open {
  overflow: hidden;
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

.entry-notice {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 18px;
  background:
    radial-gradient(circle at 50% 8%, rgba(255, 250, 240, 0.28), transparent 34%),
    rgba(36, 32, 26, 0.52);
  backdrop-filter: blur(3px);
}

.entry-notice[hidden] {
  display: none !important;
}

.entry-notice__paper {
  width: min(100%, 720px);
  max-height: min(86vh, 760px);
  overflow: auto;
  padding: clamp(18px, 4vw, 28px);
  color: var(--ink);
  background:
    linear-gradient(135deg, rgba(255, 250, 240, 0.96), rgba(248, 239, 214, 0.92)),
    var(--paper);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  box-shadow: 0 26px 70px rgba(36, 32, 26, 0.28);
}

.entry-notice h2 {
  margin: 0 0 12px;
  font-size: clamp(1.35rem, 4vw, 2rem);
  line-height: 1.18;
}

.entry-notice p {
  margin: 0;
  color: var(--soft-ink);
  line-height: 1.7;
}

.entry-notice dl {
  display: grid;
  gap: 10px;
  margin: 16px 0;
}

.entry-notice dl div {
  padding: 10px 12px;
  background: rgba(255, 250, 240, 0.72);
  border-left: 3px solid var(--line-strong);
}

.entry-notice dt {
  margin-bottom: 4px;
  color: var(--cinnabar);
  font-weight: 900;
}

.entry-notice dd {
  margin: 0;
  color: var(--soft-ink);
  font-size: 0.92rem;
  line-height: 1.58;
}

.entry-notice__fineprint {
  color: var(--indigo) !important;
  font-weight: 900;
}

.entry-notice__accept {
  width: 100%;
  min-height: 44px;
  margin-top: 16px;
  padding: 10px 14px;
  color: var(--paper);
  background: var(--ink);
  border: 1px solid var(--ink);
  border-radius: 6px;
  font: inherit;
  font-weight: 900;
  cursor: pointer;
}

.entry-notice__accept:focus-visible {
  outline: 3px solid rgba(164, 71, 53, 0.36);
  outline-offset: 3px;
}

.entry-notice__accept:hover {
  background: var(--cinnabar);
  border-color: var(--cinnabar);
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

.company-directory {
  max-width: 1220px;
  margin: 22px auto 0;
  padding: 0 clamp(12px, 4vw, 40px);
}

.company-directory__head {
  display: grid;
  gap: 4px;
  margin-bottom: 12px;
}

.company-directory__head h2 {
  margin: 0;
  font-size: clamp(1.26rem, 2.4vw, 1.7rem);
  line-height: 1.25;
}

.company-directory__head p {
  margin: 0;
  color: var(--muted);
  line-height: 1.55;
}

.directory-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: rgba(255, 250, 240, 0.7);
}

.directory-shell {
  display: grid;
  gap: 10px;
}

.directory-link {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 4px 8px;
  color: var(--soft-ink);
  text-decoration: none;
  border-bottom: 1px solid rgba(164, 71, 53, 0.4);
  background: rgba(245, 231, 196, 0.38);
  font-weight: 900;
  line-height: 1.25;
}

.directory-link:hover {
  color: var(--cinnabar);
  background: rgba(250, 232, 223, 0.72);
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

[hidden] {
  display: none !important;
}

.signal-list-shell {
  display: grid;
  gap: 12px;
}

.show-more {
  justify-self: center;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 7px 12px;
  color: var(--indigo);
  border: 1px solid rgba(54, 83, 122, 0.38);
  border-radius: 6px;
  background: rgba(255, 250, 240, 0.86);
  box-shadow: 0 5px 12px rgba(60, 43, 20, 0.08);
  cursor: pointer;
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
  font-weight: 900;
}

.show-more:hover {
  color: var(--cinnabar);
  border-color: rgba(164, 71, 53, 0.5);
  background: rgba(250, 232, 223, 0.72);
}

.show-more small {
  color: var(--muted);
  font-size: 0.76rem;
  font-weight: 800;
}

.show-more--directory {
  justify-self: start;
  margin-left: 4px;
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
.indicator-detail {
  display: grid;
  gap: 10px 12px;
  margin: 0;
}

.card-metrics {
  grid-template-columns: 1fr;
}

.indicator-detail {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.metric-pair {
  display: grid;
  grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr);
  gap: 10px;
  align-items: start;
}

.metric-pair--amount-industry {
  grid-template-columns: minmax(92px, 0.8fr) minmax(0, 1.2fr);
}

.card-metrics div,
.indicator-detail div,
.company-profile div {
  min-width: 0;
}

.card-metrics dt,
.indicator-detail dt,
.company-profile dt {
  margin-bottom: 3px;
  color: var(--muted);
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 0.73rem;
  font-weight: 900;
}

.card-metrics dd,
.indicator-detail dd,
.company-profile dd {
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

.tag--liquidity {
  color: var(--indigo);
  border-color: rgba(54, 83, 122, 0.35);
  background: rgba(232, 237, 244, 0.58);
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

.company-profile {
  margin-top: 10px;
  padding: 11px;
  border: 1px solid rgba(54, 83, 122, 0.24);
  border-radius: 6px;
  background: rgba(255, 250, 240, 0.72);
}

.company-profile__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.company-profile h3 {
  margin: 0;
  font-size: 1rem;
  line-height: 1.3;
}

.company-profile__title span {
  flex: 0 0 auto;
  padding: 3px 7px;
  color: var(--indigo);
  border: 1px solid rgba(54, 83, 122, 0.34);
  border-radius: 4px;
  font-size: 0.72rem;
  font-weight: 900;
}

.company-profile dl {
  display: grid;
  gap: 8px;
  margin: 0;
}

.company-profile p {
  margin: 9px 0 0;
  color: var(--muted);
  font-size: 0.82rem;
  line-height: 1.55;
}

.indicator-detail {
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

  .metric-pair {
    grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr);
    gap: 8px;
  }
}
`;

const JS = `
(() => {
  const noticeKey = "badguard-entry-notice-accepted-v1";
  const notice = document.querySelector("[data-entry-notice]");
  const acceptNoticeButton = document.querySelector("[data-entry-accept]");
  const getItems = (wrapper) => Array.from(wrapper.querySelectorAll("[data-progress-item]"));

  const hasAcceptedNotice = () => {
    try {
      return window.localStorage.getItem(noticeKey) === "true";
    } catch (_error) {
      return false;
    }
  };

  const rememberNotice = () => {
    try {
      window.localStorage.setItem(noticeKey, "true");
    } catch (_error) {
      // Private browsing or strict storage settings should not block the page.
    }
  };

  const closeNotice = () => {
    if (!notice) {
      return;
    }

    notice.hidden = true;
    document.body.classList.remove("notice-open");
  };

  if (notice && acceptNoticeButton && !hasAcceptedNotice()) {
    notice.hidden = false;
    document.body.classList.add("notice-open");
    requestAnimationFrame(() => acceptNoticeButton.focus({ preventScroll: true }));
  }

  const updateButton = (wrapper) => {
    const button = wrapper.querySelector("[data-progress-more]");
    if (!button) {
      return;
    }

    const items = getItems(wrapper);
    const hiddenCount = items.filter((item) => item.hidden).length;
    if (hiddenCount <= 0) {
      button.hidden = true;
      return;
    }

    const step = Number(wrapper.dataset.step || 10);
    const nextCount = Math.min(step, hiddenCount);
    const hint = button.querySelector("[data-progress-hint]");
    button.hidden = false;
    if (hint) {
      hint.textContent = "再看 " + nextCount + " 个，还剩 " + hiddenCount + " 个";
    }
  };

  const revealCards = (wrapper, targetIndex) => {
    const items = getItems(wrapper);
    const firstHiddenIndex = items.findIndex((item) => item.hidden);
    const visibleCount = firstHiddenIndex === -1 ? items.length : firstHiddenIndex;
    const step = Number(wrapper.dataset.step || 10);
    const nextVisibleCount = typeof targetIndex === "number"
      ? Math.max(visibleCount, targetIndex + 1)
      : Math.min(items.length, visibleCount + step);

    items.slice(0, nextVisibleCount).forEach((item) => {
      item.hidden = false;
    });
    updateButton(wrapper);
  };

  document.querySelectorAll("[data-progressive-list]").forEach(updateButton);

  acceptNoticeButton?.addEventListener("click", () => {
    rememberNotice();
    closeNotice();
  });

  document.addEventListener("click", (event) => {
    const moreButton = event.target.closest("[data-progress-more]");
    if (moreButton) {
      const wrapper = moreButton.closest("[data-progressive-list]");
      if (wrapper) {
        revealCards(wrapper);
      }
      return;
    }

    const anchor = event.target.closest('a[href^="#stock-"], a[href^="#summary-"]');
    if (!anchor) {
      return;
    }

    const id = decodeURIComponent(anchor.getAttribute("href").slice(1));
    const target = document.getElementById(id);
    if (!target || !target.hidden) {
      return;
    }

    const wrapper = target.closest("[data-progressive-list]");
    if (!wrapper) {
      return;
    }

    event.preventDefault();
    const targetIndex = getItems(wrapper).indexOf(target);
    revealCards(wrapper, targetIndex);
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    history.replaceState(null, "", "#" + id);
  });
})();
`;
