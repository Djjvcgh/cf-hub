export const workersFreeLimit = 100_000;
export const workersOnlyScope = 'workers-invocations; pages-functions-separate';
export const unverifiedScope = 'workers-invocations; pages-functions-unverified';

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
