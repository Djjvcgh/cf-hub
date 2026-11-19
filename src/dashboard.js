import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { accountRecord, aliasPattern, InputError, publicAccount } from './accounts.js';

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

function openBrowser(url) {
  const [program, ...args] = process.platform === 'win32'
    ? ['explorer.exe', url]
    : process.platform === 'darwin' ? ['open', url] : ['xdg-open', url];
  const browser = spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: true });
  browser.on('error', () => console.error(`请在浏览器中打开 ${url}`));
  browser.unref();
}

export function demoDashboard() {
  let accounts = [
    { alias: 'cf-1', remark: '个人站点与轻量服务', accountId: '1'.repeat(32), apiToken: 'demo' },
    { alias: 'cf-2', remark: '实验项目与预览环境', accountId: '2'.repeat(32), apiToken: 'demo' },
    { alias: 'cf-lab', remark: '独立测试账号', accountId: '3'.repeat(32), apiToken: 'demo' },
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
      const end = new Date().toISOString();
      return { demo: true, window: { start: `${end.slice(0, 10)}T00:00:00.000Z`, end }, error: null, accounts: accounts.map(account => {
        const index = Number(account.accountId[0]) - 1;
        const requests = counts[index] === undefined ? 0 : counts[index];
        return {
          ...publicAccount(account), ...(examples[index] ?? { workers: [], pages: [] }),
          usage: { workers: { requests, freeLimit: 100000, percent: requests === null ? null : requests / 1000, scope: 'demo' } },
          errors: requests === null ? [{ section: 'workersUsage', message: '演示：缺少统计读取权限。' }] : [],
        };
      }) };
    },
  };
}

export async function startDashboard({ store, status, validate, port = 3456, open = true }) {
  const session = randomBytes(32).toString('hex');
  const server = createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== host) return send(res, 403, { error: '请使用本机看板地址。' });
    const path = req.url?.split('?')[0];
    try {
      const asset = Object.hasOwn(assets, path) && assets[path];
      if (req.method === 'GET' && asset) {
        const [file, type] = asset;
        return send(res, 200, await readFile(new URL(`../public/${file}`, import.meta.url)), type);
      }
      if (req.method === 'GET' && path === '/api/accounts') {
        return send(res, 200, { session, accounts: (await store.read()).map(account => ({ ...publicAccount(account), hasToken: true })) });
      }
      if (req.method === 'GET' && path === '/api/status') return send(res, 200, await status());

      const alias = path?.startsWith('/api/accounts/') ? path.slice('/api/accounts/'.length) : '';
      const add = path === '/api/accounts' && req.method === 'POST';
      const edit = aliasPattern.test(alias) && req.method === 'PATCH';
      const remove = aliasPattern.test(alias) && req.method === 'DELETE';
      if (!add && !edit && !remove) return send(res, 404, { error: '找不到此地址。' });
      if (req.headers.origin !== `http://${host}` || req.headers['x-cf-hub-session'] !== session) {
        return send(res, 403, { error: '请从本地看板操作。' });
      }
      const body = remove ? null : await jsonBody(req);
      await store.update(async accounts => {
        const previous = accounts.find(account => account.alias === alias);
        if (!add && !previous) throw new HttpError(404, '账号不存在，请刷新列表。');
        if (remove) return accounts.filter(account => account !== previous);
        const next = accountRecord(body, previous);
        if (accounts.some(account => account !== previous && account.alias === next.alias)) {
          throw new HttpError(409, '这个别名已被使用。');
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
    if (error.code === 'EADDRINUSE') throw new Error(`本地端口 ${port} 被占用，请结束之前启动的看板后重试。`);
    throw error;
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  if (open) openBrowser(url);
  return { server, url };
}
