import { fork } from 'node:child_process';
import { once } from 'node:events';
import { accountsPath, createAccountStore } from './accounts.js';
import { createCloudflare } from './cloudflare.js';
import { openBrowser, startDashboard } from './dashboard.js';

async function startBrowserSession() {
  const store = createAccountStore();
  const cloudflare = await createCloudflare();
  const options = {
    store, status: cloudflare.status, validate: cloudflare.validate,
    open: false, browserSession: true, discoveryKey: accountsPath,
  };
  try {
    const app = await startDashboard(options).catch(error => {
      if (error.code !== 'EADDRINUSE') throw error;
      return startDashboard({ ...options, port: 0 });
    });
    if (app.reused) cloudflare.close();
    else app.server.once('close', cloudflare.close);
    return app.url;
  } catch (error) {
    cloudflare.close();
    throw error;
  }
}

if (process.send) {
  try {
    process.send({ url: await startBrowserSession() });
  } catch (error) {
    process.send({ error: error.message });
  } finally {
    process.disconnect();
  }
} else {
  const child = fork(new URL(import.meta.url), [], {
    detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  try {
    const [result] = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => { throw new Error('无法启动本地看板。'); }),
    ]);
    if (result.error) throw new Error(result.error);
    await openBrowser(result.url).catch(() => {
      throw new Error(`无法自动打开浏览器，请在浏览器中访问 ${result.url}。`);
    });
    console.log(`看板已启动：${result.url}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    child.unref();
  }
}
