# BadGuard 散户看盘小纸条

> 体验链接：<https://badguard.nizabentley397.workers.dev>

打开就看，不用选条件，不用在选股器里把自己点成迷路的韭菜。BadGuard 每天收盘后把 A 股日线里几个常见技术状态整理成 4 张小纸条：只写“观察 / 谨慎”，不写交易指令。

![BadGuard 产品预览](docs/preview.svg)

## 这是个啥

它不是股神，也不是许愿池。它更像一个嘴有点贫、但边界很清楚的看盘小本本：

- 今天又来抄底啦：低位反弹观察
- 勇敢散户向前冲：趋势转强观察
- 跌麻了，先看修复：超跌修复观察
- 别冲了，先喝口水：风险过滤榜

主页面用轻松话术降低阅读血压，专业注解单独放在“冷静区”。笑归笑，指标条件不乱写。

首页在榜单前放了一个“公司名目录”，只显示公司名称，不显示分数、不显示指标。看到熟脸可以直接点过去，少一点滚屏，多一点人类尊严。

## 专业注解

- 低位反弹观察：日线 KDJ 在 20 附近或以下金叉，且成交量放大
- 趋势转强观察：MACD 金叉 + 股价站回 5/10 日均线
- 超跌修复观察：RSI 低位回升 + BOLL 下轨收回
- 风险过滤榜：近期跌破均线、放量下跌、KDJ 高位死叉

`今日围观总览` 只汇总前三类观察信号，并按“上行观察优先级”排序。风险过滤榜只负责提醒谨慎，不混进上行排序里凑热闹。

## 页面展示什么

每只股票只展示这些字段：

- 信号名、触发日期
- 成交额、所属行业
- 近 5/20 日涨跌幅
- 风险标签
- 观察 / 谨慎
- 围观优先级或冷静指数

KDJ / MACD / RSI 的具体数值默认收起来，点“展开详情”再看。详情里还会显示“公司概况 F10 小抄”，重点放主营业务、主营构成、经营范围、公司简介、上市时间和联系方式，不重复卡片上已经写过的公司名和行业。页面不提供筛选条件，也不发出交易指令。

## 设计哲学

市场没有确定性，只有概率。技术指标不是预言，也不是“今天拜托你涨一下”的仪式；它只是把价格、成交量和波动留下的痕迹整理出来。上涨有上涨的结构，下跌有下跌的信号，普通投资者更需要看清状态，而不是追逐“必涨答案”。BadGuard 坚持简单、透明、可解释，只看少量经过长期使用的日线信号。它不是预测工具，而是市场节奏雷达：帮你看懂趋势，少一点拍脑袋。

## 每日更新

生产数据流：

1. GitHub Actions 在北京时间交易日 15:30 运行 AkShare 脚本。
2. 默认扫描成交额靠前的 1000 只活跃 A 股，生成 `data/latest.json`。
3. Actions 先写入日期快照 `signal-snapshot:YYYY-MM-DD`，再更新 `latest-signal-snapshot`。
4. Worker 读取 `latest-signal-snapshot` 渲染页面；没有 KV 时读取随代码部署的最近快照。

同一个市场日的生产快照默认不覆盖，避免同一天数据因为调试参数变化而来回跳。手动触发 `Refresh AkShare Signals` 默认只写 `staging-signal-snapshot`，可以调整 `scan_limit` 做验证；只有显式设置 `publish_production=true`，并在需要重发同日数据时设置 `force_publish=true`，才会写入生产快照。全市场扫描可以填 `scan_limit=0`，它会更慢，耐心也是一种指标。

## 公司概况 F10 库

公司基本情况不会像日线指标那样天天跳，所以项目里单独放了一个固定数据库。日常收盘刷新只更新技术信号；F10 库可以低频维护，例如一周或一个月补一次。

- `data/company-profiles.json`：页面读取的公司概况库
- `scripts/build_company_profiles.py`：从信号快照提取涉及股票，再用 AkShare 收集巨潮公司概况和东方财富主营构成

项目使用 `uv` 管理 Python 虚拟环境。首次补全 F10 时运行：

```bash
uv sync
npm run akshare:profiles
```

这会调用 AkShare 的公司概况和主营构成接口，补全主营业务、经营范围、机构简介、上市日期、办公地址、官网和主营收入占比等静态字段。脚本不会编造缺失字段；F10 数据仍建议人工抽查，毕竟连散户都知道，资料库偶尔也会犯困。

## 本地运行

```bash
npm install
uv sync
npm run akshare:build:quick
npm run akshare:profiles
npm run dev
```

打开 `http://127.0.0.1:8787`。

`akshare:build:quick` 会用真实 AkShare 数据生成快速预览快照，默认取前 500 只股票。

## Cloudflare Workers 部署

创建 KV namespace：

```bash
npx wrangler kv namespace create SIGNAL_KV
npx wrangler kv namespace create SIGNAL_KV --preview
```

把返回的 `id` 和 `preview_id` 填入 `wrangler.toml`。

GitHub Actions 需要配置：

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

`CLOUDFLARE_API_TOKEN` 建议使用最小权限 Token，至少需要 Workers Scripts 写入和 Workers KV 写入权限。不要把 API Token 写进代码或 README。

手动部署：

```bash
npm run deploy
```

## API

- `GET /api/signals`：返回当前信号快照
- `POST /api/refresh`：仅在配置兼容 JSON 行情源时手动刷新；如果配置了 `REFRESH_TOKEN`，需要请求头 `x-refresh-token`
- `GET /api/health`：健康检查

## 免责声明

BadGuard 仅用于个人学习和技术指标观察，只描述历史交易数据形成的状态，不构成投资建议、个股推荐或收益承诺。任何指标都不能保证上涨，也不能准确预测未来。请结合基本面、流动性、仓位和自己的风险承受能力判断。

## 开源协议

MIT
