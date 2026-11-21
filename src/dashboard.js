import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { accountRecord, findAccount, InputError, normalizeAccountName, publicAccount } from './accounts.js';
import { quotaReport, quotaWindows, workersFreeLimit, workersOnlyScope } from './quotas.js';
import { registerDashboard } from './dashboard-discovery.js';
import { failedStatus } from './cloudflare.js';
import { setTimeout as delay } from 'node:timers/promises';

const assets = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/styles.css': ['styles.css', 'text/css'],
  '/quotas.js': ['../src/quotas.js', 'text/javascript'],
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
  const names = ['个人站点与轻量服务', '实验项目与预览环境', '独立测试账号', '博客主站', '图床服务', 'AI 助手', '客户 A 官网', '客户 B 小程序后端', '客户 C 数据看板', '备用账号'];
  let accounts = names.map((name, index) => ({ name, accountId: (index + 1).toString(16).repeat(32), apiToken: 'demo' }));
  const project = name => ({ name, urls: [] });
  // 每个演示账号的用量：[Workers, Pages Functions, D1 读, D1 写, KV 读/写/删/列, Neurons, R2 A/B, R2 存储字节]
  const profiles = [
    { usage: [24680, 65_000, 410_000, 1_520, [3_400, 48, 0, 0], 3_245, [580, 2_900], 1_240_000_000], workers: ['edge-router', 'image-cache'], pages: ['portfolio'] },
    { usage: [78640, 0, 0, 0, [0, 0, 0, 0], 0, [0, 0], 0], workers: ['preview-api'], pages: ['docs-preview', 'playground'] },
    null,
    { usage: [30_000, 15_000, 3_050_000, 12_000, [20_000, 120, 3, 10], 500, [52_000, 410_000], 2_100_000_000], workers: ['blog-api', 'comment-worker'], pages: ['blog'] },
    { usage: [8_000, 4_000, 0, 0, [1_200, 30, 0, 2], 0, [930_000, 3_200_000], 8_600_000_000], workers: ['img-upload'], pages: ['img-gallery'] },
    { usage: [21_000, 12_000, 60_000, 800, [5_000, 60, 1, 4], 7_600, [1_000, 8_000], 50_000_000], workers: ['chat-gateway', 'embedding-job'], pages: ['assistant-web'] },
    { usage: [3_000, 2_000, 9_000, 40, [600, 2, 0, 0], 0, [10, 300], null], workers: [], pages: ['client-a-site'],
      errors: [{ section: 'r2Storage', message: 'Cloudflare 今天还没有 R2 存储样本。', code: 'no_sample' }] },
    { usage: [15_000, 7_000, 400_000, 6_000, [40_000, 710, 20, 30], 300, [2_000, 30_000], 300_000_000], workers: ['mini-api', 'mini-cron', 'mini-push'], pages: [] },
    { usage: [9_000, 6_000, 500_000, 2_000, [8_000, 50, 0, 5], 0, [500, 12_000], 150_000_000], workers: ['report-api'], pages: ['client-c-dash'] },
    { usage: [0, 0, null, null, [0, 0, 0, 0], 0, [0, 0], 0], workers: [], pages: [], errors: ['d1RowsRead', 'd1RowsWritten'] },
  ];
  let pending = Promise.resolve();
  return {
    demo: true,
    store: {
      read: async () => accounts,
      update(change) {
        const write = pending.then(async () => { accounts = await change(accounts); });
        pending = write.catch(() => {});
        return write;
      },
    },
    validate: async () => {},
    status: async (selected, now = new Date()) => {
      const { day, month } = quotaWindows(now);
      const rows = selected ? await selected.read() : accounts;
      if (selected && rows[0]?.accountId === '2'.repeat(32)) await delay(2200);
      if (selected && rows[0]?.accountId === '3'.repeat(32)) {
        await delay(650);
        throw new HttpError(504, '演示：连接 Cloudflare 超时。');
      }
      return { demo: true, window: day, error: null, accounts: rows.map(account => {
        const profile = profiles[parseInt(account.accountId[0], 16) - 1] ?? { usage: [0, 0, 0, 0, [0, 0, 0, 0], 0, [0, 0], 0], workers: [], pages: [] };
        const [requests, pagesFunctions, rowsRead, rowsWritten, [read, write, del, list], neurons, [classA, classB], r2Storage] = profile.usage;
        const quotas = quotaReport(month, {
          workers: { requests, scope: workersOnlyScope },
          pagesFunctions,
          d1: { rowsRead, rowsWritten },
          kv: { read, write, delete: del, list },
          neurons,
          r2Operations: { classA, classB, unclassified: 0 },
          r2Storage,
        });
        return {
          ...publicAccount(account), workers: profile.workers.map(project), pages: profile.pages.map(project),
          usage: {
            workers: { requests, freeLimit: workersFreeLimit, percent: requests / (workersFreeLimit / 100), scope: workersOnlyScope },
            d1RowsRead: quotas.d1.rowsRead.used, kvReads: quotas.kv.reads.used, quotas,
          },
          errors: (profile.errors ?? []).map(entry => typeof entry === 'string'
            ? { section: entry, message: '演示：缺少 D1 读取权限。' }
            : entry),
        };
      }) };
    },
  };
}

export async function startDashboard({ store, status, validate, demo = false, port = 3456, open = true, browserSession = false, discoveryKey }) {
  const session = randomBytes(32).toString('hex');
  let tabs = 0;
  let idleTimer;

  function closeWhenIdle(delay) {
    clearTimeout(idleTimer);
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
        return send(res, 200, { session, demo, queryTime: new Date().toISOString(), accounts: (await store.read()).map(account => ({ ...publicAccount(account), hasToken: true })) });
      }
      if (req.method === 'GET' && path === '/api/status') return send(res, 200, await status(store));
      if (req.method === 'GET' && path.startsWith('/api/status/')) {
        let name;
        try { name = decodeURIComponent(path.slice('/api/status/'.length)); } catch {}
        const account = findAccount(await store.read(), name);
        if (!account) throw new HttpError(404, '账号不存在，请刷新列表。');
        const at = new URL(req.url, `http://${host}`).searchParams.get('at');
        const now = at ? new Date(at) : new Date();
        if (!Number.isFinite(now.valueOf())) throw new HttpError(400, '无效的查询时间。');
        const report = await status({ read: async () => [account] }, now);
        if (failedStatus(report)) throw new HttpError(502, report.error || report.accounts[0].errors[0]?.message || '账号查询失败。');
        return send(res, 200, { account: report.accounts[0], window: report.window });
      }

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
  if (discoveryKey && process.platform === 'win32') {
    let registration;
    try {
      registration = await registerDashboard(discoveryKey, url, () => {
        if (browserSession && tabs === 0) closeWhenIdle(60_000);
      });
    } catch (error) {
      server.close();
      throw error;
    }
    if (registration.close) server.once('close', registration.close);
    else if (browserSession) {
      await new Promise(resolve => server.close(resolve));
      return { url: registration.url, reused: true };
    }
  }
  if (browserSession) {
    closeWhenIdle(60_000);
    server.once('close', () => clearTimeout(idleTimer));
  }
  if (open) void openBrowser(url).catch(() => console.error(`请在浏览器中打开 ${url}`));
  return { server, url };
}
