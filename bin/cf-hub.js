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
  } else if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(usage);
  } else {
    throw new Error(usage);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
