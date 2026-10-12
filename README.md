# 具身智能每日推 → 飞书

## 当前架构

**Vercel Cron → GitHub Actions `cloud-daily.yml` → 程序采集 → 模型分步骤选稿 → 代码逐条核验 → GitHub OIDC → Vercel `/api/relay` → 飞书群机器人**

云端流程是唯一的自动发送方。其他工具写进 `queue/` 的草稿不会触发发送；需要人工补发时，把推送文本提交到 `manual/日期.txt`。

1. **触发**：Vercel Cron 每天两次调用 `/api/cron`：UTC 00:00（北京时间 08:00–08:59 内某刻，主运行，早于 08:30 时先等到 08:30）和 UTC 02:00（北京时间 10:00–10:59，备用）。GitHub 自带的 11:00 定时是最后兜底，可能延迟数小时。当天已发送或已尝试发送时，后续运行自动跳过。
2. **窗口**：每期覆盖当天 08:30 之前的 36 小时；与前 3 期已发送内容按事件去重（`sent/`，2026.10.12 及以前读 `queue/`）。
3. **采集**（`scripts/collect.mjs`）：36氪/硬氪文章流和快讯（按作者识别量子位、新智元等同步账号）、量子位、机器之心（官网数据接口）、晚点LatePost（官网列表，文章页读到分钟）、极客公园、投资界、AI前线/InfoQ、甲子光年、TechCrunch Robotics、IEEE Spectrum Robotics。同一篇文章同时在媒体官网和 36氪出现时，保留官网链接。硅星人、你好太空没找到新浪/网易以外的固定网页，有可读网页时才用。
4. **选稿**（`scripts/select.mjs` + `prompts/rules.md` + `prompts/cases.md`）：
   - 补查：两次联网检索，补齐新智元、硅星人、你好太空和列表为空的来源，并按主题广泛检索；新找到的网页由程序自己打开读取。
   - 初筛：把候选按事件归组，剔除旧闻和重复，按重要性和热度挑出最多 12 个事件。
   - 核查：每个事件单独一次联网核查（首次披露时间、媒体来源、官网链接、独立报道），并发 4 个。
   - 主编：去重、排序，最多留 8 条交给代码核验。
   默认模型 `gpt-6.1-sol`；可用仓库变量 `OPENAI_MODEL`、`DAILY_MAX_EVENTS`、`DAILY_CONCURRENCY` 调整。
5. **来源规则**：名单内及其他专业媒体本身就是第三方，其报道（包括首发、独家）可直接作来源。机器人公司自己发布的内容只能作佐证，必须用媒体报道作来源。新浪、网易不能作最终链接。
6. **核验**（`scripts/cloud-daily.mjs`）：逐条打开链接，检查两个时间都在窗口内、页面日期一致、事实摘录能在原文找到、不是公司自发材料或新浪/网易、不与当期或前 3 期重复。来源覆盖缺口只写进报告，不阻止发送。
7. **发送与存档**：中继发送成功后，提交 `sent/日期.txt`、`reports/日期.md` 和 `state/last-success.json`。

## 试跑

Actions → Cloud embodied AI daily → Run workflow，mode 选 dry，可填 date 重放某一期（只生成和校验，不发送）。

## 条数

目标 3–6 条。少于 3 条时照常发送并在末尾注明“不足 3 条，未用旧闻补足”；没有合格内容时发送一句说明。每条必须带一个中文主标签；深海、航天、低空等领域直接用领域作标签。

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

发送前先提交 `state/last-attempt.json` 占位，再调用中继；当天已有成功或尝试记录的运行一律跳过。中继结果不确定时不自动重试，避免重复发送。旧的 `daily-feishu.yml` 队列流程仍可用于人工兜底，同样读取这两个记录文件。

## 鉴权

`/api/relay` 只接受本仓库 main 分支指定工作流的 GitHub OIDC token。`cloud-daily.yml` 的定时、`repository_dispatch` 和手动运行可以真实发送，提交 `ops/dry-run.txt` 触发的运行只能试跑；`daily-feishu.yml` 只接受 push。

