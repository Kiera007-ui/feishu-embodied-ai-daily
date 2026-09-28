# 具身智能每日推 → 飞书

## 最终架构

**Vercel Cron（每日 09:00，UTC+8） → /api/push → Vercel AI Gateway（OIDC）→ 实时 Web Search → URL/正文二次核验 → 飞书群机器人**

人工兜底链路仍保留：

**人工确认文本 → 首页转发页 → /api/send → 飞书群机器人**

自动链路不依赖 ChatGPT 对话是否打开，也不依赖 TinyFish 浏览器点击。

## 为什么改成这套

此前 9 月 11 日后的架构实际是“ChatGPT 定时任务 → 浏览器自动化 → 网页按钮 → 飞书”。后台定时任务一旦没有继续调用浏览器，飞书就不会收到消息。

现在把生成、搜索、核验和发送全部移入 Vercel 服务端。Vercel Cron 是真正的无人值守触发器。

## 必需设置

### 1. 飞书 Webhook

已有：
`FEISHU_WEBHOOK_URL`

### 2. 开启 Vercel OIDC

在 Vercel 项目：

**Settings → Security → Secure Backend Access with OIDC Federation → Enable**

AI Gateway 可以直接使用 Vercel 为函数注入的短期 OIDC 身份，因此无需保存 OpenAI API Key。函数运行时 OIDC token 位于 `x-vercel-oidc-token` 请求头。

### 3. 设置 CRON_SECRET

在：

**Settings → Environment Variables**

新增 Production 环境变量：

`CRON_SECRET=<至少32位随机字符串>`

Vercel Cron 会自动以：

`Authorization: Bearer <CRON_SECRET>`

调用 `/api/push`。

环境变量变更后需要重新部署 Production 才会应用到部署。

## 定时

`vercel.json`：

```json
{
  "path": "/api/push",
  "schedule": "0 1 * * *"
}
```

Vercel Cron 使用 UTC，因此 `01:00 UTC = 09:00 UTC+8`。

Hobby 计划每天可以运行一次，但可能在 09:00–09:59 内触发；Pro/Enterprise 为分钟级。

## 自动生成与核验

每天服务端会：

1. 逐一检查约定渠道：机器之心/机器之心Pro、新智元、量子位、AI前线/InfoQ、极客公园、36氪/硬氪、投资界、甲子光年、晚点、硅星人、你好太空。
2. 再做补充搜索。
3. 只选 3–5 条高热或刚出现的重要消息。
4. 不收论文、一般融资、普通新品、常规官宣和低讨论度 Demo。
5. 商业航天、物流、船舶只在当天有强消息时加入，不强制覆盖。
6. 禁止新浪、网易作为最终来源。
7. 逐条从 Vercel 服务端真正打开最终 URL。
8. 再用独立模型把“推送摘要”和“实际页面正文”做语义一致性核验。
9. 只要任何一条打不开或内容不对应，当天整批停止，不发送错误日推。
10. 全部通过后直接 POST 飞书 Webhook。

AI Gateway 默认使用：
- 主模型：`openai/gpt-5.6-sol`
- 核验模型：`openai/gpt-5.6-terra`
- 模型不可用时配置了跨提供商 fallback。

## 状态检查

访问：

`/api/status`

仅返回各项配置是否存在，不返回密钥值。

当：

`auto_push_ready=true`

才表示无人值守链路具备运行条件。

## 人工兜底

原首页和 `/api/send` 保持不变。自动任务异常时，仍可人工冻结 Payload 后发送。

## 防重复

自动发送不做应用层自动重试；Vercel 官方也不会对失败 Cron 自动重试。函数对同一热实例中的当天发送增加了 36 小时日期锁。

由于纯 Serverless 内存锁不是跨实例持久化锁，极端情况下 Vercel 若把同一 Cron 事件投递到不同实例，理论上仍存在重复风险。若后续需要严格 exactly-once，可再接 Redis/KV 分布式锁。
