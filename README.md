# BadGuard 每日技术信号榜

> 体验链接：<https://badguard.nizabentley397.workers.dev>

打开就看，不用选条件，不用研究一堆按钮，也不用在选股器里迷路。BadGuard 每天收盘后把 A 股日线里的几个常见技术信号整理成 4 个固定榜单，只写“观察 / 谨慎”，不写“买入 / 卖出”。

![BadGuard 手机竖屏预览](docs/preview.png)

## 它想解决什么

很多新手不是不努力，是一打开复杂行情软件就像走进驾驶舱：灯都在闪，但不知道哪盏灯和自己有关。

BadGuard 做的事情很朴素：把 KDJ、MACD、RSI、均线、成交量这些指标翻译成人话，让你快速知道今天市场里哪些票出现了“可解释的技术状态”，哪些地方正在转强，哪些地方该先把手放稳。

## 设计哲学

市场没有确定性，只有概率。技术指标不是预言，也不是许愿池投币机；它只是把价格、成交量和波动留下的痕迹整理出来。上涨有上涨的结构，下跌有下跌的信号，普通投资者更需要看清状态，而不是追逐“必涨答案”。BadGuard 坚持简单、透明、可解释，只看少量经过长期使用的日线信号，尤其关注 KDJ、MACD、均线、RSI、BOLL 和量能变化。它不是预测工具，而是市场节奏雷达：帮你看懂趋势，少一点拍脑袋。

## 四个固定榜单

- 低位反弹观察：日线 KDJ 在 20 附近或以下金叉，且成交量放大
- 趋势转强观察：MACD 金叉 + 股价站回 5/10 日均线
- 超跌修复观察：RSI 低位回升 + BOLL 下轨收回
- 风险过滤榜：近期跌破均线、放量下跌、KDJ 高位死叉

`今日信号总览` 只汇总前三类观察信号，并按“上行观察优先级”排序。风险过滤榜只负责提醒谨慎，不混进上行排序里凑热闹。

## 页面展示什么

每只股票只展示这些字段：

- 信号名、触发日期
- 成交额、所属行业
- 近 5/20 日涨跌幅
- 风险标签
- 观察 / 谨慎
- 上行观察优先级或风险强度

KDJ / MACD / RSI 的具体数值默认收起来，点“查看详情”再看。页面不提供筛选条件，也不发出交易指令。

## 每日更新

生产数据流：

1. GitHub Actions 在北京时间交易日 15:30 运行 AkShare 脚本。
2. 默认扫描成交额靠前的 1000 只活跃 A 股，生成 `data/latest.json`。
3. Actions 把快照上传到 Cloudflare Workers KV 的 `latest-signal-snapshot`。
4. Worker 读取 KV 渲染页面；没有 KV 时读取随代码部署的最近快照。

手动触发 `Refresh AkShare Signals` 时可以调整 `scan_limit`，填 `0` 可尝试全市场扫描。全市场会更慢，耐心也是一种指标。

## 本地运行

```bash
npm install
python3 -m pip install -r requirements.txt
npm run akshare:build:quick
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

当前部署：

- `CLOUDFLARE_ACCOUNT_ID`: `c150f9a81fd3d95a9c31d5751c99eabc`
- `SIGNAL_KV id`: `b1aa99421784423cb2669d98ffb302eb`
- `SIGNAL_KV preview_id`: `f20d6971ccb24ec68ae81768e1f0ca8e`

手动部署：

```bash
npm run deploy
```

## API

- `GET /api/signals`：返回当前信号快照
- `POST /api/refresh`：仅在配置兼容 JSON 行情源时手动刷新；如果配置了 `REFRESH_TOKEN`，需要请求头 `x-refresh-token`
- `GET /api/health`：健康检查

## 免责声明

BadGuard 只描述历史交易数据形成的技术状态，不构成投资建议。任何指标都不能保证上涨，也不能准确预测未来。请结合基本面、流动性、仓位和自己的风险承受能力判断。

## 开源协议

MIT
