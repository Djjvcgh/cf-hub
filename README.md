# cf-hub

一个轻量的本地 Cloudflare 多账号工具。你可以在终端查看各账号的项目和今日用量，选定账号后运行 Wrangler，也可以临时打开网页管理账号。

## 安装

准备 [Node.js 24 LTS](https://nodejs.org/en/about/previous-releases)，在 cf-hub 项目目录执行 `npm install && npm link`。如果 PowerShell 不支持 `&&`，分两行执行，等 `npm install` 成功后再执行 `npm link`。

**Windows 快捷启动**：双击根目录的 [cf-hub.bat](cf-hub.bat)。默认浏览器会打开看板，启动窗口随即退出。再次双击会复用已经打开的真实看板。由快捷启动创建的看板在最后一个标签页关闭约 5 秒后停止。首次启动优先用 `127.0.0.1:3456`，端口占用时会自动选一个可用的本地端口。

## 第一次使用

1. 按下文创建 Cloudflare API Token。双击 `cf-hub.bat` 或运行 `cf-hub ui`，在打开的看板点「添加账号」，填写账号名称、Account ID 和 Token。校验通过后保存到 `~/.cf-hub/accounts.json`，以后关着看板也能用。
2. 双击脚本启动的看板可直接关闭标签页。用 `cf-hub ui` 启动时，在对应终端按 `Ctrl+C` 退出。切到任意业务项目目录执行 `cf-hub list` 和 `cf-hub status`。给 Agent 使用时可执行 `cf-hub status --json`。
3. 确认项目和账号后，运行 `cf-hub run '我的 Cloudflare 账号' -- deploy` 部署 Workers，或运行 `cf-hub run '我的 Cloudflare 账号' -- pages deploy ./dist` 部署 Pages。把示例名称换成看板里显示的账号名称。

想先看看界面，可以跑 `cf-hub ui --demo`。表单修改随演示关闭而清除。想先验证 Workers 配置，可以在业务项目里运行 `cf-hub run '我的 Cloudflare 账号' -- deploy --dry-run --outdir ./cf-hub-dry-run`，查看本地打包结果。

看板里的账号名和终端命令用同一个账号名称，支持中文和空格。已有的短别名仍可以调用原账号，旧备注可作为迁移后的名称。

在看板点一行账号打开右侧详情，点「复制 Workers 部署命令」或「复制 Pages 部署命令」。Pages 需要填写实际构建目录，例如 `./dist`。核对完整命令再点「复制命令」，到业务项目目录使用。Windows 上粘贴到 PowerShell，目录里有空格或单引号也可以直接复制。

## 申请 API Token

在 Cloudflare 控制台打开个人头像 → My Profile → API Tokens → Create Token → Custom Token。想使用归属于账号的 Token，也可从 Manage Account → API Tokens 创建。添加下表需要的权限，在 **Account Resources** 里只包含这枚 Token 对应的账号。使用域名权限时，在 **Zone Resources** 里只选涉及的站点。点击创建后复制 Token，回到 `cf-hub ui` 的账号表单粘贴保存。已有账号可点「编辑」更换 Token，留空会保留原值。 [Cloudflare 创建 Token 指引](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)

| 用途 | 在 Cloudflare 里选择 | 能做什么 |
| --- | --- | --- |
| 看额度 | Account → Account Analytics → Read | 查看 Workers、Pages Functions、D1、KV、Workers AI 和 R2 的账号用量统计。 |
| 看 Workers 项目 | Account → Workers Scripts → Read | 查看已部署的 Workers。 |
| 看 Pages 项目 | Account → Cloudflare Pages → Read | 查看已部署的 Pages 项目。 |
| 发布 Workers | Account → Workers Scripts → Edit | 发布和管理 Workers，也可查看 Workers 项目。 |
| 发布 Pages | Account → Cloudflare Pages → Edit | 创建、发布和管理 Pages 项目，也可查看 Pages 项目。 |
| 查询账号资料 | Account → Account Settings → Read | 读取账号设置和账号资料，供需要这些信息的命令使用。 |
| 管理 D1 | Account → D1 → Edit | 管理数据库、执行写入和迁移。 |
| 管理 Workers KV | Account → Workers KV Storage → Edit | 管理命名空间和键值。 |
| 管理 R2 | Account → Workers R2 Storage → Edit | 通过 Cloudflare API 或 Wrangler 管理存储桶和对象。S3 客户端使用单独的 R2 凭证。 |
| 配置 Worker 路由 | Zone → Workers Routes → Edit | 为已选站点创建或修改 Worker 路由。 |
| 按域名查找站点 | Zone → Zone → Read | 让需要按域名查找站点的命令读到对应 Zone。 |
| 直接调用 Workers AI 模型 API | Account → Workers AI → Read 和 Edit | 通过 Workers AI REST API 调用模型。单看 Neurons 统计勾选 Account Analytics Read 即可。 |

**只看面板**就选前三行。**也要发布**就保留统计权限，把要发布的产品的 `Read` 换成 `Edit`，再按需要勾选其余行。Cloudflare 的权限表或 API 有时把 `Edit` 写成 `Write`，例如 `D1 Write`、`Workers Routes Write`。 [Cloudflare 权限表](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) · [Analytics 权限](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/) · [Workers AI REST API 权限](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)

## 看用量

每日用量从 UTC 零点起算，也就是北京时间早上 8 点。Workers 和 Pages Functions 在统计可相加时共用一条 100,000 次的进度条，Workflows 也可能占用该额度。表格同时列出 D1、KV、Workers AI 和 R2。R2 操作按 UTC 日历月估算，今日存储峰值用 GB 显示，10 GB-month 是按账单周期计算的免费基准。页面底部的「其他免费服务」列出产品额度和官方入口。 [Pages Functions 额度](https://developers.cloudflare.com/pages/functions/pricing/#free-plan) · [R2 计费](https://developers.cloudflare.com/r2/pricing/)

看板打开且页面可见时，每分钟查一次，也可以点「刷新」立刻查。查询只读取 Cloudflare 的统计，Workers 请求数由实际访问产生。Cloudflare 汇总用量可能延迟几分钟。Worker 访问地址最多复用两分钟的查询结果。[Workers 统计说明](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/#requests)

打开看板后会先看到本地账号，每行查完就显示一行。表格每格是该产品里用得最多的一项，低于 60% 为绿，60% 到 80% 为黄，80% 以上为红，灰色表示未知。点一行可在右侧看全部分项用量和项目。刷新时可以继续查看上次结果和查询时间。默认把最紧张的账号排前面。部署前挑账号可选「余量最多的排前面」，也可以按 Workers 请求或共享请求排序。每轮查完才调整位置，缺权限或查询失败的账号排在末尾（仅某账号当天尚无 R2 存储样本时仍按正常余量参与排序和推荐）。

## 日常使用指南

- **先看额度再选号**：打开看板后，顶部会自动推荐统计完整且「余量最多」的账号；也可以切换 4 种排序方式快速对比。点任意一行可以在右侧抽屉看全部分项额度、已部署项目链接以及编辑或移除账号。
- **在任意项目目录执行 Wrangler**：除部署外，`cf-hub run` 同样支持日常维护命令，只需把原命令 `wrangler` 后面的参数放到 `--` 之后：

```powershell
# 查看本次选中账号的身份（只读）
cf-hub run '我的 Cloudflare 账号' -- whoami

# Workers 预演打包（只打包校验，不真发布）
cf-hub run '我的 Cloudflare 账号' -- deploy --dry-run --outdir ./cf-hub-dry-run

# 部署 Workers 或 Pages
cf-hub run '我的 Cloudflare 账号' -- deploy
cf-hub run '我的 Cloudflare 账号' -- pages deploy ./dist

# 其他常见操作（如 D1 迁移、写入 Secret）
cf-hub run '我的 Cloudflare 账号' -- d1 migrations apply my-db --remote
cf-hub run '我的 Cloudflare 账号' -- secret put API_SECRET
```

- **复杂账号名直接复制**：如果账号名或目录包含空格、中文或特殊符号，推荐直接在看板右侧点「复制 Workers 部署命令」或「复制 Pages 部署命令」，生成好的命令会自动按当前系统处理引号转义。在 Windows 的 CMD 下，根目录 [cf-hub.bat](cf-hub.bat) 带参数执行也会直接转交命令行工具，不再重复打开浏览器。

## 给 AI Agent 的使用指南

如果你在用编码 Agent（如 Cursor、Claude Code、Codex 等）帮你查额度或代跑部署，推荐遵循以下三步：

1. **先查再选**：执行 `cf-hub status --json`（仅看名单可用 `cf-hub list`）读取标准 JSON 报告。注意字段值为 `null` 表示**未知**（可能缺权限、查询超时或当天暂无样本），**不要当成 `0`**；同时检查 `errors[]` 确认目标账号没有影响任务的缺权报错。
2. **先汇报，获准再动手**：执行任何部署或线上写操作前，先向用户列出**业务项目路径、目标账号、当前余量与完整命令**，得到用户明确同意后再执行。
3. **统一经由 `cf-hub run` 执行**：不要直接读取 `~/.cf-hub/accounts.json`，不要在输出或日志中回显任何 Token；若遇到账号冲突或 `.env` 覆盖报错，立即停止并提示用户处理，不要绕过 `cf-hub` 直接运行裸 `wrangler`。

可以直接把下面这段规则复制到业务项目的 `AGENTS.md` 或 `CLAUDE.md` 中：

```markdown
## Cloudflare 操作与部署约定
- 查询账号与今日用量统一运行 `cf-hub status --json`（仅看名单用 `cf-hub list`），禁止读取 `~/.cf-hub/accounts.json` 或输出任何 Token。
- `status --json` 中数值为 `null` 表示未知，不能当作 `0`；选择账号前需核对 `errors` 中是否有权限不足或查询失败。
- 执行部署或变更线上资源前，必须先向用户展示项目目录、目标账号、余量情况与完整命令，获得明确确认后再运行 `cf-hub run '<账号名称>' -- <Wrangler 参数>`。
- 若 `cf-hub run` 因 `account_id` 冲突、`.env` 认证覆盖或受限参数中止，应停止并如实报告原因，严禁改用裸 `wrangler` 绕过检查。
```

## 把旧项目的 CLOUDFLARE_API_TOKEN 迁移到 cf-hub

如果旧项目以前通过项目 `.env`、终端环境变量或 `wrangler login` 管理账号，可以按下面三步平滑切到 `cf-hub` 统一管理：

### 第 1 步：把旧 Token 录入 cf-hub 看板

1. 双击根目录 [cf-hub.bat](cf-hub.bat)（或运行 `cf-hub ui`）打开看板，点击「添加账号」。
2. 填写便于辨认的账号名称、对应的 32 位 Account ID 和旧的 `CLOUDFLARE_API_TOKEN`，保存时工具会自动校验连通性并安全存进 `~/.cf-hub/accounts.json`。
3. 如果旧 Token 之前没有开统计权限、看板里用量显示为「未知」，可到 Cloudflare 控制台为这枚 Token 补勾 `Account → Account Analytics → Read`（见上文「申请 API Token」）。
4. **安全建议**：如果旧 Token 曾经同时授权了多个账号，建议按账号拆成“一账号一 Token”。这样就算选错账号，Cloudflare 侧也会多一道权限拦截。

### 第 2 步：清理旧项目的认证覆盖

`cf-hub run` 会在启动前检查项目目录和运行环境，避免旧配置把新选中的账号悄悄顶掉：

1. **清理项目 `.env`、`.env.local`（及命名环境对应的 `.env.<环境>`）里的 Cloudflare 部署凭据**，移除或注释下面这些变量：
   - `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CF_API_TOKEN`、`CF_ACCOUNT_ID`
   - `CLOUDFLARE_API_KEY`、`CLOUDFLARE_EMAIL`、`CF_API_KEY`、`CF_EMAIL`
   - 其他覆盖项（如 `CLOUDFLARE_API_BASE_URL`、`CLOUDFLARE_API_HEADERS`、`CLOUDFLARE_AUTH_PROFILE`、`WRANGLER_CF_AUTHORIZATION_TOKEN` 等）
   > **提示**：业务代码自身用到的密钥（例如数据库密码、模型 API Key，以及 `.dev.vars` 里的本地运行时变量）**全部保留不动**，只移除用于部署认证的变量即可。
2. **决定 `wrangler.toml` / `wrangler.jsonc` / `wrangler.json` 中的 `account_id`**：
   - **希望项目可以随时切到不同账号部署**（推荐）：删掉顶层和各 `[env.*]` 下的 `account_id` 字段，之后由 `cf-hub run '目标账号' -- ...` 自动指定账号。
   - **希望把这个项目锁死在固定账号防止发错**：保留对应的 `account_id`。以后误选其他账号执行时，`cf-hub` 会立即报错拦截。
3. **清理本机残留的全局环境变量与旧登录态（推荐）**：
   移除系统环境变量或终端配置文件中写死的 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`；如果以前用过浏览器登录，可运行一次 `npx wrangler logout`，避免日后误敲裸 `wrangler` 发到旧账号。

### 第 3 步：切换命令并做只读验收

把原来的 `wrangler deploy` 或 `npx wrangler pages deploy ./dist` 改用 `cf-hub run` 调用（如果 `package.json` 的 `scripts` 里写了部署脚本，也可以一并改掉）。迁移完成后，在旧项目目录先后跑两条无副作用的命令确认接管成功：

```powershell
# 1. 验证已用指定账号接管成功，且 .env / account_id 无冲突（只读）
cf-hub run '我的 Cloudflare 账号' -- whoami

# 2. Workers 项目可再做一次本地打包预演，确认配置与环境正常（不实际发布）
cf-hub run '我的 Cloudflare 账号' -- deploy --dry-run
```

*注*：GitHub Actions 等线上 CI/CD 流水线仍沿用平台自身的 Secrets 注入 `CLOUDFLARE_API_TOKEN`，不需要改用 `cf-hub`。

## 常见问题

| 遇到的问题 | 怎么处理 |
| --- | --- |
| 终端找不到 `cf-hub` | 在 cf-hub 项目目录重新执行 `npm link`，再开一个终端试试。 |
| 看板提示端口被占用 | 关闭之前启动看板的终端，再运行 `cf-hub ui`。 |
| 查不到用量或提示权限不足 | 看对应账号下的错误提示。用量查询要给该账号的 Token 开通 Account Analytics Read。部署权限按项目另行开启。 |
| 请求连不上 Cloudflare | 确认网络能访问 Cloudflare。程序优先读取 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`，Windows 上也会读取手动系统代理。如果当前网络用的是自动代理脚本，可在当前终端显式设置代理地址。 |
| 部署提示账号冲突 | 打开提示里的配置文件，核对账号和所选名称后再执行。如果提示来自 `.env`，移除其中指定账号或凭据的设置，让这次命令选择账号。 |

## 项目文档

[需求](docs/PRD.md) · [架构](docs/architecture.md) · [功能设计](docs/design.md) · [任务列表](docs/tasklists.md)
