import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Agent, request } from 'node:https';
import { promisify } from 'node:util';
import { publicAccount } from './accounts.js';
import { quotaReport, quotaWindows, rankWorkers, unverifiedScope, workersFreeLimit, workersOnlyScope } from './quotas.js';

const exec = promisify(execFile);
const base = 'https://api.cloudflare.com/client/v4';
const proxyKeys = ['http_proxy', 'https_proxy', 'no_proxy'];
const kvActions = ['read', 'write', 'delete', 'list'];
const r2ClassA = new Set([
  'ListBuckets', 'PutBucket', 'ListObjects', 'PutObject', 'CopyObject', 'CompleteMultipartUpload',
  'CreateMultipartUpload', 'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart',
  'UploadPartCopy', 'ListParts', 'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration',
]);
const r2ClassB = new Set([
  'HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation',
  'GetBucketCors', 'GetBucketLifecycleConfiguration',
]);
const r2FreeActions = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);

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
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
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

function usageNumber(value) {
  if (!Number.isFinite(value) || value < 0) throw new ApiError(502, 'Cloudflare 返回的用量数据无效。');
  return value;
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

  async function analytics(account, window, dataset, selection, { dateOnly = false, limit = 1 } = {}) {
    const [type, key] = dateOnly ? ['Date', 'date'] : ['Time', 'datetime'];
    const variables = {
      accountTag: account.accountId,
      start: dateOnly ? window.start.slice(0, 10) : window.start.replace(/\.\d+Z$/, 'Z'),
      end: dateOnly ? window.end.slice(0, 10) : window.end.replace(/\.\d+Z$/, 'Z'),
    };
    const query = `query CfHubUsage($accountTag: string!, $start: ${type}!, $end: ${type}!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        ${dataset}(limit: ${limit}, filter: { ${key}_geq: $start, ${key}_leq: $end }) { ${selection} }
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
    if (limit > 1 && groups.length >= limit) {
      throw new ApiError(502, 'Cloudflare 返回的统计达到查询上限，无法确认总量。');
    }
    return groups;
  }

  async function metric(account, window, dataset, field) {
    const groups = await analytics(account, window, dataset, `sum { ${field} }`);
    return groups.length ? usageNumber(groups[0]?.sum?.[field]) : 0;
  }

  async function d1Usage(account, day) {
    const groups = await analytics(account, day, 'd1AnalyticsAdaptiveGroups',
      'sum { rowsRead rowsWritten }', { dateOnly: true });
    return groups.length ? groups[0]?.sum ?? {} : { rowsRead: 0, rowsWritten: 0 };
  }

  async function kvUsage(account, day) {
    const groups = await analytics(account, day, 'kvOperationsAdaptiveGroups',
      'sum { requests } dimensions { actionType }', { dateOnly: true, limit: 100 });
    return Object.fromEntries(kvActions.map(action => {
      const group = groups.find(row => row?.dimensions?.actionType === action);
      return [action, group ? group.sum?.requests : 0];
    }));
  }

  async function r2Operations(account, month) {
    const groups = await analytics(account, month, 'r2OperationsAdaptiveGroups',
      'sum { requests } dimensions { actionType storageClass }', { limit: 1000 });
    const counts = { classA: 0, classB: 0, unclassified: 0 };
    for (const { sum, dimensions } of groups) {
      const { actionType, storageClass } = dimensions ?? {};
      if (storageClass === 'InfrequentAccess' || r2FreeActions.has(actionType)) continue;
      const count = usageNumber(sum?.requests);
      if (storageClass === 'Standard' && r2ClassA.has(actionType)) counts.classA += count;
      else if (storageClass === 'Standard' && r2ClassB.has(actionType)) counts.classB += count;
      else counts.unclassified += count;
    }
    return counts;
  }

  async function r2Storage(account, day) {
    const groups = await analytics(account, day, 'r2StorageAdaptiveGroups',
      'max { payloadSize metadataSize } dimensions { bucketName storageClass }', { limit: 1000 });
    if (!groups.length) throw new ApiError(404, 'Cloudflare 今天还没有 R2 存储样本。', 'no_sample');
    if (groups.some(row => !['Standard', 'InfrequentAccess'].includes(row?.dimensions?.storageClass))) {
      throw new ApiError(502, 'Cloudflare 未标明部分 R2 存储样本的类型。');
    }
    return groups.filter(row => row.dimensions.storageClass === 'Standard').reduce((total, { max }) =>
      total + usageNumber(max?.payloadSize) + usageNumber(max?.metadataSize), 0);
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

  async function accountReport(account, { day, month }) {
    const errors = [];
    const queries = {
      workers: workers(account),
      pages: pages(account),
      workersUsage: workerUsage(account, day),
      pagesFunctions: metric(account, day, 'pagesFunctionsInvocationsAdaptiveGroups', 'requests'),
      d1Usage: d1Usage(account, day),
      kvUsage: kvUsage(account, day),
      workersAi: metric(account, day, 'aiInferenceAdaptiveGroups', 'totalNeurons'),
      r2Operations: r2Operations(account, month),
      r2Storage: r2Storage(account, day),
    };
    const results = Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([section, query]) => {
      try {
        return [section, { value: await query }];
      } catch (error) {
        return [section, { error: error.message, ...(error instanceof ApiError && error.code && { code: error.code }) }];
      }
    })));
    function read(section, { from = section, field } = {}) {
      const { value, error, code } = results[from];
      if (error) {
        errors.push({ section, message: error, ...(code && { code }) });
        return null;
      }
      if (!field) return value;
      try {
        return usageNumber(value[field]);
      } catch (problem) {
        errors.push({ section, message: problem.message });
        return null;
      }
    }
    const workersList = read('workers');
    const pagesList = read('pages');
    const workersMetric = read('workersUsage');
    const d1 = {
      rowsRead: read('d1RowsRead', { from: 'd1Usage', field: 'rowsRead' }),
      rowsWritten: read('d1RowsWritten', { from: 'd1Usage', field: 'rowsWritten' }),
    };
    const kv = Object.fromEntries(kvActions.map(action => [action,
      read(`kv${action[0].toUpperCase()}${action.slice(1)}s`, { from: 'kvUsage', field: action }),
    ]));
    const quotas = quotaReport(month, {
      workers: workersMetric,
      pagesFunctions: read('pagesFunctions'),
      d1, kv,
      neurons: read('workersAi'),
      r2Operations: read('r2Operations'),
      r2Storage: read('r2Storage'),
    });
    const { requests, scope } = workersMetric ?? { requests: null, scope: unverifiedScope };
    return {
      ...publicAccount(account), workers: workersList, pages: pagesList,
      usage: {
        workers: { requests, freeLimit: workersFreeLimit, percent: requests === null ? null : requests / (workersFreeLimit / 100), scope },
        d1RowsRead: d1.rowsRead,
        kvReads: kv.read,
        quotas,
      },
      errors,
    };
  }

  return {
    close: () => agent && agent.destroy(),
    async status(store, now = new Date()) {
      const windows = quotaWindows(now);
      const window = windows.day;
      let accounts;
      try {
        accounts = await Promise.all((await store.read()).map(account => accountReport(account, windows)));
      } catch (error) {
        return { window, accounts: [], ranking: [], error: error.message };
      }
      return { window, accounts, ranking: rankWorkers(accounts), error: null };
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
  return Boolean(report.error || (report.accounts.length && report.accounts.every(({ workers, pages, usage }) => {
    const { requests, d1, kv, workersAi, r2 } = usage.quotas;
    return [
      workers, pages, requests.workers, requests.pagesFunctions, d1.rowsRead.used, d1.rowsWritten.used,
      ...Object.values(kv).map(quota => quota.used), workersAi.neurons.used, r2.classA.used, r2.storagePeakBytes,
    ].every(value => value === null);
  })));
}

export function printStatus(report) {
  if (report.error) return console.error(report.error);
  if (!report.accounts.length) return console.log('还没有配置账号，可用 cf-hub ui 添加。');
  const format = number => number === null ? '未知' : number.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  const quota = ({ used, freeLimit }) => `${format(used)} / ${format(freeLimit)}`;
  const labels = {
    workers: 'Workers 列表', pages: 'Pages 列表', workersUsage: 'Workers 请求', pagesFunctions: 'Pages Functions',
    d1RowsRead: 'D1 读取', d1RowsWritten: 'D1 写入', kvReads: 'KV 读取', kvWrites: 'KV 写入',
    kvDeletes: 'KV 删除', kvLists: 'KV 列表', workersAi: 'Workers AI', r2Operations: 'R2 操作', r2Storage: 'R2 存储',
  };
  console.log(`今日用量（UTC 零点 / 北京时间 08:00） ${report.window.start} 至 ${report.window.end}`);
  for (const account of report.accounts) {
    const { requests, d1, kv, workersAi, r2 } = account.usage.quotas;
    const coverage = requests.percent === null ? `合计 ${quota(requests)}` : `已统计合计 ${quota(requests)}（${format(requests.percent)}%）`;
    const unclassified = r2.unclassifiedOperations > 0 ? ` · 待归类 ${format(r2.unclassifiedOperations)} 次` : '';
    const storageGb = r2.storagePeakBytes === null ? null : r2.storagePeakBytes / 1e9;
    const storage = storageGb === null ? '未知' : `${storageGb > 0 && storageGb < 0.001 ? '< 0.001' : format(storageGb)} GB`;
    console.log(`\n${account.name}`);
    console.log(`  Workers 请求 ${format(requests.workers)} · Pages Functions ${format(requests.pagesFunctions)} · ${coverage}`);
    if (requests.used === null && requests.workers !== null && requests.pagesFunctions !== null) {
      console.log('  目前无法确认两项请求统计是否重叠。');
    }
    console.log('  Workflows 也可能占用同一请求额度。');
    console.log(`  Workers ${account.workers?.map(project => project.name).join('、') || (account.workers === null ? '未知' : '空')}`);
    console.log(`  Pages   ${account.pages?.map(project => project.name).join('、') || (account.pages === null ? '未知' : '空')}`);
    console.log(`  D1 读取 ${quota(d1.rowsRead)} 行 · 写入 ${quota(d1.rowsWritten)} 行`);
    console.log(`  KV 读取 ${quota(kv.reads)} · 写入 ${quota(kv.writes)} · 删除 ${quota(kv.deletes)} · 列表 ${quota(kv.lists)}（统计次数，批量操作按键计费）`);
    console.log(`  Workers AI ${quota(workersAi.neurons)} Neurons`);
    console.log(`  R2 Standard（${r2.window.start.slice(0, 7)} UTC 日历月估算） A 类 ${quota(r2.classA)} · B 类 ${quota(r2.classB)}${unclassified}`);
    console.log(`  R2 今日各桶存储峰值合计 ${storage} · 每月存储免费基准 ${r2.storageFreeLimitGbMonths} GB-month`);
    for (const { section, message } of account.errors) console.log(`  ${labels[section] ?? section}：${message}`);
  }
  if (report.ranking.length) console.log(`\n今日 Workers 排名：${report.ranking.map(entry => `${entry.name} (${entry.requests})`).join(' → ')}`);
}
