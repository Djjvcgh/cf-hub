import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { accountRecord, findAccount, InputError, normalizeAccountName, publicAccount } from './accounts.js';
import { quotaReport, quotaWindows, workersFreeLimit, workersOnlyScope } from './quotas.js';

const assets = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/styles.css': ['styles.css', 'text/css'],
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, value, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  res.end(type === 'application/json' ? JSON.stringify(value) : value);
}

async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415, '请使用 JSON 提交表单。');
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 8192) throw new HttpError(413, '表单内容过长。');
  }
  try {
    const value = JSON.parse(body);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {}
  throw new HttpError(400, '表单格式无效。');
}

export async function openBrowser(url) {
  const [program, ...args] = process.platform === 'win32'
    ? ['explorer.exe', url]
    : process.platform === 'darwin' ? ['open', url] : ['xdg-open', url];
  const browser = spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: true });
  browser.unref();
  await once(browser, 'spawn');
}

export function demoDashboard() {
  let accounts = [
    { name: '个人站点与轻量服务', accountId: '1'.repeat(32), apiToken: 'demo' },
    { name: '实验项目与预览环境', accountId: '2'.repeat(32), apiToken: 'demo' },
    { name: '独立测试账号', accountId: '3'.repeat(32), apiToken: 'demo' },
  ];
  const counts = [24680, 78640, null];
  const examples = [
    { workers: [{ name: 'edge-router', urls: [] }, { name: 'image-cache', urls: [] }], pages: [{ name: 'portfolio', urls: [] }] },
    { workers: [{ name: 'preview-api', urls: [] }], pages: [{ name: 'docs-preview', urls: [] }, { name: 'playground', urls: [] }] },
  ];
  let pending = Promise.resolve();
  return {
    store: {
      read: async () => accounts,
      update(change) {
        const write = pending.then(async () => { accounts = await change(accounts); });
        pending = write.catch(() => {});
        return write;
      },
    },
    validate: async () => {},
    status: async () => {
      const { day, month } = quotaWindows();
      return { demo: true, window: day, error: null, accounts: accounts.map(account => {
        const index = Number(account.accountId[0]) - 1;
        const requests = counts[index] === undefined ? 0 : counts[index];
        const quotas = quotaReport(month, {
          workers: requests === null ? null : { requests, scope: workersOnlyScope },
          pagesFunctions: index === 0 ? 1_940 : 0,
          d1: { rowsRead: index === 0 ? 410_000 : 0, rowsWritten: index === 0 ? 1_520 : 0 },
          kv: { read: index === 0 ? 3_400 : 0, write: index === 0 ? 48 : 0, delete: 0, list: 0 },
          neurons: index === 0 ? 3_245 : 0,
          r2Operations: { classA: index === 0 ? 580 : 0, classB: index === 0 ? 2_900 : 0, unclassified: 0 },
          r2Storage: index === 0 ? 1_240_000_000 : 0,
        });
        return {
          ...publicAccount(account), ...(examples[index] ?? { workers: [], pages: [] }),
          usage: {
            workers: { requests, freeLimit: workersFreeLimit, percent: requests === null ? null : requests / (workersFreeLimit / 100), scope: 'demo' },
            d1RowsRead: quotas.d1.rowsRead.used, kvReads: quotas.kv.reads.used, quotas,
          },
          errors: requests === null ? [{ section: 'workersUsage', message: '演示：缺少统计读取权限。' }] : [],
        };
      }) };
    },
  };
}

export async function startDashboard({ store, status, validate, port = 3456, open = true, browserSession = false }) {
  const session = randomBytes(32).toString('hex');
  let tabs = 0;
  let idleTimer;

  function closeWhenIdle(delay) {
    idleTimer = setTimeout(() => server.close(), delay).unref();
  }

  const server = createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== host) return send(res, 403, { error: '请使用本机看板地址。' });
    const path = req.url?.split('?')[0];
    try {
      const asset = Object.hasOwn(assets, path) && assets[path];
      if (req.method === 'GET' && path === '/favicon.ico') return res.writeHead(204).end();
      if (req.method === 'GET' && asset) {
        const [file, type] = asset;
        const body = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
        return send(res, 200, browserSession && file === 'index.html'
          ? body.replace('<body>', '<body data-browser-session>') : body, type);
      }
      if (browserSession && req.method === 'GET' && path === '/api/ui-session') {
        if (req.headers['sec-fetch-site'] !== 'same-origin' || req.headers.accept !== 'text/event-stream') {
          return send(res, 403, { error: '请从本地看板打开。' });
        }
        clearTimeout(idleTimer);
        tabs += 1;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write(': connected\n\n');
        const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20_000).unref();
        res.once('close', () => {
          clearInterval(keepAlive);
          tabs -= 1;
          // A short grace period lets the browser reconnect on refresh.
          if (tabs === 0) closeWhenIdle(5_000);
        });
        return;
      }
      if (req.method === 'GET' && path === '/api/accounts') {
        return send(res, 200, { session, accounts: (await store.read()).map(account => ({ ...publicAccount(account), hasToken: true })) });
      }
      if (req.method === 'GET' && path === '/api/status') return send(res, 200, await status());

      const selector = path?.startsWith('/api/accounts/') ? path.slice('/api/accounts/'.length) : '';
      const add = path === '/api/accounts' && req.method === 'POST';
      const edit = selector && req.method === 'PATCH';
      const remove = selector && req.method === 'DELETE';
      if (!add && !edit && !remove) return send(res, 404, { error: '找不到此地址。' });
      if (req.headers.origin !== `http://${host}` || req.headers['x-cf-hub-session'] !== session) {
        return send(res, 403, { error: '请从本地看板操作。' });
      }
      let name;
      if (!add) {
        try { name = normalizeAccountName(decodeURIComponent(selector)); } catch {}
        if (!name) throw new HttpError(400, '账号名称无效。');
      }
      const body = remove ? null : await jsonBody(req);
      await store.update(async accounts => {
        const previous = findAccount(accounts, name);
        if (!add && !previous) throw new HttpError(404, '账号不存在，请刷新列表。');
        if (remove) return accounts.filter(account => account !== previous);
        const next = accountRecord(body, previous);
        if (findAccount(accounts.filter(account => account !== previous), next.name)) {
          throw new HttpError(409, '这个账号名称已被使用。');
        }
        if (!previous || next.accountId !== previous.accountId || next.apiToken !== previous.apiToken) await validate(next);
        return add ? [...accounts, next] : accounts.map(account => account === previous ? next : account);
      });
      return send(res, add ? 201 : 200, { ok: true });
    } catch (error) {
      return send(res, error.status ?? (error instanceof InputError ? 400 : 500), { error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }).catch(error => {
    if (error.code === 'EADDRINUSE') {
      error.message = `本地端口 ${port} 被占用，请结束之前启动的看板后重试。`;
    }
    throw error;
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  if (browserSession) {
    closeWhenIdle(60_000);
    server.once('close', () => clearTimeout(idleTimer));
  }
  if (open) void openBrowser(url).catch(() => console.error(`请在浏览器中打开 ${url}`));
  return { server, url };
}
