# 部署与回滚

项目按 Cloudflare Workers + D1 部署。仓库中的域名、数据库 ID 和账户 ID 均为占位值，部署前必须替换成自己的资源。

## 本地验证

```powershell
npm install
npm run db:migrate:local
npm run build:worker
npm run preview:worker
```

访问 `http://127.0.0.1:8787/map` 与 `/api/health`。本地配置中的 D1 ID 只是占位，不代表存在云数据库。

## 配置预览环境

1. 设置 `CLOUDFLARE_ACCOUNT_ID`。
2. 为预览环境创建独立 D1 数据库，把真实 UUID 写入 `wrangler.jsonc` 的 `env.preview.d1_databases`。
3. 应用迁移：

```powershell
npx wrangler d1 migrations apply campusos-preview --remote --env preview
```

4. 配置运行时 Secret：`MODEL_API_KEY`、`MODEL_NAME`、`MODEL_BASE_URL`、`MODEL_CAPABILITIES_JSON`、`AGENT_SIGNING_SECRET`。不要把秘密写进 `wrangler.jsonc` 或提交到 Git。
5. 部署：

```powershell
npm run deploy:preview
```

部署前确认 `wrangler.jsonc` 中的 Worker 名称、D1 ID、路由和 `CLOUDFLARE_ACCOUNT_ID` 都属于目标账户。预览入口 `preview-worker.ts` 复用站点的 API 处理与 OpenNext 请求上下文；升级 OpenNext 后应重新验证该入口和静态资源缓存。

## 生产环境

生产 D1、正式域名和 DNS 需要单独创建与授权。确认预览验收通过后，再写入生产数据库 UUID、绑定域名并部署。生产 Secret 使用 `wrangler secret put <NAME> --env production` 或控制台受控输入，不要把值放在命令参数、聊天或仓库中。

## 回滚

- 发布前记录当前 Worker 版本、Git 提交和迁移版本。
- 应用异常时使用 Cloudflare 版本回滚，选择上一个已验证版本并复测健康检查、登录和主要业务页面。
- Worker 回滚不会回滚 D1 schema 或数据。优先使用向前兼容的增量迁移；需要恢复数据时使用 D1 备份或 Time Travel，并先在隔离环境验证。
- 数据导出和备份放在 Git 忽略的目录或受控存储中，不要把手机号、会话或学校令牌放进仓库。

## Console 密码维护

预览环境可使用 `admin_password` 模式。不要把明文密码写入 `CONSOLE_ADMIN_ACCESS_KEY`：该绑定保存 PBKDF2/SHA-256 派生值，`CONSOLE_CREDENTIAL_SALT` 为随机 salt。轮换时更新绑定并重新登录，旧会话会因凭据指纹变化失效。不要通过清空数据库、放宽权限或重置登录额度来处理登录问题。

## 地图几何元数据

公开道路候选由固定地图和离线算法生成。修改已审阅的地理数据或相关几何实现后，运行 `npm run map:route-metadata`，再运行路线差分测试。普通构建只校验来源 SHA，数据过期会直接失败，不会自动更新地图。生成物位于 `src/lib/server/maps/public-walking-attachments.json`，不包含用户位置、会话或路线票据。
