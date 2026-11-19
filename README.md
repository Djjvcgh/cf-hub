# cf-hub

一个轻量的本地 Cloudflare 多账号工具。你可以在终端查看各账号的项目和今日用量，选定账号后运行 Wrangler，也可以临时打开网页管理账号。

首版正在筹备。以下是计划在首版交付后使用的命令。

## 安装

准备 [Node.js 24 LTS](https://nodejs.org/en/about/previous-releases)，在 cf-hub 项目目录执行 `npm install && npm link`。如果 PowerShell 不支持 `&&`，分两行执行，等 `npm install` 成功后再执行 `npm link`。

## 第一次使用

1. 运行 `cf-hub ui`，在打开的 `http://127.0.0.1:3456` 添加 Cloudflare 账号。Token 只授权对应账号，并开通你要使用的产品权限。账号保存到 `~/.cf-hub/accounts.json`。[创建 Cloudflare API Token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
2. 在终端按 `Ctrl+C` 关掉看板。切到任意业务项目目录执行 `cf-hub list` 和 `cf-hub status`。给 Agent 使用时可执行 `cf-hub status --json`。
3. 确认项目和账号后，运行 `cf-hub run cf-2 -- deploy` 部署 Workers，或运行 `cf-hub run cf-1 -- pages deploy ./dist` 部署 Pages。把示例别名换成实际别名。

## 常见问题

| 遇到的问题 | 怎么处理 |
| --- | --- |
| 终端找不到 `cf-hub` | 在 cf-hub 项目目录重新执行 `npm link`，再开一个终端试试。 |
| 看板提示端口被占用 | 关闭之前启动看板的终端，再运行 `cf-hub ui`。 |
| 查不到用量或提示权限不足 | 看对应账号下的错误提示。用量查询要给该账号的 Token 开通 Account Analytics Read。部署权限按项目另行开启。 |
| 请求连不上 Cloudflare | 确认网络能访问 Cloudflare。需要代理时，检查终端里的 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`。 |
| 部署提示账号冲突 | 打开提示里的配置文件，核对账号和所选别名后再执行。 |
