# cf-hub 功能设计

本文件维护交互、命令输出和本地接口约定。范围与验收见 [PRD.md](PRD.md)，依赖选择见 [architecture.md](architecture.md)。

## 1. 账号和用量

- 配置文件首次使用时可以不存在，此时显示空列表。配置内容损坏时，提示文件路径和问题，保留原文件。别名由小写字母、数字和连字符组成，以字母或数字开头，便于直接用于部署命令。
- 添加账号或更换 Account ID、Token 时，对该 Account ID 发起只读校验。成功的账号级请求可以确认连通性。其他权限不足的项目在看板和 `status` 分项提示。只改备注、别名或删除本地记录时，可直接保存。
- `list` 显示别名、备注和 Account ID。`status` 查询开始时以 UTC 固定本次起止时间，列表接口按实际分页规则取齐，Workers、Pages 和各用量项独立汇报结果。
- 排名以同一统计口径的请求数升序排列，同值按别名排列。存在多种统计口径时，优先用已确认仅含 Workers 的口径给出排名。成功查出的零请求参与同口径排名。Pages Functions 的统计范围按实测结果标注，进度百分比基于 PRD 约定的免费版基准。

### `status --json` 的结构

| 字段 | 用途 |
| --- | --- |
| `window.start`、`window.end` | 本次查询的 UTC 起止时间，使用 ISO 8601。 |
| `accounts[]` | `alias`、`remark`、`accountId`、`workers`、`pages`、`usage` 和 `errors`。成功查到空项目列表时返回 `[]`，列表未知时返回 `null`。 |
| `accounts[].usage` | `workers` 内包含 `requests`、`freeLimit`、`percent`、`scope`。`d1RowsRead` 与 `kvReads` 为各自用量。未知数值用 `null`，原因放到同一账号的 `errors`。 |
| `accounts[].errors[]` | `section` 和 `message`，说明哪个查询项有问题。 |
| `ranking[]` | 按用量排列的 `alias` 和 `requests`，用于展示顺序。 |
| `error` | 无法读取配置等阻止生成报告的错误信息。正常生成报告时为 `null`。 |

JSON 模式的标准输出始终是一个 JSON 文档，诊断文字走标准错误。成功生成的空账号报告、完整报告或部分报告均以 `0` 退出。读取配置失败，或有账号但核心查询全失败时，以非零退出并保留相应错误信息。

## 2. 切号部署

1. 在业务项目目录执行 `cf-hub run cf-2 -- deploy`。工具用别名查找账号，从调用位置和 Wrangler 参数确定实际项目目录、配置来源及命名环境。
2. 用随工具安装的 Wrangler 读取有效配置，覆盖 TOML、JSON、JSONC、显式 `--cwd`、`--config`、`--env` 和框架生成的部署配置。需要确认配置选择与待执行的 Wrangler 命令一致。找不到账号、账号冲突或配置有歧义时，在启动实际命令前提示原因和涉及的文件。
3. 检查通过后，使用 `npx` 执行已安装的同一版 Wrangler，禁用运行时临时安装。按参数逐项转交 `--` 后的内容，并保证 Wrangler 以原业务目录或显式选择的目录工作。检查时一并处理已有登录、环境变量或 `.env` 文件里的账号、认证和 API 地址覆盖。有无法消除的覆盖时停止并提示。工具保留交互式输入输出并传回 Wrangler 的退出码。[Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/#generated-wrangler-configuration) · [Wrangler 环境变量](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) · [npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec/)
4. Agent 代跑时，按 [部署确认约定](docs/decisions-cf-hub.md) 请用户确认本次部署。用户在业务目录自行运行时可直接使用同一条命令。

## 3. 看板

1. 执行 `cf-hub ui` 后打开 `http://127.0.0.1:3456`。首页直接显示账号卡片，提供「刷新」和「添加账号」。没账号时显示添加入口。查询期间保留加载提示，查到的项目和用量可独立展示。
2. 每张卡片有别名、备注、今日用量和 Workers、Pages 列表。进度条按 70% 和 90% 两档预警，附数字或「未知」说明。项目有可确认的访问地址时可以点开，无地址时仍显示项目名。
3. 点击「复制部署命令」后显示「已复制」，粘贴得到对应账号的命令。添加或编辑账号时，提交后在表单内给结果。已保存的 Token 用「已设置」表示，留空时保留原值。删除前显示要移除的别名，确认后刷新列表。

| 本地接口 | 用途 |
| --- | --- |
| `GET /api/accounts` | 读取账号元数据及 Token 是否已设置。 |
| `GET /api/status` | 使用与 CLI 相同的状态报告。 |
| `POST /api/accounts` | 校验并添加账号。 |
| `PATCH /api/accounts/:alias` | 更新账号，按变更内容决定是否重新校验凭据。 |
| `DELETE /api/accounts/:alias` | 删除指定本地记录。 |

本地接口与页面使用同一个地址。写入要求同源请求和当次看板会话标记，读取接口只输出适合展示的账号字段。状态和表单响应均省略 Token 原值。编辑完成后清除页面里的 Token 输入。

## 4. 代理与错误提示

- Cloudflare 请求优先读取当前终端或系统传给进程的 `HTTPS_PROXY`、`HTTP_PROXY`，并遵守 `NO_PROXY`。Windows 上没有代理变量时，读取当前登录用户的手动系统代理及直连例外。没有代理时使用直连。看板地址始终走本机。代理设置也可随本次 Wrangler 子进程传递。
- CLI 和看板区分网络超时、凭据无效、接口权限不足和账号冲突。一个查询项失败时给具体原因，保留其他结果。看板端口被占用时提示关闭先前的 `cf-hub ui` 后重试。
