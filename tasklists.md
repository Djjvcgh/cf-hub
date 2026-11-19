# cf-hub 首版任务

需求与完成标准见 [PRD.md](PRD.md#4-首版验收)。需求和技术方案已确定。每项任务在原条目更新状态，完成后补提交号或可复用的验证证据。

| 编号 | 任务 | 依赖 | 状态 | 完成标准 |
| --- | --- | --- | --- | --- |
| 01 | 建立命令入口、共享账号配置和 `list` | — | 完成 | Windows 临时 npm 全局目录验证跨目录调用；`npm test` 覆盖空配置、损坏文件和并发保存。 |
| 02 | 做 `status` 和 Cloudflare 查询 | 01 | 已实现 | `npm test` 覆盖分页、UTC 统计窗口、部分失败、零用量和排名。真实账号用量见下方验收项。 |
| 03 | 接入 Wrangler 和账号检查 | 01 | 完成 | `npm test` 覆盖显式配置、命名环境和生成配置的冲突。Windows 使用已链接命令和带空格项目目录完成 Wrangler `--dry-run`。 |
| 04 | 做可点通的本地看板 | 01 | 完成 | 本机 Edge 验证了演示卡片、表单、添加、移除和复制命令。演示入口为 `cf-hub ui --demo`。 |
| 05 | 接上真实查询和账号增删改 | 02、04 | 已实现 | Edge 使用本地测试数据验收了校验失败、添加、编辑、移除、复制和项目链接，`npm test` 覆盖本地接口授权。 |
| 06 | 完成验收与安装说明 | 02、03、05 | 待真实账号 | README 已补齐。Workers 和 Pages Functions 验收样例已在本地打包。配置测试账号后核对真实用量，按部署确认约定分别验证 Workers 和 Pages 发布。 |

## 随开发验证

- **任务 02、06** 使用真实 Cloudflare 测试账号核对 Workers、Pages、D1、KV 和统计覆盖范围。有 Pages Functions 活动时，和 Cloudflare 用量页面对照。
- **任务 02** Windows 手动代理已通过联机验收。清除测试进程的代理变量后，通过系统手动代理收到 Cloudflare HTTPS 响应。临时设置 `NO_PROXY=api.cloudflare.com` 后改为直连，同样收到 Cloudflare 响应。实际错误 `9106` 已校验会提示 Token 无效。
