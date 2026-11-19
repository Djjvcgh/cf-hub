# cf-hub 产品需求文档

| 项目 | 内容 |
| --- | --- |
| 版本 | v1.0 首版需求 |
| 更新日期 | 2026-11-19 |
| 状态 | 已实现，单账号联机验收通过 |
| 决定与理由 | [项目决策记录](docs/decisions-cf-hub.md) |

## 1. 背景与目标

用户管理多个 Cloudflare 账号。准备部署时，需要知道各账号有哪些 Workers 和 Pages 项目、今天各用了多少请求，并能在业务项目目录里选定账号执行 Wrangler。`cf-hub` 把这些操作集中到一个轻量的本地工具里，减少手动切换凭据和部署到错账号的风险。

| 使用者 | 场景 | 预期结果 |
| --- | --- | --- |
| 账号管理者 | 在浏览器里添加账号或更换 Token | 看到校验结果，保存后马上能在终端使用该账号。 |
| 项目维护者 | 在业务项目目录下选 `cf-2` 部署 | Wrangler 使用 `cf-2`。遇到账号冲突或目标无法确认时，运行前就能看到原因。 |
| AI Agent | 准备部署，先查询今日用量 | 读到可解析的排名和缺失项，把项目、目标账号和命令交给用户确认。 |

## 2. 首版范围

- 使用 Node.js 提供 `cf-hub` 全局命令，支持在任意业务项目目录调用。使用 JavaScript 或 TypeScript 均可。
- 终端负责账号清单、实时查询和 Wrangler 执行。看板使用同一份账号数据和查询规则，仅在用户手动启动后运行。
- 看板提供账号总览、部署命令复制和本地账号管理。实际部署通过终端执行。

首版边界外的能力包括跨账号迁移、自动挑选部署目标、分析项目能否在某账号运行、定时监控和账号配置同步。

## 3. 功能需求

### CF-01 账号配置与清单

- 账号统一存放在用户主目录的 `~/.cf-hub/accounts.json`。每条记录包含 `name`、`accountId` 和 `apiToken`。账号名称必填且唯一，支持中文和空格。旧配置读入时从备注或别名取得名称，旧别名继续可用于原命令。
- 用户在任意目录执行 `cf-hub list`，能看到账号名称和 Account ID。Token 不进入清单、状态输出或日志。账号凭据以用户主目录的配置为准，业务项目目录和全局 Cloudflare 环境变量均无需配置。
- Cloudflare 侧每个 Token 只授权对应账号，并按需要开启查询或部署权限。配置文件的访问权限限制在当前用户。

### CF-02 账号状态与用量排名

- 用户执行 `cf-hub status` 时，工具并发查询已配置账号，显示各账号的 Workers、Pages 项目和今日用量。Workers 通过 `GET /client/v4/accounts/{id}/workers/scripts` 获取，Pages 通过 `GET /client/v4/accounts/{id}/pages/projects` 获取，结果包括后续分页中的项目。[Workers 列表接口](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/list/) · [Pages 列表接口](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/list/)
- 通过 `POST /client/v4/graphql` 查询 `workersInvocationsAdaptiveGroups`。Cloudflare 未提供该数据集时，使用官方文档中的 `workersInvocationsAdaptive`。统计当日 UTC 00:00 到查询时点的 Workers 请求量，以 Workers Free 每日 100,000 次为基准估算百分比。Pages Functions 也消耗同一份额度。界面和 JSON 标明当前数据集的统计范围及 Pages Functions 覆盖情况。[Workers 查询接口](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/) · [Workers 免费额度](https://developers.cloudflare.com/workers/platform/limits/#daily-requests) · [Pages Functions 计费](https://developers.cloudflare.com/pages/functions/pricing/#free-plan)
- 权限及数据源支持时，同期显示 D1 读取行数和 KV 读取次数。缺权限或查询失败时，对应项显示「未知」及原因。一个账号或一个数据项出错时，仍显示查到的其他结果。成功查到零请求的账号应显示 `0`。[D1 指标](https://developers.cloudflare.com/d1/observability/metrics-analytics/) · [KV 指标](https://developers.cloudflare.com/kv/observability/metrics-analytics/)
- 排名按口径一致的今日请求数从少到多排列，用量未知的账号不参加排名。D1 和 KV 数据供参考。
- Agent 执行 `cf-hub status --json` 时，标准输出只包含一个有效的 JSON 文档，提供统计窗口、账号和项目、用量及其口径、排名和缺失原因。未知数值用 `null` 表示，便于与零区分。

### CF-03 指定账号运行 Wrangler

- 用户执行 `cf-hub run <账号名称> -- <Wrangler 参数>` 时，工具查找该账号，仅向本次运行 Wrangler 的子进程注入该账号的 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`，再通过 `npx wrangler` 转交参数。原终端和其他账号的运行各自独立。终端可看到 Wrangler 的输出和退出结果。
- 执行前检查 Wrangler 实际会使用的配置。覆盖 `wrangler.toml`、`wrangler.jsonc`、`wrangler.json`，并考虑显式指定的目录、配置文件、命名环境及框架生成的配置。账号不存在、有效配置中的 `account_id` 冲突或无法确认目标账号时，立即中止，提示所选账号及具体原因。仅在能确认目标账号的情况下透传命令。[Wrangler 配置与生成文件](https://developers.cloudflare.com/workers/wrangler/configuration/#generated-wrangler-configuration) · [Wrangler 命令参数](https://developers.cloudflare.com/workers/wrangler/commands/general/)
- 示例包括 `cf-hub run '我的账号' -- deploy` 和 `cf-hub run '我的账号' -- pages deploy ./dist`。
- 用户可以自行执行命令。Agent 代跑前须展示本次项目、目标账号和完整命令，等用户明确同意本次部署后才执行。人工确认发生在用户与 Agent 的对话里，`run` 保持可由终端直接调用。

### CF-04 按需看板与项目入口

- 用户执行 `cf-hub ui` 后，工具启动本地 HTTP 服务，仅监听 `127.0.0.1`，默认使用 `3456` 端口，并自动打开浏览器。结束命令或关闭终端后，看板退出，终端仍可独立使用 `list`、`status` 和 `run`。
- 看板每个账号显示一张卡片，以账号名称为标题，显示今日请求数、免费额度进度条和 Workers、Pages 项目列表。进度条按占用率变色，用量未知时显示文字原因，避免与零消耗混淆。页面可见时每分钟查询，也可手动刷新。
- 项目列表展示项目名称和可从 Cloudflare 确认的访问链接。Worker 的 `workers.dev` 地址关闭、项目无公开地址或权限不足时，显示对应提示。[Worker 公开地址说明](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/#manage-access-to-workersdev)
- 用户点击账号卡片上的「复制部署命令」后，可直接粘贴 `cf-hub run '我的账号' -- deploy` 这类命令。点击仅复制，并给出结果反馈。

### CF-05 在看板管理账号

- 用户点击添加，填写账号名称、Account ID 和 API Token。保存时访问 Cloudflare 校验 Token 是否能访问所填账号。验证成功后写入 `accounts.json`。验证失败则保留表单，并提示是账号、权限还是连通性问题。
- 用户编辑账号时，只能看到 Token 已设置的掩码或提示，页面和本地接口均不会返回原值。Token 输入留空时保留原值。变更 Account ID 或 Token 时，重新验证后保存。
- 用户确认删除后，只移除本地账号记录。刷新看板或下一次执行终端命令时，即可看到变更。
- 账号配置修改只接受由本地看板发出的请求，外部网页不能借访问本机地址修改用户账号。

### CF-06 安装与代理网络

- 安装包通过 `package.json` 的 `bin` 提供 `cf-hub`。交付时在 README 提供 `npm install && npm link` 和简短验证步骤。
- CLI 和看板发往 Cloudflare 的请求自动读取代理设置，至少覆盖 `HTTP_PROXY`、`HTTPS_PROXY` 和用于直连例外的 `NO_PROXY`。未配置代理时直接连接。
- CLI 可在看板关闭时使用。获取实时状态和执行真实部署仍需能连到 Cloudflare。断网时应提示连接失败。

## 4. 首版验收

| 验收项 | 关联需求 | 操作与预期结果 |
| --- | --- | --- |
| 全局命令与本地配置 | CF-01、CF-06 | 安装并链接后，切换到两个不同业务目录执行 `cf-hub list`。两次都列出相同的账号名称和 Account ID，且没有 Token。 |
| 实时状态与排名 | CF-02 | 配置两个可查询的账号后运行 `status` 和 `status --json`。项目列表完整，统计窗口从当日 UTC 00:00 开始，百分比以 100,000 次为基准且标明统计口径，排名与输出的请求数一致，JSON 可直接解析。 |
| D1 与 KV 用量 | CF-02 | 对有对应查询权限的账号，检查 D1 读取行数和 KV 读取次数。权限不足时，仅受影响的用量显示「未知」。 |
| 局部故障 | CF-02 | 使用权限不足的 Token 查询，或让一个账号的请求超时。对应项目或数值标为未知并说明原因，其他成功结果照常显示，未知用量不进入排名。 |
| 部署与账号隔离 | CF-03 | 关闭看板后，用两个测试账号分别运行 Wrangler，确认每次只访问指定账号。在获准后向测试账号验证一次 Workers 和一次 Pages 部署。执行前后，原终端的 Cloudflare 凭据保持一致。 |
| 拦截冲突 | CF-03 | 用 `cf-2` 运行实际配置指向 `cf-1` 的项目。分别覆盖直接配置和 `--config` 或生成配置，确认命令显示具体冲突并在 Wrangler 运行前停止。 |
| 人工确认 | CF-03 | 请 Agent 查询并准备部署。用户未同意前，只展示项目、账号和命令。用户明确同意后，才执行本次命令。 |
| 看板与复制 | CF-04 | 执行 `cf-hub ui`。浏览器打开 `http://127.0.0.1:3456`，能查看用量、项目和可确认的链接，点击后能粘贴对应账号的部署命令。关闭终端后地址无法访问，CLI 仍可使用。 |
| 网页管理账号 | CF-05 | 分别用有效和无效凭据添加账号。有效记录能被 CLI 读到，无效记录无法保存。编辑时 Token 不会回填，删除后本地列表移除记录，Cloudflare 项目保持原样。 |
| 代理网络 | CF-06 | 在需经过代理才能访问 Cloudflare 的环境中设置代理变量，验证 `status` 和看板校验账号均可用。断开网络后检查失败提示。 |

## 5. 开发验证

统计口径、代理和其他开发验证事项见 [首版任务](tasklists.md#随开发验证)。
