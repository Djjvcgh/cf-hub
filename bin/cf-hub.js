#!/usr/bin/env node
import { accountsPath, createAccountStore, findAccount } from '../src/accounts.js';

const [command, ...args] = process.argv.slice(2);
const store = createAccountStore();
const usage = '用法：cf-hub list | status [--json] | run <账号名称> -- <Wrangler 参数> | ui [--demo]';

try {
  if (command === 'list' && args.length === 0) {
    const accounts = (await store.read()).map(({ name, accountId }) => ({ '账号名称': name, 'Account ID': accountId }));
    if (accounts.length === 0) console.log('还没有配置账号。');
    else console.table(accounts);
  } else if (command === 'status' && (args.length === 0 || (args.length === 1 && args[0] === '--json'))) {
    const { createCloudflare, failedStatus, printStatus } = await import('../src/cloudflare.js');
    const cloudflare = await createCloudflare();
    try {
      const report = await cloudflare.status(store);
      if (args[0] === '--json') console.log(JSON.stringify(report));
      else printStatus(report);
      if (failedStatus(report)) process.exitCode = 1;
    } finally {
      cloudflare.close();
    }
  } else if (command === 'run' && args.length >= 3 && args[1] === '--') {
    const account = findAccount(await store.read(), args[0]);
    if (!account) throw new Error(`找不到账号 ${args[0]}，请先用 cf-hub list 查看账号名称。`);
    const { runWrangler } = await import('../src/wrangler.js');
    process.exitCode = await runWrangler(account, args.slice(2));
  } else if (command === 'ui' && (args.length === 0 || (args.length === 1 && args[0] === '--demo'))) {
    const { demoDashboard, startDashboard } = await import('../src/dashboard.js');
    if (args[0] === '--demo') {
      const { url } = await startDashboard(demoDashboard());
      console.log(`演示看板已启动：${url}`);
    } else {
      const { createCloudflare } = await import('../src/cloudflare.js');
      const cloudflare = await createCloudflare();
      const { url, server } = await startDashboard({ store, discoveryKey: accountsPath, status: () => cloudflare.status(store), validate: cloudflare.validate });
      server.once('close', cloudflare.close);
      console.log(`看板已启动：${url}`);
    }
  } else if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(usage);
  } else {
    throw new Error(usage);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
