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

卡片标题和终端命令用同一个账号名称，支持中文和空格。已有的短别名仍可以调用原账号，旧备注可作为迁移后的名称。

在账号卡片上点「复制 Workers 部署命令」或「复制 Pages 部署命令」。Pages 需要填写实际构建目录，例如 `./dist`。核对完整命令再点「复制命令」，到业务项目目录使用。Windows 上粘贴到 PowerShell，目录里有空格或单引号也可以直接复制。

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

每日用量从 UTC 零点起算，也就是北京时间早上 8 点。Workers 和 Pages Functions 在统计可相加时共用一条 100,000 次的进度条，Workflows 也可能占用该额度。展开「更多用量」可看 D1、KV、Workers AI 和 R2。R2 操作按 UTC 日历月估算，今日存储峰值用 GB 显示，10 GB-month 是按账单周期计算的免费基准。页面底部的「其他免费服务」列出产品额度和官方入口。 [Pages Functions 额度](https://developers.cloudflare.com/pages/functions/pricing/#free-plan) · [R2 计费](https://developers.cloudflare.com/r2/pricing/)

看板打开且页面可见时，每分钟查一次，也可以点「刷新」立刻查。查询只读取 Cloudflare 的统计，Workers 请求数由实际访问产生。Cloudflare 汇总用量可能延迟几分钟。Worker 访问地址最多复用两分钟的查询结果。[Workers 统计说明](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/#requests)

打开看板后会先看到本地账号，项目和用量查完一张显示一张。刷新时可以继续查看上次结果和查询时间。默认按 Workers 请求排序，想比较卡片上的进度条，可选「已统计共享请求从少到多」。每轮查完才调整位置，未知的排在末尾。

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
