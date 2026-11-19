#!/usr/bin/env node
import { createAccountStore, publicAccount } from '../src/accounts.js';

const [command, ...args] = process.argv.slice(2);
const store = createAccountStore();
const usage = '用法：cf-hub list | status [--json] | run <alias> -- <Wrangler 参数> | ui [--demo]';

try {
  if (command === 'list' && args.length === 0) {
    const accounts = (await store.read()).map(publicAccount);
    if (accounts.length === 0) console.log('还没有配置账号。');
    else console.table(accounts);
  } else if (command === 'ui' && args.length === 1 && args[0] === '--demo') {
    const { demoDashboard, startDashboard } = await import('../src/dashboard.js');
    const { url } = await startDashboard(demoDashboard());
    console.log(`演示看板已启动：${url}`);
  } else if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(usage);
  } else {
    throw new Error(usage);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
