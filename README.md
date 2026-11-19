# cf-hub

一个轻量的本地 Cloudflare 多账号工具。你可以在终端查看各账号的项目和今日用量，选定账号后运行 Wrangler，也可以临时打开网页管理账号。

## 安装

准备 [Node.js 24 LTS](https://nodejs.org/en/about/previous-releases)，在 cf-hub 项目目录执行 `npm install && npm link`。如果 PowerShell 不支持 `&&`，分两行执行，等 `npm install` 成功后再执行 `npm link`。

## 第一次使用

1. 运行 `cf-hub ui`，在打开的 `http://127.0.0.1:3456` 添加 Cloudflare 账号。Token 只授权对应账号，并开通你要使用的产品权限。账号保存到 `~/.cf-hub/accounts.json`。[创建 Cloudflare API Token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
2. 在终端按 `Ctrl+C` 关掉看板。切到任意业务项目目录执行 `cf-hub list` 和 `cf-hub status`。给 Agent 使用时可执行 `cf-hub status --json`。
3. 确认项目和账号后，运行 `cf-hub run cf-2 -- deploy` 部署 Workers，或运行 `cf-hub run cf-1 -- pages deploy ./dist` 部署 Pages。把示例别名换成实际别名。

想先看看界面，可以跑 `cf-hub ui --demo`。表单修改随演示关闭而清除。想先验证 Workers 配置，可以在业务项目里运行 `cf-hub run cf-2 -- deploy --dry-run --outdir ./cf-hub-dry-run`，查看本地打包结果。

别名是终端命令里的短名，例如 `my-site`。Cloudflare 上的完整账号名称可以填到「账号名称或备注」，保存后会显示在卡片上。

用量按 UTC 每天零点重新统计。进度条用 100,000 次作为免费版基准。`cf-1` 实测中，Pages Functions 请求出现在单独的统计数据集里，当前看板的比例仅按 Workers 请求估算。两种请求共用免费额度。[Cloudflare Pages Functions 额度说明](https://developers.cloudflare.com/pages/functions/pricing/#free-plan)

## 常见问题

| 遇到的问题 | 怎么处理 |
| --- | --- |
| 终端找不到 `cf-hub` | 在 cf-hub 项目目录重新执行 `npm link`，再开一个终端试试。 |
| 看板提示端口被占用 | 关闭之前启动看板的终端，再运行 `cf-hub ui`。 |
| 查不到用量或提示权限不足 | 看对应账号下的错误提示。用量查询要给该账号的 Token 开通 Account Analytics Read。部署权限按项目另行开启。 |
| 请求连不上 Cloudflare | 确认网络能访问 Cloudflare。程序优先读取 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY`，Windows 上也会读取手动系统代理。如果当前网络用的是自动代理脚本，可在当前终端显式设置代理地址。 |
| 部署提示账号冲突 | 打开提示里的配置文件，核对账号和所选别名后再执行。如果提示来自 `.env`，移除其中指定账号或凭据的设置，让这次命令选择账号。 |
