# cf-hub 功能设计

本文件维护交互、命令输出和本地接口约定。范围与验收见 [PRD.md](PRD.md)，依赖选择见 [architecture.md](architecture.md)。

## 1. 账号和用量

- 配置文件首次使用时可以不存在，此时显示空列表。配置内容损坏时，提示文件路径和问题，保留原文件。账号名称支持中文和空格，在看板和终端使用同一名称。已有短别名仍可解析到原账号。
- 添加账号或更换 Account ID、Token 时，对该 Account ID 发起只读校验。成功的账号级请求可以确认连通性。其他权限不足的项目在看板和 `status` 分项提示。只改账号名称或删除本地记录时，可直接保存。
- `list` 显示账号名称和 Account ID。`status` 查询开始时以 UTC 固定本次起止时间，列表接口按实际分页规则取齐，Workers、Pages 和各用量项独立汇报结果。
- 排名以同口径的 Workers 请求数升序排列，同值按账号名称排列。存在多种口径时优先用已确认仅含 Workers 的统计。合计单独由 Workers 请求和 Pages Functions 请求计算，前者采用已验证分开的统计口径才可求和。R2 操作按 UTC 月初起算，仅累加已识别的 Standard A/B 类操作，未知类别另列。R2 存储用当日各 Standard 存储桶报告的对象和元数据峰值估算，按字节返回。

### `status --json` 的结构

| 字段 | 用途 |
| --- | --- |
| `window.start`、`window.end` | 本次查询的 UTC 起止时间，使用 ISO 8601。 |
| `accounts[]` | `name`、`accountId`、`workers`、`pages`、`usage` 和 `errors`。兼容字段为 `alias` 和 `remark`。成功查到空项目列表时返回 `[]`，列表未知时返回 `null`。 |
| `accounts[].usage` | 保留 `workers`、`d1RowsRead` 和 `kvReads`。`quotas` 按 `requests`、`d1`、`kv`、`workersAi`、`r2` 分组。度量使用 `used` 与 `freeLimit`。共享请求另外包含两个来源和 `percent`。R2 使用独立的月度 `window`，存储峰值为 `storagePeakBytes`，存储免费基准另用 `storageFreeLimitGbMonths`。未知用量为 `null`。 |
| `accounts[].errors[]` | `section` 和 `message`，说明哪个查询项有问题。 |
| `ranking[]` | 按用量排列的 `name`、兼容字段 `alias` 和 `requests`，用于展示顺序。 |
| `error` | 无法读取配置等阻止生成报告的错误信息。正常生成报告时为 `null`。 |

JSON 模式的标准输出始终是一个 JSON 文档，诊断文字走标准错误。成功生成的空账号报告、完整报告或部分报告均以 `0` 退出。读取配置失败，或有账号但核心查询全失败时，以非零退出并保留相应错误信息。

## 2. 切号部署

1. 在业务项目目录执行 `cf-hub run '我的账号' -- deploy`。工具按名称查找账号，从调用位置和 Wrangler 参数确定实际项目目录、配置来源及命名环境。
2. 用随工具安装的 Wrangler 读取有效配置，覆盖 TOML、JSON、JSONC、显式 `--cwd`、`--config`、`--env` 和框架生成的部署配置。需要确认配置选择与待执行的 Wrangler 命令一致。找不到账号、账号冲突或配置有歧义时，在启动实际命令前提示原因和涉及的文件。
3. 检查通过后，使用 `npx` 执行已安装的同一版 Wrangler，禁用运行时临时安装。按参数逐项转交 `--` 后的内容，并保证 Wrangler 以原业务目录或显式选择的目录工作。检查时一并处理已有登录、环境变量或 `.env` 文件里的账号、认证和 API 地址覆盖。有无法消除的覆盖时停止并提示。工具保留交互式输入输出并传回 Wrangler 的退出码。[Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/#generated-wrangler-configuration) · [Wrangler 环境变量](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) · [npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec/)
4. Agent 代跑时，按 [部署确认约定](decisions-cf-hub.md) 请用户确认本次部署。用户在业务目录自行运行时可直接使用同一条命令。

## 3. 看板

1. 首页先按本地清单列出账号，再分别查询每一行。顶部汇总告急、偏高、充裕和未查到的账号数，并推荐用量统计完整、最紧张一项最低的账号。手动刷新和每分钟自动查询都会保留上次结果及时间。整行查询失败时在账号名下提示原因，局部失败的用量标为未知。排序可选最紧张的排前面（默认）、余量最多的排前面、Workers 请求从少到多和已统计共享请求从少到多。按余量排序时，有未知用量的账号排在完整账号之后。每轮结束后统一排位，未知或不可比较的账号排在最后，同值按名称排列。
2. 主体为用量矩阵，一行一个账号，列为共享请求、D1、KV、Workers AI、R2 和项目数。每格显示该产品里占用率最高的一项及其名称。颜色按 60% 和 80% 两档预警：低于 60% 为绿，60%–80% 为黄，80% 及以上为红，未知为灰。账号的“最紧张一项”取所有已知用量中的最高占用率，R2 存储按今日峰值 GB 对照 10 GB-month 基准估算。页底目录列出额外产品的免费额度和官方链接。
3. 点击任一行在右侧打开详情面板，显示最紧张一项的圆环、全部分项用量条和错误原因、Workers 与 Pages 列表，以及编辑和部署命令入口。面板打开时可以继续点别的行切换，按 Esc 或 × 关闭，刷新时保留打开状态。
4. 每个账号分别提供 Workers 和 Pages 命令预览。Pages 要填写单行构建目录，预览跟随输入更新。点击「复制命令」后显示「已复制」。添加或编辑账号时，提交后在表单内给结果。已保存的 Token 用「已设置」表示，留空时保留原值。删除前显示要移除的账号名称，确认后刷新列表。
5. Windows 快捷脚本复用同一份账号配置已注册的真实看板，演示看板独立。首次启动优先使用 `3456`，占用时使用系统分配的本地端口。脚本打开默认浏览器后退出。快捷启动的看板在一分钟内没有标签页连接，或最后一个标签页离开约五秒后停止。刷新期间允许标签页重新连接。

| 本地接口 | 用途 |
| --- | --- |
| `GET /api/accounts` | 读取账号元数据及 Token 是否已设置。 |
| `GET /api/status` | 使用与 CLI 相同的状态报告。 |
| `GET /api/status/:name?at=…` | 查询单个账号，返回账号报告和时间窗口。看板使用账号清单里的查询时间固定这一轮的统计口径。 |
| `GET /api/ui-session` | Windows 快捷启动时维护同源页面连接，供看板判断标签页是否仍打开。 |
| `POST /api/accounts` | 校验并添加账号。 |
| `PATCH /api/accounts/:name` | 更新账号，按变更内容决定是否重新校验凭据。 |
| `DELETE /api/accounts/:name` | 删除指定本地记录。 |

本地接口与页面使用同一个地址。写入要求同源请求和当次看板会话标记，读取接口只输出适合展示的账号字段。状态和表单响应均省略 Token 原值。编辑完成后清除页面里的 Token 输入。

## 4. 代理与错误提示

- Cloudflare 请求优先读取当前终端或系统传给进程的 `HTTPS_PROXY`、`HTTP_PROXY`，并遵守 `NO_PROXY`。Windows 上没有代理变量时，读取当前登录用户的手动系统代理及直连例外。没有代理时使用直连。看板地址始终走本机。代理设置也可随本次 Wrangler 子进程传递。
- CLI 和看板区分网络超时、凭据无效、接口权限不足和账号冲突。一个查询项失败时给具体原因，保留其他结果。前台 `cf-hub ui` 的端口被占用时提示关闭先前的看板后重试。
