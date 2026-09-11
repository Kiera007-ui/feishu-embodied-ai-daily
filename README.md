# 具身智能每日推 → 飞书

## 最终架构

**Vercel Cron（每天 08:00，GMT+8） → Vercel Function → OpenAI Responses API + Web Search → 飞书群自定义机器人**

这是当前最轻、最稳、维护成本最低的版本，不需要额外使用飞书 Aily。

- Vercel Cron 负责定时；
- OpenAI Web Search 负责检索过去 24 小时信息并按固定口径整理；
- 飞书自定义机器人 Webhook 负责推送到小范围群；
- 每条只保留“消息概述 + 专业来源 + 链接”；
- 默认 4–6 条，宁少勿滥。

---

## 1. 飞书：创建群自定义机器人

在目标飞书群：

**群设置 → 群机器人 → 添加机器人 → 自定义机器人**

建议名称：`具身智能每日推`

安全设置推荐二选一：

### 简单版
设置“自定义关键词”：
`具身智能每日推`

### 更安全版
开启“签名校验”，保存机器人 Secret。

创建后复制 Webhook URL。

> Webhook URL 和 Secret 都属于私密凭证，不要发到公开群、GitHub 或聊天记录中。

---

## 2. Vercel：部署项目

把本项目上传到一个 Git 仓库后，在 Vercel 中 Import；或者用 Vercel CLI 部署。

项目无需安装任何 npm 依赖，使用 Node 20+ 自带的 `fetch` 与 `crypto`。

### Vercel 环境变量

在：

**Project → Settings → Environment Variables**

添加：

| 环境变量 | 是否必需 | 内容 |
|---|---:|---|
| `OPENAI_API_KEY` | 是 | 你的 OpenAI API Key |
| `FEISHU_WEBHOOK_URL` | 是 | 飞书自定义机器人 Webhook |
| `CRON_SECRET` | 是 | 随机长字符串；Vercel Cron 会自动带上 |
| `MANUAL_SECRET` | 推荐 | 手工测试接口用的随机长字符串 |
| `FEISHU_BOT_SECRET` | 可选 | 只有开启飞书“签名校验”时填写 |
| `OPENAI_MODEL` | 可选 | 默认 `gpt-5.6-terra` |

推荐用不同的随机值作为 `CRON_SECRET` 和 `MANUAL_SECRET`，长度至少 32 位。

---

## 3. 时间设置

`vercel.json` 中：

```json
{
  "path": "/api/push",
  "schedule": "0 0 * * *"
}
```

Vercel Cron 使用 UTC。

`00:00 UTC = 08:00 北京/新加坡时间（GMT+8）`

因此当前配置会每天早上 08:00 推送。

---

## 4. 先做 Dry Run

部署完成后，不要马上往群里发。

先打开终端：

```bash
curl "https://你的-vercel-域名.vercel.app/api/push?dry=1" \
  -H "x-manual-secret: 你的MANUAL_SECRET"
```

它会返回当天生成的 JSON，但**不会发到飞书群**。

确认内容没问题后再正式测试。

---

## 5. 手工发一次到飞书群

```bash
curl "https://你的-vercel-域名.vercel.app/api/push" \
  -H "x-manual-secret: 你的MANUAL_SECRET"
```

群里会收到一张卡片：

**具身智能每日推｜YYYY.MM.DD**

**1｜标题**
消息概述  
来源：[机器之心](原文链接)

……

---

## 6. 每日推送口径已经写进代码

当前固定规则：

- 重点检索过去 24 小时；
- 48 小时内但当天仍持续高热的消息允许保留；
- 只收“多方同时讨论、高热”或“刚爆出且影响行业认知”的内容；
- 优先机器之心、新智元、量子位、AI前线、极客公园、36氪/硬氪、投资界、甲子光年、晚点、硅星人、你好太空，以及创始人/高管原始发言；
- 小红书、自媒体、泛财经媒体主要用于发现线索与判断热度；
- 普通新品、一般融资、常规官宣、低讨论 Demo 降权；
- 每条只做消息概述、来源和链接；
- 不解释为什么值得看；
- 不做趋势总结、最终建议或策略性收尾；
- 默认 4–6 条。

---

## 7. 成本控制

默认模型：`gpt-5.6-terra`

每天只运行一次，一般只产生一次模型 + Web Search 请求。若希望进一步压低成本，可把：

`OPENAI_MODEL=gpt-5.6-luna`

内容筛选精度会有所下降，但成本更低。

---

## 8. 文件说明

- `api/push.js`：检索、生成、构建飞书卡片、发送消息
- `vercel.json`：每天 08:00 定时任务
- `.env.example`：环境变量模板
- `package.json`：Vercel Node 项目配置
