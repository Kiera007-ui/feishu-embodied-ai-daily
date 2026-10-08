# 具身智能每日推 → 飞书

## 当前架构

**Vercel Cron（北京时间 09:00–09:59） → GitHub Actions `cloud-daily.yml` → 程序采集候选 → OpenAI 模型选稿 → 代码逐条核验 → GitHub OIDC → Vercel `/api/relay` → 飞书群机器人**

一次运行里完成全部步骤，不依赖 ChatGPT 后台写 GitHub，也不依赖 GitHub 自带定时器准时触发。

1. **触发**：Vercel Cron 每天 UTC 01:00 调用 `/api/cron`。Hobby 计划只保证在该小时内触发，所以实际在北京时间 09:00–09:59 之间。`/api/cron` 用 `GITHUB_DISPATCH_TOKEN` 向 GitHub 发送 `repository_dispatch`。GitHub 自带的 10:37 定时任务作为兜底，可能延迟数小时。
2. **采集**（`scripts/collect.mjs`）：36氪/硬氪全量文章流和快讯（翻页接口）、量子位、AI前线/InfoQ、极客公园、投资界、甲子光年、TechCrunch Robotics、IEEE Spectrum Robotics，按主题词筛出窗口内候选，并附 36氪点赞收藏、甲子光年阅读数。机器之心、新智元、晚点、硅星人、你好太空没有可读列表，由模型定向搜索网页版。
3. **选稿**（`scripts/generate.mjs` + `prompts/cloud-daily.md`）：OpenAI Responses API，默认模型 `gpt-6.1-sol`、推理强度 `high`，开启 `web_search` 并屏蔽新浪/网易。可用仓库变量 `OPENAI_MODEL`、`OPENAI_REASONING` 覆盖；使用兼容 OpenAI 的中转服务时，把仓库变量 `OPENAI_BASE_URL` 设为它的接口地址（形如 `https://example.com/v1`）。
4. **核验**（`scripts/cloud-daily.mjs`）：逐条打开链接，检查发布时间与首次披露时间都在窗口内、页面日期一致、事实摘录和第三方评述摘录都能在原文找到、标题不含“首发/独家”、不是新浪/网易或通稿平台、同一事件不重复。独立报道链接逐个打开，计入热度。不合格条目单独剔除并记录原因，其余照常发送。
5. **发送与存档**：通过中继发送后，提交 `queue/日期.txt`、`reports/日期.md`（来源覆盖、热度、剔除原因、待跟进）和 `state/last-success.json`。

## 条数

目标 3–6 条。少于 3 条时照常发送并在末尾注明“不足 3 条，未用旧闻补足”；没有合格内容时发送一句说明。中继和旧队列流程都接受 0–6 条，每条必须带一个中文主标签；深海、航天、低空等领域直接用领域作标签。

## 配置

| 位置 | 名称 | 用途 |
| --- | --- | --- |
| GitHub Actions secret | `OPENAI_API_KEY` | 调用模型 |
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
