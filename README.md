# 具身智能每日推 → 飞书

## 当前架构

**Vercel Cron → GitHub Actions `cloud-daily.yml` → 程序采集 → 模型分步骤选稿 → 代码逐条核验 → GitHub OIDC → Vercel `/api/relay` → 飞书群机器人**

云端流程是唯一发送方。其他工具写进 `queue/` 或 `manual/` 的草稿不会触发发送；旧网页直发接口返回 410，旧手动发送工作流已移除，中继也拒绝它的身份。

1. **触发**：Vercel Cron 每天两次调用 `/api/cron`：UTC 00:00（北京时间 08:00–08:59 内某刻，主运行，早于 08:30 时先等到 08:30）和 UTC 02:00（北京时间 10:00–10:59，备用）。GitHub 自带的 11:00 定时是最后兜底，可能延迟数小时。当天已发送或已尝试发送时，后续运行自动跳过。
2. **窗口**：每期覆盖当天 08:30 之前的 36 小时；与前 3 期已发送内容按事件去重（`sent/`，2026.10.12 及以前读 `queue/`）。
3. **采集**（`scripts/collect.mjs`）：唯一允许的 11 个发布渠道为 36氪/硬氪、量子位、机器之心、新智元、晚点LatePost、极客公园、投资界、AI前线/InfoQ、甲子光年、硅星人、你好太空。文章流、RSS、按渠道搜索共同召回；新智元、硅星人、你好太空没有固定列表时也必须定向检索并记录覆盖缺口。同步账号页必须能核实发布者。
4. **选稿**（`scripts/select.mjs` + `prompts/rules.md` + `prompts/cases.md`）：
   - 补查：两次联网检索，只在允许发布域名内补齐各渠道并按主题检索；新找到的网页由程序自己打开并核验发布者。
   - 初筛：把候选按事件归组，剔除旧闻和重复，按重要性和热度挑出最多 12 个事件。
   - 核查：每个事件单独一次联网核查（首次披露时间、媒体来源、官网链接、独立报道），并发 4 个。
   - 主编：去重、排序，最多留 8 条交给代码核验。
   默认模型 `gpt-6.1-sol`；可用仓库变量 `OPENAI_MODEL`、`DAILY_MAX_EVENTS`、`DAILY_CONCURRENCY` 调整。
5. **来源规则**（`lib/source-policy.js`）：按发布渠道判断，名单内媒体刊登的转载／编译也可以入选，无需独立采写。例如 36氪转载彭博报道时保留 36氪链接、来源写 36氪；不能直接用彭博、科创板日报等名单外页面，也不能在核查或热度佐证中绕过名单。不足条数不放宽渠道。
6. **核验**（`scripts/cloud-daily.mjs`）：逐条打开链接，校验发布媒体与域名／账号、跳转后网址、两个时间、页面日期、事实摘录和跨期去重。检索工具使用允许域名名单；代码在采集、选稿和发送中继再次校验，失败则剔除／拒发。来源覆盖缺口写进报告，不阻止其他合格条目发送。
7. **发送与存档**：中继发送成功后，提交 `sent/日期.txt`、`reports/日期.md` 和 `state/last-success.json`。

## 试跑

Actions → Cloud embodied AI daily → Run workflow，mode 选 dry，可填 date 重放某一期（只生成和校验，不发送）。

## 条数

目标 3–6 条。只按最终展示标签计数，每个标签最多 3 条，其余标签不额外占融资名额。先读正文核查重要性，再根据有价值的核心内容选标签；低价值融资官宣直接剔除，不能为了保留而改标签。领域标签需有具体能力、应用、订单、部署或产业化事实支撑。超过三条时比较重要性后取舍，模型排序后，代码和发送中继再次检查上限。少于 3 条时照常发送并在末尾注明“不足 3 条，未用旧闻补足”；没有合格内容时发送一句说明。每条必须带一个中文主标签；深海、航天、低空等领域直接用领域作标签。

## 配置

| 位置 | 名称 | 用途 |
| --- | --- | --- |
| GitHub Actions secret | `OPENAI_API_KEY` | 调用模型 |
| GitHub Actions variable | `OPENAI_BASE_URL` | 模型接口地址，当前为 `https://cloud.dataeyes.ai/v1`；不设置时使用 OpenAI 官方接口 |
| Vercel env (Production) | `GITHUB_DISPATCH_TOKEN` | fine-grained PAT，仅本仓库，Contents 读写，用于触发工作流 |
| Vercel env (Production) | `CRON_SECRET` | Vercel Cron 自动带上，防止他人调用 `/api/cron` |
| Vercel env | `FEISHU_WEBHOOK_URL` | 已有，飞书机器人地址 |
| 仓库文件 | `config/pipeline.json` | `cloud_daily_enabled` 为 true 时，定时触发才会真正发送 |

## 手动运行

- **试跑不发送**：Actions → Cloud embodied AI daily → Run workflow，mode 选 `dry`；或修改并提交 `ops/dry-run.txt`。
- **手动补发**：mode 选 `live`。当天已有发送或发送尝试记录时会自动跳过。
- 每次运行的候选清单、模型输出、核验结果和推送文本都保存在该运行的 Artifacts 中，摘要页直接显示运行报告。

## 防重复

发送前先提交 `state/last-attempt.json` 占位，再调用中继；当天已有成功或尝试记录的运行一律跳过。中继结果不确定时不自动重试，避免重复发送。手动启动也必须经过同一个云端流程及同一套防重复检查。

## 鉴权

`/api/relay` 只接受本仓库 main 分支 `cloud-daily.yml` 的 GitHub OIDC token。定时、`repository_dispatch` 和手动运行可以真实发送，提交 `ops/dry-run.txt` 触发的运行只能试跑；其他工作流均被拒绝。旧 `/api/send` 对所有方法返回 410，不调用飞书。

