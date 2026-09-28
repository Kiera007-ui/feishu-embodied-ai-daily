# 具身智能每日推 → 飞书

## 当前生产架构

**ChatGPT 每日任务（09:00 UTC+8） → GitHub 队列文件 → GitHub Actions → GitHub OIDC → Vercel `/api/relay` → 飞书群机器人**

人工兜底仍保留：

**人工确认文本 → 首页转发页 → `/api/send` → 飞书群机器人**

自动发送不再依赖 TinyFish、浏览器点击、Vercel Cron、OpenAI API Key 或 Vercel AI Gateway。

## 自动流程

1. ChatGPT 每日任务完成逐源检索、筛选、链接核验并冻结最终 Payload。
2. 任务只创建一个文件：
   `queue/YYYY.MM.DD.txt`
3. 该 GitHub push 自动触发 `.github/workflows/daily-feishu.yml`。
4. Workflow 先检查 `state/last-success.json`。当天已有成功记录时，立即停止，不调用发送接口。
5. Workflow 校验：
   - 首行日期与文件名一致；
   - 只有 3–5 条；
   - 最终文本中不存在新浪/网易 URL。
6. GitHub Actions 请求短期 OIDC token，不保存长期发送密钥。
7. Workflow 携带 OIDC token 调用 Vercel `/api/relay`。
8. Vercel 再次验证 GitHub 仓库、main 分支、指定 workflow、Payload 日期、3–5 条格式和新浪/网易禁用域名。
9. 只有通过全部校验后，Vercel 才 POST 已有的 `FEISHU_WEBHOOK_URL`。
10. 只有 Vercel 明确返回 `sent:true` 后，GitHub Actions 才更新并提交 `state/last-success.json`。

## 防重复

有两层防重复：

- **队列层**：ChatGPT 每日任务不得覆盖或重复创建同一天的 `queue/YYYY.MM.DD.txt`。
- **发送层**：GitHub Actions 在发送前读取持久化的 `state/last-success.json`；同一天已确认成功则停止。

此外 Workflow 使用 GitHub Actions `concurrency`，防止同一批任务并行发送。

若 Vercel 请求超时、状态不确定或返回失败，Workflow 直接失败，不自动二次提交，避免不确定状态下重复发送。

## 鉴权

自动中继不使用固定公开 secret。

GitHub Actions 具备：

```yaml
permissions:
  contents: write
  id-token: write
```

运行时向 GitHub 申请 audience 为：

`feishu-embodied-ai-daily-relay`

的短期 OIDC token。

Vercel `/api/relay` 会验证：

- issuer；
- audience；
- repository = `Kiera007-ui/feishu-embodied-ai-daily`；
- ref = `refs/heads/main`；
- workflow_ref = 指定的 `daily-feishu.yml`；
- event_name = `push`。

因此普通公网请求无法调用自动中继。

## 当前已验证

2026-09-28 已完成两项不产生重复飞书消息的验收：

1. **OIDC 中继 dry-run**：GitHub Actions → Vercel `/api/relay?dry=1` 返回 HTTP 200、`ok:true`、`dry_run:true`。
2. **同日防重复**：将已经成功发送过的 2026.09.28 Payload 写入队列后，Workflow 读取 `state/last-success.json`，在请求 OIDC / 调用 Vercel 中继之前停止。

## 自动日推口径

ChatGPT 每日任务维护完整编辑规则，核心包括：

- 每天逐一核查：机器之心/机器之心Pro、新智元、量子位、AI前线/InfoQ、极客公园、36氪/硬氪、投资界、甲子光年、晚点、硅星人、你好太空；
- 最终 3–5 条，宁少勿滥；
- 不收论文和纯学术论文解读；
- 普通新品、一般融资、常规官宣、低讨论度 Demo 降权；
- 模型、商业航天、物流、船舶/航运不要求每天覆盖；
- 新浪、网易不得作为最终来源或链接；
- 每条最终链接必须实际打开并与标题/正文对应。

## 人工兜底

首页和 `/api/send` 保留。

自动队列异常时，可以人工确认一份冻结 Payload 后，通过首页发送。人工兜底与自动队列不得同时对同一天重复执行。
