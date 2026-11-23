# CampusOS 云端搜索 Worker

可选的云端搜索服务：普通网页搜索运行在轻量 Node Container 中，小红书等需要登录态的源通过 ManagedXhs / Cloudflare Browser Run 访问。主站通过 Service Binding 调用，不经过本机 relay。

## 构建与部署

从仓库根目录执行：

```powershell
node services/cloud-search/build.mjs
npx wrangler deploy --config services/cloud-search/wrangler.jsonc
```

入口 Worker 校验 `SERVICE_TOKEN`，只接受只读搜索和私有会话维护。`SERVICE_TOKEN`、`PROFILE_KEY` 使用 Wrangler Secret；R2 bucket 保持私有。主站配置的 `CLOUD_SEARCH_TOKEN` 必须与 `SERVICE_TOKEN` 相同。

凭据从被忽略的本地环境文件读入，不要写进命令参数、日志或 Git。无须导出日常浏览器 profile。

## 直接调用

以下示例假设入口地址为 `https://cloud-search.example.workers.dev`，令牌通过环境变量传入：

```powershell
$headers = @{ Authorization = "Bearer $env:CLOUD_SEARCH_TOKEN" }
Invoke-RestMethod -Method Get  -Uri "https://cloud-search.example.workers.dev/health" -Headers $headers
Invoke-RestMethod -Method Post -Uri "https://cloud-search.example.workers.dev/search" -Headers $headers -ContentType "application/json" -Body '{"query":"示例检索词","limit":3}'
```

响应中的 `ok`、`results`、`warnings` 可作为检索结果或失败原因使用。源站拒绝时返回真实失败，不伪造结果。

## 会话维护

`login` 仅在管理员明确要求时生成二维码；`verify` 生成短期 Live View，脚本只将地址写入被忽略的 runtime 目录，不打印或提交。`managed-restart` 关闭当前云端浏览器并从下次请求恢复加密状态；不能把 guest 状态的恢复当成登录成功。有效会话文件存在也不保证源站仍接受它。

## 说明

小红书笔记保留原文跳转、来源和经验属性，不进入官方政策库。没有自动破解验证、代理轮换或浏览器身份伪装。回退本机运行是独立维护决策，当前没有自动切回。
