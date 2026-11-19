import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createAccountStore, findAccount } from '../src/accounts.js';
import { createCloudflare, failedStatus } from '../src/cloudflare.js';
import { startDashboard } from '../src/dashboard.js';

const first = { name: '个人 Cloudflare 账号', alias: 'cf-1', accountId: '1'.repeat(32), apiToken: 'private-token-1' };
const second = { name: '测试账号', alias: 'cf-2', accountId: '2'.repeat(32), apiToken: 'private-token-2' };

async function localStore(t) {
  const root = await mkdtemp(join(tmpdir(), 'cf-hub-test-'));
  const directory = join(root, '.cf-hub');
  const path = join(directory, 'accounts.json');
  t.after(async () => {
    await rm(path, { force: true });
    for (const dir of [directory, root]) await rmdir(dir).catch(error => { if (error.code !== 'ENOENT') throw error; });
  });
  return { path, store: createAccountStore(path) };
}

test('account file keeps complete data after concurrent updates and a rejected write', async t => {
  const { path, store } = await localStore(t);
  assert.deepEqual(await store.read(), []);
  await Promise.all([store.update(entries => [...entries, first]), store.update(entries => [...entries, second])]);
  const saved = await readFile(path, 'utf8');
  await assert.rejects(store.update(() => { throw new Error('test rejection'); }), /test rejection/);
  assert.equal(await readFile(path, 'utf8'), saved);
  assert.deepEqual(await store.read(), [first, second]);
  await writeFile(path, '{ malformed', 'utf8');
  await assert.rejects(store.read(), /账号配置.*有问题/);
  assert.equal(await readFile(path, 'utf8'), '{ malformed');
});

test('previous account files keep resolving old selectors and promote a saved remark to the account name', async t => {
  const { path, store } = await localStore(t);
  const { name: oldName, ...legacy } = first;
  await mkdir(dirname(path));
  await writeFile(path, JSON.stringify([{ ...legacy, remark: oldName }]));
  const accounts = await store.read();
  const account = findAccount(accounts, first.name);
  assert.equal(findAccount(accounts, first.alias), account);
  assert.equal(account.apiToken, first.apiToken);
  assert.ok(!JSON.parse(await readFile(path, 'utf8'))[0].name);
});

test('status returns zero, pagination and confirmed links independently of failed account metrics', async () => {
  const client = await createCloudflare({ transport: async (path, account, body) => {
    if (account === second) {
      assert.equal(account.apiToken, second.apiToken);
      throw new Error('没有读取权限');
    }
    assert.equal(account.apiToken, first.apiToken);
    if (path === '/graphql') {
      assert.equal(body.variables.accountTag, first.accountId);
      const dataset = /\b(\w+Adaptive(?:Groups)?)\(limit/.exec(body.query)[1];
      if (dataset === 'workersInvocationsAdaptiveGroups') {
        assert.equal(body.variables.start, '2026-11-19T00:00:00Z');
        return { errors: [{ message: 'unknown field "workersInvocationsAdaptiveGroups"' }] };
      }
      const groups = {
        workersInvocationsAdaptive: [],
        pagesFunctionsInvocationsAdaptiveGroups: [{ sum: { requests: 5 } }],
        d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 12, rowsWritten: 2 } }],
        kvOperationsAdaptiveGroups: [{ sum: { requests: 7 }, dimensions: { actionType: 'read' } }],
        aiInferenceAdaptiveGroups: [],
        r2OperationsAdaptiveGroups: [],
        r2StorageAdaptiveGroups: [],
      };
      return { data: { viewer: { accounts: [{ [dataset]: groups[dataset] }] } } };
    }
    assert.ok(path.startsWith(`/accounts/${first.accountId}/`));
    if (path.endsWith('/workers/scripts')) return { result: [{ id: 'edge' }, { id: 'closed' }] };
    if (path.endsWith('/workers/subdomain')) return { result: { subdomain: 'sample' } };
    if (path.endsWith('/workers/domains')) return { result: [{ service: 'edge', hostname: 'edge.example.com' }] };
    if (path.endsWith('/workers/scripts/edge/subdomain')) return { result: { enabled: true } };
    if (path.endsWith('/workers/scripts/closed/subdomain')) return { result: { enabled: false } };
    assert.ok(path.includes('/pages/projects?'));
    const params = new URL(path, 'https://example.com').searchParams;
    assert.equal(params.get('per_page'), '10');
    const page = params.get('page');
    return { result: [{ name: `page-${page}`, subdomain: `page-${page}.pages.dev`, canonical_deployment: {} }], result_info: { total_pages: 2 } };
  } });
  const report = await client.status({ read: async () => [first, second] }, new Date('2026-11-19T05:17:42Z'));
  assert.equal(report.window.start, '2026-11-19T00:00:00.000Z');
  assert.deepEqual(report.ranking, [{ alias: first.alias, name: first.name, requests: 0 }]);
  assert.equal(report.accounts[0].usage.workers.scope, 'workers-invocations; pages-functions-separate');
  assert.deepEqual(report.accounts[0].workers[0].urls, ['https://edge.example.com/', 'https://edge.sample.workers.dev/']);
  assert.deepEqual(report.accounts[0].workers[1].urls, []);
  assert.deepEqual(report.accounts[0].pages.map(project => project.name), ['page-1', 'page-2']);
  assert.equal(report.accounts[0].usage.d1RowsRead, 12);
  assert.equal(report.accounts[0].usage.kvReads, 7);
  assert.equal(report.accounts[0].usage.quotas.requests.used, 5);
  assert.equal(report.accounts[0].usage.quotas.requests.percent, 0.005);
  assert.equal(report.accounts[0].usage.quotas.workersAi.neurons.used, 0);
  assert.equal(report.accounts[0].usage.quotas.r2.storagePeakBytes, null);
  assert.match(report.accounts[0].errors.find(error => error.section === 'r2Storage').message, /没有 R2 存储样本/);
  assert.equal(report.accounts[1].usage.workers.requests, null);
  assert.equal(report.accounts[1].usage.quotas.workersAi.neurons.used, null);
  assert.ok(report.accounts[1].errors.some(error => error.section === 'workersAi' && error.message === '没有读取权限'));
  assert.ok(!JSON.stringify(report).includes('private-token'));
  assert.equal(failedStatus(report), false);
  assert.equal(failedStatus({ ...report, accounts: [report.accounts[1]] }), true);
});

test('rankings use the verified Workers-only scope when Cloudflare reports different scopes', async () => {
  const client = await createCloudflare({ transport: async (path, account, body) => {
    if (path !== '/graphql') return { result: [] };
    const dataset = /\b(\w+Adaptive(?:Groups)?)\(limit/.exec(body.query)[1];
    if (account === first && dataset === 'workersInvocationsAdaptiveGroups') {
      return { errors: [{ message: 'unknown field "workersInvocationsAdaptiveGroups"' }] };
    }
    const groups = dataset.startsWith('workersInvocations') ? [{ sum: { requests: account === first ? 10 : 3 } }] : [];
    return { data: { viewer: { accounts: [{ [dataset]: groups }] } } };
  } });
  const report = await client.status({ read: async () => [first, second] });
  assert.equal(report.accounts[1].usage.workers.requests, 3);
  assert.equal(report.accounts[0].usage.quotas.requests.used, 10);
  assert.equal(report.accounts[1].usage.quotas.requests.pagesFunctions, 0);
  assert.equal(report.accounts[1].usage.quotas.requests.used, null);
  assert.deepEqual(report.ranking, [{ alias: first.alias, name: first.name, requests: 10 }]);
});

test('quota report keeps daily and monthly windows separate and includes only Standard R2 usage', async () => {
  const requests = [];
  const graphql = {
    workersInvocationsAdaptiveGroups: { errors: [{ message: 'unknown field "workersInvocationsAdaptiveGroups"' }] },
    workersInvocationsAdaptive: [],
    pagesFunctionsInvocationsAdaptiveGroups: { errors: [{ message: 'not authorized for that account' }] },
    d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 11, rowsWritten: null } }],
    kvOperationsAdaptiveGroups: [
      { dimensions: { actionType: 'delete' }, sum: { requests: 2 } },
      { dimensions: { actionType: 'list' }, sum: { requests: 1 } },
      { dimensions: { actionType: 'write' }, sum: { requests: 9 } },
    ],
    aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 2.5 } }],
    r2OperationsAdaptiveGroups: [
      { dimensions: { actionType: 'PutObject', storageClass: 'Standard' }, sum: { requests: 13 } },
      { dimensions: { actionType: 'GetObject', storageClass: 'Standard' }, sum: { requests: 23 } },
      { dimensions: { actionType: 'GetObject', storageClass: 'InfrequentAccess' }, sum: { requests: 400 } },
      { dimensions: { actionType: 'DeleteObject', storageClass: 'Standard' }, sum: { requests: 700 } },
      { dimensions: { actionType: 'NewOperation', storageClass: 'Standard' }, sum: { requests: 5 } },
    ],
    r2StorageAdaptiveGroups: [
      { dimensions: { bucketName: 'one', storageClass: 'Standard' }, max: { payloadSize: 1000, metadataSize: 20 } },
      { dimensions: { bucketName: 'two', storageClass: 'Standard' }, max: { payloadSize: 300, metadataSize: 10 } },
      { dimensions: { bucketName: 'two', storageClass: 'InfrequentAccess' }, max: { payloadSize: 800, metadataSize: 40 } },
    ],
  };
  const client = await createCloudflare({ transport: async (path, account, body) => {
    if (path !== '/graphql') return { result: [] };
    const dataset = /\b(\w+Adaptive(?:Groups)?)\(limit/.exec(body.query)[1];
    requests.push({ dataset, ...body.variables });
    const groups = graphql[dataset];
    if (groups?.errors) return groups;
    return { data: { viewer: { accounts: [{ [dataset]: groups }] } } };
  } });
  const store = { read: async () => [first] };
  const before = await client.status(store, new Date('2026-11-30T23:59:59Z'));
  const after = await client.status(store, new Date('2026-12-01T00:00:01Z'));
  const { quotas } = after.accounts[0].usage;
  assert.deepEqual([before.window.start, after.window.start], ['2026-11-30T00:00:00.000Z', '2026-12-01T00:00:00.000Z']);
  assert.deepEqual(requests.filter(query => query.dataset === 'r2OperationsAdaptiveGroups').map(query => query.start),
    ['2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z']);
  assert.deepEqual(requests.filter(query => query.dataset === 'r2StorageAdaptiveGroups').map(query => query.start),
    ['2026-11-30T00:00:00Z', '2026-12-01T00:00:00Z']);
  assert.deepEqual(requests.filter(query => query.dataset === 'd1AnalyticsAdaptiveGroups').map(query => query.start),
    ['2026-11-30', '2026-12-01']);
  assert.equal(quotas.requests.used, null);
  assert.equal(quotas.requests.workers, 0);
  assert.equal(quotas.requests.pagesFunctions, null);
  assert.equal(quotas.d1.rowsRead.used, 11);
  assert.equal(quotas.d1.rowsWritten.used, null);
  assert.deepEqual(Object.values(quotas.kv).map(quota => quota.used), [0, 9, 2, 1]);
  assert.equal(quotas.workersAi.neurons.used, 2.5);
  assert.equal(quotas.r2.classA.used, 13);
  assert.equal(quotas.r2.classB.used, 23);
  assert.equal(quotas.r2.unclassifiedOperations, 5);
  assert.equal(quotas.r2.storagePeakBytes, 1330);
  assert.equal(quotas.r2.storageFreeLimitGbMonths, 10);
  assert.match(after.accounts[0].errors.find(error => error.section === 'pagesFunctions').message, /统计读取权限/);
  assert.equal(failedStatus(after), false);
});

test('successive refreshes fetch newer usage while sharing confirmed Worker links', async () => {
  let linkChecks = 0;
  let unsupportedQueries = 0;
  let workerReads = 0;
  const client = await createCloudflare({ transport: async (path, account, body) => {
    if (path === '/graphql') {
      const dataset = /\b(\w+Adaptive(?:Groups)?)\(limit/.exec(body.query)[1];
      if (dataset === 'workersInvocationsAdaptiveGroups') {
        unsupportedQueries += 1;
        return { errors: [{ message: 'unknown field "workersInvocationsAdaptiveGroups"' }] };
      }
      const groups = dataset === 'workersInvocationsAdaptive' ? [{ sum: { requests: ++workerReads } }] : [];
      return { data: { viewer: { accounts: [{ [dataset]: groups }] } } };
    }
    if (path.endsWith('/workers/scripts')) return { result: [{ id: 'edge' }] };
    if (path.endsWith('/workers/scripts/edge/subdomain')) {
      linkChecks += 1;
      return { result: { enabled: true } };
    }
    if (path.endsWith('/workers/subdomain')) return { result: { subdomain: 'sample' } };
    return { result: [] };
  } });
  const store = { read: async () => [first] };
  const before = (await client.status(store)).accounts[0];
  const after = (await client.status(store)).accounts[0];
  assert.equal(before.usage.workers.requests, 1);
  assert.equal(after.usage.workers.requests, 2);
  assert.deepEqual(after.workers, [{ name: 'edge', urls: ['https://edge.sample.workers.dev/'] }]);
  assert.equal(linkChecks, 1);
  assert.equal(unsupportedQueries, 1);
});

test('dashboard writes require the local session and verified credentials', async t => {
  const { store } = await localStore(t);
  const { url, server } = await startDashboard({
    store, port: 0, open: false, status: async () => ({ accounts: [] }),
    validate: async account => {
      if (account.apiToken !== first.apiToken) throw Object.assign(new Error('Token 无效'), { status: 401 });
    },
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { session } = await (await fetch(`${url}/api/accounts`)).json();
  const headers = { Origin: url, 'Content-Type': 'application/json', 'X-CF-Hub-Session': session };
  const patch = (method, name, input, clearHeaders = false) => fetch(`${url}/api/accounts${name ? `/${encodeURIComponent(name)}` : ''}`, {
    method, headers: clearHeaders ? { ...headers, Origin: 'https://example.com' } : headers,
    body: input && JSON.stringify(input),
  });
  assert.equal((await patch('POST', '', first, true)).status, 403);
  assert.equal((await patch('POST', '', second)).status, 401);
  assert.deepEqual(await store.read(), []);
  assert.equal((await patch('POST', '', first)).status, 201);
  const newName = '团队 / 已编辑';
  assert.equal((await patch('PATCH', first.name, { ...first, apiToken: '', name: newName })).status, 200);
  const response = await (await fetch(`${url}/api/accounts`)).text();
  assert.ok(response.includes('已编辑'));
  assert.ok(!response.includes(first.apiToken));
  assert.equal((await store.read())[0].apiToken, first.apiToken);
  assert.equal((await patch('DELETE', newName)).status, 200);
  assert.deepEqual(await store.read(), []);
});
