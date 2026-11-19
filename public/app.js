import { rankWorkers } from './quotas.js';

const select = selector => document.querySelector(selector);
const grid = select('#accounts');
const feedback = select('#feedback');
const refresh = select('#refresh');
const editor = select('#editor');
const form = select('#account-form');
const confirmDelete = select('#confirm-delete');
const fields = form.elements;
let session;
let editing;
const cards = new Map();
let demo = false;
let refreshSequence = 0;
const refreshEvery = 60_000;
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });

if (document.body.hasAttribute('data-browser-session')) {
  new EventSource('/api/ui-session');
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function message(node, text, error = false) {
  node.hidden = !text;
  node.textContent = text;
  node.classList.toggle('error', error);
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '本地请求失败。');
  return body;
}

async function mutate(method, name, body) {
  if (!session) ({ session } = await api('/api/accounts'));
  return api(`/api/accounts${name ? `/${encodeURIComponent(name)}` : ''}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-CF-Hub-Session': session },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function deployCommand(name) {
  if (/^[a-zA-Z0-9][a-zA-Z0-9_.@+-]*$/.test(name)) return `cf-hub run ${name} -- deploy`;
  const quoted = navigator.platform.startsWith('Win')
    ? name.replace(/['‘’]/g, character => character.repeat(2))
    : name.replaceAll("'", "'\\''");
  return `cf-hub run '${quoted}' -- deploy`;
}

function projectList(title, projects, error) {
  const section = element('section', undefined, 'project');
  section.append(element('h3', title));
  if (!projects?.length) {
    section.append(element('p', projects === null ? error || '项目列表未知' : '暂无项目', 'hint'));
    return section;
  }
  const list = element('ul');
  for (const project of projects) {
    const row = element('li');
    const urls = (project.urls ?? []).filter(url => /^https:\/\//i.test(url));
    if (!urls.length) row.append(element('span', project.name), element('span', project.linkNote || '暂无已确认地址', 'no-link'));
    for (const [index, url] of urls.entries()) {
      const link = element('a', index === 0 ? project.name : new URL(url).hostname, index ? 'extra-link' : undefined);
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      row.append(link);
    }
    list.append(row);
  }
  section.append(list);
  return section;
}

function openEditor(account) {
  editing = account?.name;
  form.reset();
  select('#editor-title').textContent = account ? `编辑 ${account.name}` : '添加账号';
  fields.name.value = account?.name ?? '';
  fields.accountId.value = account?.accountId ?? '';
  fields.apiToken.required = !account;
  fields.apiToken.placeholder = account ? '已设置，留空保留' : '输入用于此账号的 Token';
  select('#delete-account').hidden = !account;
  message(select('#form-error'), '');
  editor.showModal();
}

function format(number) {
  return number === null ? '未知' : numberFormat.format(number);
}

function quotaValue({ used, freeLimit }, unit = '') {
  return `${format(used)} / ${format(freeLimit)}${unit ? ` ${unit}` : ''}`;
}

function usageGroup(title, rows) {
  const section = element('section', undefined, 'quota-group');
  const list = element('dl');
  for (const [label, value, error] of rows) {
    const row = element('div', undefined, 'quota-row');
    const detail = element('dd', value);
    if (error) detail.append(element('small', error));
    row.append(element('dt', label), detail);
    list.append(row);
  }
  section.append(element('h3', title), list);
  return section;
}

function moreUsage({ d1, kv, workersAi, r2 }, errors) {
  const details = element('details', undefined, 'more-usage');
  const daily = element('div', undefined, 'quota-grid');
  daily.append(
    usageGroup('D1', [
      ['读取', quotaValue(d1.rowsRead, '行'), errors.d1RowsRead],
      ['写入', quotaValue(d1.rowsWritten, '行'), errors.d1RowsWritten],
    ]),
    usageGroup('Workers KV', [
      ['读取', quotaValue(kv.reads), errors.kvReads],
      ['写入', quotaValue(kv.writes), errors.kvWrites],
      ['删除', quotaValue(kv.deletes), errors.kvDeletes],
      ['列表', quotaValue(kv.lists), errors.kvLists],
    ]),
    usageGroup('Workers AI', [['用量', quotaValue(workersAi.neurons, 'Neurons'), errors.workersAi]]),
  );
  const storageGb = r2.storagePeakBytes === null ? null : r2.storagePeakBytes / 1e9;
  const storage = storageGb === null ? '未知' : `${storageGb > 0 && storageGb < 0.001 ? '< 0.001' : format(storageGb)} GB`;
  const r2Section = usageGroup('R2 Standard', [
    ['A 类操作', quotaValue(r2.classA), errors.r2Operations],
    ['B 类操作', quotaValue(r2.classB)],
    ['今日各桶峰值合计', storage, errors.r2Storage],
  ]);
  const r2Window = element('p', `${r2.window.start.slice(0, 7)} UTC 日历月操作估算，账单按订阅周期计算。`, 'hint');
  r2Section.querySelector('h3').after(r2Window);
  if (r2.unclassifiedOperations > 0) {
    r2Section.append(element('p', `另有 ${format(r2.unclassifiedOperations)} 次操作待归类。`, 'hint'));
  }
  const r2Pricing = element('a', 'R2 免费额度');
  r2Pricing.href = 'https://developers.cloudflare.com/r2/pricing/#free-tier';
  r2Pricing.target = '_blank';
  r2Pricing.rel = 'noopener noreferrer';
  const storageNote = element('p', `存储免费基准 ${r2.storageFreeLimitGbMonths} GB-month / 月 · `, 'hint');
  storageNote.append(r2Pricing);
  r2Section.append(storageNote);
  details.append(
    element('summary', '更多用量'),
    daily,
    element('p', 'KV 显示统计次数，批量操作按键计费。', 'hint'),
    r2Section,
  );
  return details;
}

function renderUsage(container, account) {
  const expanded = container.querySelector('.more-usage')?.open;
  const { requests } = account.usage.quotas;
  const usage = element('div', undefined, 'usage');
  const usageTop = element('div', undefined, 'usage-top');
  const errors = Object.fromEntries(account.errors.map(({ section, message }) => [section, message]));
  const { percent } = requests;
  usageTop.append(element('span', '今日共享请求额度'), element('strong', quotaValue(requests)));
  const track = element('progress', undefined, `track ${percent === null ? 'unknown' : percent >= 90 ? 'high' : percent >= 70 ? 'warn' : ''}`);
  track.max = 100;
  track.value = Math.max(0, Math.min(100, percent ?? 0));
  track.setAttribute('aria-label', percent === null ? '合计未知' : `免费额度基准 ${format(percent)}%`);
  usage.append(usageTop, track);
  if (percent !== null) usage.append(element('p', `已统计 ${format(percent)}%`, 'hint'));
  const requestSources = usageGroup('请求来源', [
    ['Workers', format(requests.workers), errors.workersUsage],
    ['Pages Functions', format(requests.pagesFunctions), errors.pagesFunctions],
  ]);
  requestSources.classList.add('request-sources');
  usage.append(requestSources);
  if (percent === null && requests.workers !== null && requests.pagesFunctions !== null) {
    usage.append(element('p', '目前无法确认两项统计是否重叠。', 'hint'));
  }
  usage.append(element('p', 'Workflows 也可能占用这份额度。', 'hint'));
  const details = moreUsage(account.usage.quotas, errors);
  details.dataset.account = account.name;
  details.open = Boolean(expanded);

  const projects = element('div', undefined, 'projects');
  projects.append(projectList('Workers', account.workers, errors.workers), projectList('Pages', account.pages, errors.pages));
  container.replaceChildren(usage, details, projects);
}

function createCard(account) {
  const wrapper = element('article', undefined, 'card');
  const heading = element('div', undefined, 'card-top');
  const edit = element('button', '编辑');
  edit.setAttribute('aria-label', `编辑 ${account.name}`);
  edit.addEventListener('click', () => openEditor(account));
  heading.append(element('h2', account.name), edit);
  const notice = element('p', '', 'hint card-status');
  notice.setAttribute('role', 'status');
  const content = element('div');
  const copy = element('button', '复制部署命令', 'copy');
  const command = deployCommand(account.name);
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(command);
      copy.textContent = '已复制';
      setTimeout(() => { copy.textContent = '复制部署命令'; }, 1600);
    } catch {
      message(feedback, `复制失败，可手动复制：${command}`, true);
    }
  });
  wrapper.append(heading, notice, content, copy);
  return { wrapper, notice, content, accountId: account.accountId, name: account.name };
}

function sortCards() {
  const rows = [...cards.values()];
  const reports = rows.filter(row => row.latest).map(row => row.latest);
  const scores = select('#sort').value === 'workers'
    ? new Map(rankWorkers(reports).map(entry => [entry.name, entry.requests]))
    : new Map(reports.map(account => [account.name, account.usage.quotas.requests.used]));
  rows.sort((a, b) => (scores.get(a.name) ?? Infinity) - (scores.get(b.name) ?? Infinity) || a.name.localeCompare(b.name));
  rows.forEach(({ wrapper }, index) => {
    if (grid.children[index] !== wrapper) grid.insertBefore(wrapper, grid.children[index] ?? null);
  });
}

async function load({ background = false } = {}) {
  const sequence = ++refreshSequence;
  refresh.disabled = true;
  if (!background) message(feedback, '正在读取账号…');
  try {
    const directory = await api('/api/accounts');
    if (sequence !== refreshSequence) return;
    session = directory.session;
    demo = directory.demo;
    select('#demo').hidden = !demo;
    const { accounts } = directory;
    const ids = new Map(accounts.map(account => [account.name, account.accountId]));
    for (const [name, row] of cards) {
      if (ids.get(name) !== row.accountId) {
        row.wrapper.remove();
        cards.delete(name);
      }
    }
    grid.querySelector('.empty')?.remove();
    if (!accounts.length) grid.append(element('p', '还没有账号，点击「添加账号」开始。', 'card empty'));
    select('#summary').textContent = `${accounts.length} 个账号 · 每日用量从北京时间 08:00 起算${accounts.length && !demo ? ' · 每分钟自动查询' : ''}`;
    message(feedback, '');
    await Promise.all(accounts.map(async account => {
      let row = cards.get(account.name);
      if (!row) {
        row = createCard(account);
        cards.set(account.name, row);
        grid.append(row.wrapper);
      }
      const last = row.time ? ` · 上次查询 ${row.time}` : '';
      message(row.notice, '查询中…' + last);
      try {
        const result = await api(`/api/status/${encodeURIComponent(account.name)}?at=${encodeURIComponent(directory.queryTime)}`);
        if (sequence !== refreshSequence) return;
        if (result.account.accountId !== row.accountId || result.account.name !== row.name) throw new Error('账号已变更，请刷新列表。');
        renderUsage(row.content, result.account);
        row.latest = result.account;
        row.time = new Date(result.window.end).toLocaleString('zh-CN', { hour12: false });
        message(row.notice, `查询于 ${row.time}`);
      } catch (error) {
        if (sequence !== refreshSequence) return;
        row.latest = null;
        message(row.notice, error.message + last, true);
      }
    }));
    if (sequence === refreshSequence) sortCards();
  } catch (error) {
    if (sequence === refreshSequence) message(feedback, error.message, true);
  } finally {
    if (sequence === refreshSequence) refresh.disabled = false;
  }
}

select('#add').addEventListener('click', () => openEditor());
select('#close-editor').addEventListener('click', () => editor.close());
editor.addEventListener('close', () => { fields.apiToken.value = ''; });
refresh.addEventListener('click', () => load());
select('#sort').addEventListener('change', () => { if (!refresh.disabled) sortCards(); });
form.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  message(select('#form-error'), '');
  try {
    await mutate(editing ? 'PATCH' : 'POST', editing, Object.fromEntries(new FormData(form)));
    editor.close();
    await load();
  } catch (error) {
    message(select('#form-error'), error.message, true);
  } finally {
    submit.disabled = false;
  }
});
select('#delete-account').addEventListener('click', () => {
  select('#delete-description').textContent = `从 cf-hub 移除 ${editing}？Cloudflare 上的项目会保留。`;
  confirmDelete.returnValue = 'cancel';
  confirmDelete.showModal();
});
confirmDelete.addEventListener('close', async () => {
  if (confirmDelete.returnValue !== 'remove') return;
  try {
    await mutate('DELETE', editing);
    editor.close();
    await load();
  } catch (error) {
    message(select('#form-error'), error.message, true);
  }
});
void load();
setInterval(() => {
  if (document.visibilityState === 'visible' && !editor.open && !refresh.disabled && !demo) {
    void load({ background: true });
  }
}, refreshEvery);
