# cf-hub 首版任务

需求与完成标准见 [PRD.md](PRD.md#4-首版验收)。需求和技术方案已确定。每项任务在原条目更新状态，完成后补提交号或可复用的验证证据。

| 编号 | 任务 | 依赖 | 状态 | 完成标准 |
| --- | --- | --- | --- | --- |
| 01 | 建立命令入口、共享账号配置和 `list` | — | 完成 | Windows 临时 npm 全局目录验证跨目录调用；`npm test` 覆盖空配置、损坏文件和并发保存。 |
| 02 | 做 `status` 和 Cloudflare 查询 | 01 | 完成 | 在真实账号上查到 Workers、Pages、Workers 请求、D1 读取行数和 KV 读取次数。Pages 查询每页使用 10 条，Workers 统计在主数据集不可用时使用 Cloudflare 文档中的备用数据集。 |
| 03 | 接入 Wrangler 和账号检查 | 01 | 完成 | `npm test` 覆盖显式配置、命名环境和生成配置的冲突。Windows 使用已链接命令和带空格项目目录完成 Wrangler `--dry-run`。 |
| 04 | 做可点通的本地看板 | 01 | 完成 | 本机 Edge 验证了演示卡片、表单、添加、移除和复制命令。演示入口为 `cf-hub ui --demo`。 |
| 05 | 接上真实查询和账号增删改 | 02、04 | 完成 | Edge 验证增删改、复制和中文名称显示。真实看板接口返回了两个测试项目的访问地址与用量。 |
| 06 | 完成验收与安装说明 | 02、03、05 | 完成 | 在 `cf-1` 发布了独立 Worker 和 Pages 样例。Worker、Pages 首页及 Pages Functions `/health` 都返回 HTTP 200 和预期内容。全局命令能查到两个项目及访问地址。 |

## 随开发验证

- **任务 02、06** 2026-11-19 对照 Cloudflare 统计数据集。测试 Worker 的入口访问出现在 Workers 统计中，Pages Functions 的 `/health` 访问出现在独立的 Pages 统计中。用 Pages 的生产脚本名查 Workers 数据集，结果为 0。看板按这个口径标注比例。
- **任务 06** Worker 首次上传成功后，Cloudflare 回读元数据暂时返回 `10007`。只读核对 Worker 已存在后重试原命令，启用 `workers.dev` 并验证通过。
- **任务 02** Windows 手动代理已通过联机验收。清除测试进程的代理变量后，通过系统手动代理收到 Cloudflare HTTPS 响应。临时设置 `NO_PROXY=api.cloudflare.com` 后改为直连，同样收到 Cloudflare 响应。实际错误 `9106` 已校验会提示 Token 无效。
