# cf-hub 架构

需求以 [PRD.md](PRD.md) 为准，操作约定见 [design.md](design.md)。

## 1. 技术选型

首版面向单人使用的一台电脑，以 Windows 为首个验收平台。账号数据留在本机，外部服务只有用户已经在用的 Cloudflare。安装依赖需要能访问 npm，查询和部署需要能访问 Cloudflare。两种方案都能使用代理，也都没有要维护的线上服务器。

| 方案 | 技术栈 | 适合的场景与代价 | 用户要维护的东西 |
| --- | --- | --- | --- |
| **A · 原生 Node.js 与轻量网页** | Node.js 24 LTS、JavaScript、Node 自带的 HTTP 和测试工具、原生 HTML/CSS/JavaScript、Cloudflare 官方 Wrangler。 | 一次安装，网页直接运行。开发时需要把少量本地路由、输入校验和错误处理写清楚。 | Node.js、账号 Token 和按需使用的网络代理。 |
| B · TypeScript 与 Express | 同样使用 Node.js 24 LTS 和官方 Wrangler，用 TypeScript 检查数据结构，Express 组织网页接口。 | 接口和数据结构增多时更好维护。首版需额外维护类型检查、构建和框架依赖。 | 与 A 相同，项目维护者另外维护构建依赖。 |

**首版采用 A。** 看板只有账号列表和编辑表单，业务逻辑只有一套。原生 Node.js 足以覆盖终端、网页和网络请求，安装与使用步骤少，选型可以直接落定。[Node.js 长期支持版本](https://nodejs.org/en/about/previous-releases) · [Node.js 代理](https://nodejs.org/download/release/v24.22.1/docs/api/http.html#built-in-proxy-support) · [TypeScript 文档](https://www.typescriptlang.org/docs/handbook/typescript-in-5-minutes.html) · [Express 文档](https://expressjs.com/en/starter/installing/) · [Wrangler 官方文档](https://developers.cloudflare.com/workers/wrangler/)

## 2. 组成与数据流

| 部分 | 职责 |
| --- | --- |
| `cf-hub` 命令 | `list` 读取账号清单，`status` 输出用量，`run` 检查账号后执行 Wrangler，`ui` 启动前台看板。 |
| 共享核心 | 读写账号配置、请求 Cloudflare、生成项目和用量报告。终端和看板直接调用这套逻辑。 |
| Wrangler | `run` 使用的官方命令，由 cf-hub 随安装固定到一个已验证的版本。配置读取和命令执行使用同一版本。 |
| 本地看板 | `ui` 启动后在同一个进程里提供静态页面和本地接口。浏览器向本地接口读数据或管理账号，Cloudflare 请求由这个进程代发。 |

终端 `status` 和浏览器「刷新」都从本地配置取账号，由共享核心按账号向 Cloudflare 查询，再用同一口径生成报告。`run` 单独读取指定账号，先检查 Wrangler 会使用的配置，再为这次执行提供账号凭据。

## 3. 约定与取舍

- **本地文件存储。** `~/.cf-hub/accounts.json` 是唯一账号来源。看板依次处理修改，先写同目录的临时文件再替换原文件，命令读取到的始终是一份完整配置。凭据文件和临时文件都使用当前用户的私有权限。[Windows 文件权限](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls)
- **固定 Wrangler 版本。** 由 cf-hub 自己记录依赖版本，安装时一次备齐。执行时在 cf-hub 安装目录选用已安装的 Wrangler，把业务项目目录明确交给 Wrangler。依赖升级时一起复验配置选择和参数传递。代价是个别业务项目若依赖其他 Wrangler 版本的专用行为，需要先核对兼容性。[npm exec 的包选择](https://docs.npmjs.com/cli/v11/commands/npm-exec/) · [Wrangler 配置读取接口](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/api/integrations/platform/index.ts)
- **进程级凭据。** 查询使用账号记录里的 Token，请求目标仅为 Cloudflare API。部署凭据只出现在对应 Wrangler 的运行环境中。可信边界包含本机用户和要部署的业务项目，Wrangler 执行的项目构建命令也处在这次运行环境内。[Wrangler 环境变量](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/) · [自定义构建](https://developers.cloudflare.com/workers/wrangler/custom-builds/)
- **按需联网。** Cloudflare 请求使用独立的 HTTPS 连接配置，代理变量只作为网络设置读取。Windows 手动设置的代理由本机适配层读取，具体代理优先顺序见 [功能设计](design.md#4-代理与错误提示)。[Node.js 代理](https://nodejs.org/download/release/v24.22.1/docs/api/http.html#built-in-proxy-support) · [Windows 用户代理配置](https://learn.microsoft.com/en-us/windows/win32/winhttp/setting-wininet-proxy-configurations-in-winhttp)
