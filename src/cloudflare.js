import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Agent, request } from 'node:https';
import { promisify } from 'node:util';
import { publicAccount } from './accounts.js';

const exec = promisify(execFile);
const base = 'https://api.cloudflare.com/client/v4';
const freeLimit = 100_000;
const proxyKeys = ['http_proxy', 'https_proxy', 'no_proxy'];
const workersOnlyScope = 'workers-invocations; pages-functions-separate';
const unverifiedScope = 'workers-invocations; pages-functions-unverified';

export async function proxyEnvironment(env = process.env) {
  const settings = Object.fromEntries(Object.entries(env).filter(([key, value]) => value && proxyKeys.includes(key.toLowerCase())));
  if (!settings.HTTPS_PROXY && !settings.https_proxy && (settings.http_proxy || settings.HTTP_PROXY)) {
    settings.HTTPS_PROXY = settings.http_proxy || settings.HTTP_PROXY;
  }
  if (process.platform !== 'win32' || Object.keys(settings).some(key => key.toLowerCase() !== 'no_proxy')) return settings;
  const script = `$p = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings')
    if ($p -and $p.GetValue('ProxyEnable') -eq 1) {
      [Console]::WriteLine([string]$p.GetValue('ProxyServer'))
      [Console]::WriteLine([string]$p.GetValue('ProxyOverride'))
    }`;
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 2500 });
    const [server, bypass] = stdout.split(/\r?\n/);
    if (!server) return settings;
    const proxies = server.includes('=')
      ? server.split(';').map(value => value.split('='))
      : [['http', server], ['https', server]];
    for (const [protocol, address] of proxies) {
      if (!['http', 'https'].includes(protocol) || !address) continue;
      settings[`${protocol.toUpperCase()}_PROXY`] = /^https?:\/\//i.test(address) ? address : `http://${address}`;
    }
    if (bypass && !Object.keys(settings).some(key => key.toLowerCase() === 'no_proxy')) {
      settings.NO_PROXY = bypass.split(';').map(host => host.trim().replace(/^\*\./, '.')).filter(host => host && host !== '<local>').join(',');
    }
  } catch {
    // The Cloudflare request will report a connection error if this system requires a proxy.
  }
  return settings;
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function httpError(status, errors) {
  const codes = new Set((Array.isArray(errors) ? errors : []).map(error => error?.code));
  if (status === 401 || [10001, 9106, 9109, 6111].some(code => codes.has(code))) return new ApiError(401, 'API Token 无效或已失效。');
  if (status === 403 || codes.has(10000)) return new ApiError(403, 'Token 没有此账号或接口的读取权限。');
  if (status === 404) return new ApiError(404, 'Cloudflare 找不到这个账号或资源。');
  if (status === 429) return new ApiError(429, 'Cloudflare 请求太频繁，请稍后刷新。');
  return new ApiError(502, `Cloudflare 查询失败（HTTP ${status}）。`);
}

export async function createCloudflare({ transport } = {}) {
  let agent;
  let proxyError;
  const workerLinks = new Map();
  const workersFallback = new Set();
  if (!transport) {
    try {
      agent = new Agent({ proxyEnv: await proxyEnvironment(), keepAlive: true, maxSockets: 12 });
    } catch {
      proxyError = new ApiError(502, '代理地址无效，请检查 HTTP_PROXY 和 HTTPS_PROXY。');
    }
  }

  function send(path, account, body) {
    if (transport) return transport(path, account, body);
    if (proxyError) return Promise.reject(proxyError);
    return new Promise((resolve, reject) => {
      const payload = body && JSON.stringify(body);
      const signal = AbortSignal.timeout(12_000);
      const req = request(`${base}${path}`, {
        agent, signal, method: payload ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${account.apiToken}`, Accept: 'application/json',
          ...(payload && { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
        },
      }, async response => {
        try {
          const parts = [];
          for await (const chunk of response) parts.push(chunk);
          let data;
          try { data = JSON.parse(Buffer.concat(parts)); } catch {}
          if (response.statusCode !== 200 || data?.success === false) throw httpError(response.statusCode, data?.errors);
          if (data === undefined) throw new ApiError(502, 'Cloudflare 返回了无法读取的数据。');
          resolve(data);
        } catch (error) {
          reject(error instanceof ApiError ? error : new ApiError(502, 'Cloudflare 响应中断。'));
        }
      });
      req.once('error', error => reject(error.name === 'AbortError'
        ? new ApiError(504, '连接 Cloudflare 超时。')
        : new ApiError(502, '无法连接 Cloudflare，请检查网络和代理。')));
      req.end(payload);
    });
  }

  function accountPath(account, path) {
    return `/accounts/${account.accountId}${path}`;
  }

  async function list(account, path, paginated = false) {
    const output = [];
    // The Pages list endpoint rejects page sizes greater than 10 for some accounts.
    let pageSize = paginated ? 10 : undefined;
    let page = 1;
    let lastPage = 1;
    do {
      const url = accountPath(account, path);
      const { result, result_info: info } = await send(pageSize ? `${url}?per_page=${pageSize}&page=${page}` : url, account);
      if (!Array.isArray(result)) throw new ApiError(502, 'Cloudflare 返回的项目列表无效。');
      output.push(...result);
      const count = info?.total_pages ?? (info?.per_page > 0 ? Math.ceil(info.total_count / info.per_page) : undefined);
      if (Number.isSafeInteger(count) && count >= page) lastPage = count;
      if (!pageSize && lastPage > page) pageSize = info?.per_page ?? 10;
      page += 1;
    } while (page <= lastPage);
    return output;
  }

  async function workers(account) {
    const scripts = await list(account, '/workers/scripts');
    const names = scripts.flatMap(script => typeof script.id === 'string' ? [script.id] : []);
    if (!names.length) {
      workerLinks.delete(account.accountId);
      return [];
    }
    const namesKey = JSON.stringify(names);
    const tokenKey = createHash('sha256').update(account.apiToken).digest('base64url');
    const cached = workerLinks.get(account.accountId);
    if (cached?.tokenKey === tokenKey && cached.namesKey === namesKey && cached.expires > Date.now()) return cached.projects;

    let cacheable = true;
    function readLinkData(promise) {
      return promise.catch(error => {
        if (error.status !== 403 && error.status !== 404) cacheable = false;
        return null;
      });
    }
    const [subdomain, domains, flags] = await Promise.all([
      readLinkData(send(accountPath(account, '/workers/subdomain'), account)).then(data => data?.result?.subdomain),
      readLinkData(list(account, '/workers/domains')),
      Promise.all(names.map(name => readLinkData(send(accountPath(account, `/workers/scripts/${encodeURIComponent(name)}/subdomain`), account)))),
    ]);
    const projects = names.map((name, index) => {
      const custom = (domains ?? []).filter(domain => domain.service === name && domain.enabled !== false).map(domain => domain.hostname);
      const enabled = flags[index]?.result?.enabled;
      const standard = subdomain && enabled === true ? `${name}.${subdomain}.workers.dev` : undefined;
      const urls = webUrls([...custom, standard]);
      const linkNote = enabled === false ? 'workers.dev 已关闭' : '无法确认 Workers 访问地址';
      return { name, urls, ...(!urls.length && linkNote && { linkNote }) };
    });
    if (cacheable) workerLinks.set(account.accountId, { tokenKey, namesKey, projects, expires: Date.now() + 120_000 });
    return projects;
  }

  async function pages(account) {
    return (await list(account, '/pages/projects', true)).filter(project => typeof project.name === 'string').map(project => {
      const deployment = project.canonical_deployment;
      const urls = deployment ? webUrls([project.subdomain, ...(deployment.aliases ?? []), deployment.url]) : [];
      return { name: project.name, urls };
    });
  }

  async function metric(account, window, dataset, field, { dateOnly = false, extra = '' } = {}) {
    const [type, key] = dateOnly ? ['Date', 'date'] : ['Time', 'datetime'];
    const variables = {
      accountTag: account.accountId,
      start: dateOnly ? window.start.slice(0, 10) : window.start.replace(/\.\d+Z$/, 'Z'),
      end: dateOnly ? window.end.slice(0, 10) : window.end.replace(/\.\d+Z$/, 'Z'),
    };
    const query = `query CfHubUsage($accountTag: string!, $start: ${type}!, $end: ${type}!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        ${dataset}(limit: 1, filter: { ${key}_geq: $start, ${key}_leq: $end ${extra} }) { sum { ${field} } }
      } }
    }`;
    const response = await send('/graphql', account, { query, variables });
    if (response.errors?.length) {
      const messages = response.errors.map(error => error?.message).join(' ');
      if (/auth|permission|access denied|not allowed|forbidden/i.test(messages)) throw new ApiError(403, 'Token 没有此账号的统计读取权限。');
      if (messages.includes(dataset) && /unknown field|cannot query field|does not exist/i.test(messages)) {
        throw new ApiError(501, 'Cloudflare 当前未提供这项统计。');
      }
      throw new ApiError(502, 'Cloudflare 无法返回这项统计。');
    }
    const entry = response.data?.viewer?.accounts?.[0];
    const groups = entry?.[dataset];
    if (!Array.isArray(groups)) throw new ApiError(403, 'Token 无法读取此账号的统计。');
    if (!groups.length) return 0;
    const value = groups[0]?.sum?.[field];
    if (!Number.isFinite(value) || value < 0) throw new ApiError(502, 'Cloudflare 返回的用量数据无效。');
    return value;
  }

  async function workerUsage(account, window) {
    if (!workersFallback.has(account.accountId)) {
      try {
        const requests = await metric(account, window, 'workersInvocationsAdaptiveGroups', 'requests');
        return { requests, scope: unverifiedScope };
      } catch (error) {
        if (error.status !== 501) throw error;
        workersFallback.add(account.accountId);
      }
    }
    const requests = await metric(account, window, 'workersInvocationsAdaptive', 'requests');
    return { requests, scope: workersOnlyScope };
  }

  async function accountReport(account, window) {
    const errors = [];
    const sections = ['workers', 'pages', 'workersUsage', 'd1RowsRead', 'kvReads'];
    const results = await Promise.allSettled([
      workers(account), pages(account), workerUsage(account, window),
      metric(account, window, 'd1AnalyticsAdaptiveGroups', 'rowsRead', { dateOnly: true }),
      metric(account, window, 'kvOperationsAdaptiveGroups', 'requests', { dateOnly: true, extra: 'actionType: "read"' }),
    ]);
    const [workersList, pagesList, workersMetric, d1RowsRead, kvReads] = results.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      errors.push({ section: sections[index], message: result.reason.message });
      return null;
    });
    const { requests, scope } = workersMetric ?? { requests: null, scope: unverifiedScope };
    return {
      ...publicAccount(account), workers: workersList, pages: pagesList,
      usage: {
        workers: { requests, freeLimit, percent: requests === null ? null : requests / (freeLimit / 100), scope },
        d1RowsRead, kvReads,
      },
      errors,
    };
  }

  return {
    close: () => agent && agent.destroy(),
    async status(store, now = new Date()) {
      const end = now.toISOString();
      const window = { start: `${end.slice(0, 10)}T00:00:00.000Z`, end };
      let accounts;
      try {
        accounts = await Promise.all((await store.read()).map(account => accountReport(account, window)));
      } catch (error) {
        return { window, accounts: [], ranking: [], error: error.message };
      }
      const known = accounts.filter(account => account.usage.workers.requests !== null);
      const rankingScope = known.some(account => account.usage.workers.scope === workersOnlyScope) ? workersOnlyScope : unverifiedScope;
      const ranking = known.filter(account => account.usage.workers.scope === rankingScope)
        .map(({ alias, name, usage }) => ({ alias, name, requests: usage.workers.requests }))
        .sort((a, b) => a.requests - b.requests || a.name.localeCompare(b.name));
      return { window, accounts, ranking, error: null };
    },
    async validate(account) {
      const listing = async path => {
        if (!Array.isArray((await send(accountPath(account, path), account)).result)) {
          throw new ApiError(502, 'Cloudflare 返回的账号验证结果无效。');
        }
      };
      await Promise.any([listing('/workers/scripts'), listing('/pages/projects?per_page=1&page=1')]).catch(({ errors }) => {
        const problem = errors.find(error => error.status === 401)
          ?? errors.find(error => error.status === 403 || error.status === 404) ?? errors[0];
        throw problem;
      });
    },
  };
}

function webUrls(values) {
  const urls = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value) continue;
    try {
      const url = new URL(value.includes('://') ? value : `https://${value}`);
      if (url.protocol === 'https:' && !url.username && !url.password) urls.add(url.href);
    } catch {}
  }
  return [...urls];
}

export function failedStatus(report) {
  return Boolean(report.error || (report.accounts.length && report.accounts.every(({ workers, pages, usage }) =>
    workers === null && pages === null && usage.workers.requests === null)));
}

export function printStatus(report) {
  if (report.error) return console.error(report.error);
  if (!report.accounts.length) return console.log('还没有配置账号，可用 cf-hub ui 添加。');
  console.log(`今日用量（UTC） ${report.window.start} 至 ${report.window.end}`);
  for (const account of report.accounts) {
    const { requests, percent, scope } = account.usage.workers;
    const coverage = scope === workersOnlyScope ? '仅 Workers，Pages Functions 用量另计' : 'Pages Functions 覆盖未确认';
    console.log(`\n${account.name}`);
    console.log(`  Workers 请求 ${requests === null ? '未知' : `${requests.toLocaleString('zh-CN')} / 100,000（${percent.toFixed(2)}%，估算，${coverage}）`}`);
    console.log(`  Workers ${account.workers?.map(project => project.name).join('、') || (account.workers === null ? '未知' : '空')}`);
    console.log(`  Pages   ${account.pages?.map(project => project.name).join('、') || (account.pages === null ? '未知' : '空')}`);
    console.log(`  D1 读取 ${account.usage.d1RowsRead ?? '未知'} 行 · KV 读取 ${account.usage.kvReads ?? '未知'} 次`);
    for (const { section, message } of account.errors) console.log(`  ${section}：${message}`);
  }
  if (report.ranking.length) console.log(`\n今日用量排名：${report.ranking.map(entry => `${entry.name} (${entry.requests})`).join(' → ')}`);
}
