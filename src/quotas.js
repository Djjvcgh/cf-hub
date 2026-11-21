export const workersFreeLimit = 100_000;
export const workersOnlyScope = 'workers-invocations; pages-functions-separate';
export const unverifiedScope = 'workers-invocations; pages-functions-unverified';

export function rankWorkers(accounts) {
  const known = accounts.filter(account => account.usage.workers.requests !== null);
  const scope = known.some(account => account.usage.workers.scope === workersOnlyScope) ? workersOnlyScope : unverifiedScope;
  return known.filter(account => account.usage.workers.scope === scope)
    .map(({ alias, name, usage }) => ({ alias, name, requests: usage.workers.requests }))
    .sort((a, b) => a.requests - b.requests || a.name.localeCompare(b.name));
}

export function quotaWindows(now = new Date()) {
  const end = now.toISOString();
  return {
    day: { start: `${end.slice(0, 10)}T00:00:00.000Z`, end },
    month: { start: `${end.slice(0, 7)}-01T00:00:00.000Z`, end },
  };
}

export function quotaReport(month, { workers, pagesFunctions, d1, kv, neurons, r2Operations, r2Storage }) {
  const quota = (used, freeLimit) => ({ used: used ?? null, freeLimit });
  const combined = workers?.scope === workersOnlyScope && pagesFunctions != null
    ? workers.requests + pagesFunctions : null;
  return {
    requests: {
      ...quota(combined, workersFreeLimit),
      workers: workers?.requests ?? null,
      pagesFunctions: pagesFunctions ?? null,
      percent: combined === null ? null : combined / (workersFreeLimit / 100),
    },
    d1: {
      rowsRead: quota(d1?.rowsRead, 5_000_000),
      rowsWritten: quota(d1?.rowsWritten, 100_000),
    },
    kv: {
      reads: quota(kv?.read, 100_000),
      writes: quota(kv?.write, 1_000),
      deletes: quota(kv?.delete, 1_000),
      lists: quota(kv?.list, 1_000),
    },
    workersAi: { neurons: quota(neurons, 10_000) },
    r2: {
      window: month,
      classA: quota(r2Operations?.classA, 1_000_000),
      classB: quota(r2Operations?.classB, 10_000_000),
      unclassifiedOperations: r2Operations?.unclassified ?? null,
      storagePeakBytes: r2Storage ?? null,
      storageFreeLimitGbMonths: 10,
    },
  };
}

function metricEntry(label, used, limit, error, unit = '') {
  const percent = used === null ? null : used / limit * 100;
  const noSample = error?.code === 'no_sample';
  return {
    label,
    used,
    limit,
    unit,
    error: error?.message,
    noSample,
    missing: percent === null && !noSample,
    percent,
  };
}

/**
 * Group an account report into five quota sections with per-metric completion flags.
 */
export function usageGroups(report) {
  const { requests, d1, kv, workersAi, r2 } = report.usage.quotas;
  const errorMap = Object.fromEntries((report.errors ?? []).map(({ section, message, code }) => [section, { message, code }]));
  const errors = Object.fromEntries(Object.entries(errorMap).map(([section, info]) => [section, info.message]));
  const overlap = requests.percent === null && requests.workers !== null && requests.pagesFunctions !== null
    ? { message: '目前无法确认两项统计是否重叠。' } : undefined;
  const storageGb = r2.storagePeakBytes === null ? null : r2.storagePeakBytes / 1e9;
  const requestError = errorMap.workersUsage || errorMap.pagesFunctions || overlap;
  return [
    { key: 'requests', title: '共享请求', items: [
      metricEntry('Workers + Pages Functions', requests.used, requests.freeLimit, requestError, '次'),
    ], requests, errors },
    { key: 'd1', title: 'D1', items: [
      metricEntry('读取', d1.rowsRead.used, d1.rowsRead.freeLimit, errorMap.d1RowsRead, '行'),
      metricEntry('写入', d1.rowsWritten.used, d1.rowsWritten.freeLimit, errorMap.d1RowsWritten, '行'),
    ] },
    { key: 'kv', title: 'Workers KV', short: 'KV', items: [
      metricEntry('读取', kv.reads.used, kv.reads.freeLimit, errorMap.kvReads),
      metricEntry('写入', kv.writes.used, kv.writes.freeLimit, errorMap.kvWrites),
      metricEntry('删除', kv.deletes.used, kv.deletes.freeLimit, errorMap.kvDeletes),
      metricEntry('列表', kv.lists.used, kv.lists.freeLimit, errorMap.kvLists),
    ] },
    { key: 'ai', title: 'Workers AI', items: [
      metricEntry('Neurons', workersAi.neurons.used, workersAi.neurons.freeLimit, errorMap.workersAi),
    ] },
    { key: 'r2', title: 'R2 Standard', short: 'R2', items: [
      metricEntry('A 类操作', r2.classA.used, r2.classA.freeLimit, errorMap.r2Operations),
      metricEntry('B 类操作', r2.classB.used, r2.classB.freeLimit, errorMap.r2Operations),
      metricEntry('存储峰值', storageGb, r2.storageFreeLimitGbMonths, errorMap.r2Storage, 'GB'),
    ], r2 },
  ];
}

function worstOf(items) {
  return items.filter(entry => entry.percent !== null).reduce((top, entry) => (!top || entry.percent > top.percent ? entry : top), null);
}

/**
 * Summarize grouped quotas, peak usage item, and whether all required metrics succeeded.
 */
export function summarizeUsage(report) {
  const groups = usageGroups(report);
  let worst = null;
  for (const group of groups) {
    group.worst = worstOf(group.items);
    group.partial = group.items.some(entry => entry.missing);
    if (group.worst && (!worst || group.worst.percent > worst.item.percent)) worst = { group, item: group.worst };
  }
  return { groups, worst, complete: !groups.some(group => group.partial) };
}

/**
 * Compute the sort score for a dashboard account row under the chosen sort mode.
 */
export function accountSortScore(report, mode, workerRanks) {
  if (!report) return null;
  if (mode === 'workers') return workerRanks.get(report.name) ?? null;
  if (mode === 'shared') return report.usage.quotas.requests.used;
  const { worst, complete } = summarizeUsage(report);
  const percent = worst?.item.percent ?? null;
  if (percent === null) return null;
  if (mode === 'tight') return -percent;
  // 有缺失项的账号排在完整账号之后，避免缺权限显得余量多
  return complete ? percent : 1e6 + percent;
}

/**
 * Pick the complete account with the lowest peak quota percentage.
 */
export function pickRoomiestAccount(reports) {
  let roomiest = null;
  for (const report of reports) {
    if (!report) continue;
    const { worst, complete } = summarizeUsage(report);
    if (!complete || !worst) continue;
    const percent = worst.item.percent;
    if (!roomiest || percent < roomiest.percent || (percent === roomiest.percent && report.name.localeCompare(roomiest.name) < 0)) {
      roomiest = { name: report.name, percent };
    }
  }
  return roomiest;
}
