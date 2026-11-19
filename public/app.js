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
let currentReport;
let refreshSequence = 0;
const refreshEvery = 60_000;

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

function card(account) {
  const wrapper = element('article', undefined, 'card');
  const heading = element('div', undefined, 'card-top');
  const names = element('div');
  names.append(element('h2', account.name));
  const edit = element('button', '编辑');
  edit.setAttribute('aria-label', `编辑 ${account.name}`);
  edit.addEventListener('click', () => openEditor(account));
  heading.append(names, edit);

  const { requests, freeLimit, percent, scope } = account.usage.workers;
  const usage = element('div', undefined, 'usage');
  const usageTop = element('div', undefined, 'usage-top');
  const errors = Object.fromEntries(account.errors.map(({ section, message }) => [section, message]));
  const format = number => number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  usageTop.append(element('span', '今日请求'), element('strong', requests === null ? '未知' : `${format(requests)} / ${format(freeLimit)}`));
  const track = element('progress', undefined, `track ${percent === null ? 'unknown' : percent >= 90 ? 'high' : percent >= 70 ? 'warn' : ''}`);
  track.max = 100;
  track.value = Math.max(0, Math.min(100, percent ?? 0));
  track.setAttribute('aria-label', requests === null ? '用量未知' : `免费额度基准 ${format(percent)}%`);
  const coverage = scope === 'workers-invocations; pages-functions-separate'
    ? '估算 · 仅 Workers，另有 Pages Functions 用量'
    : '估算 · Pages Functions 覆盖未确认';
  const detail = requests === null ? errors.workersUsage || '暂无用量数据' : `${format(percent)}% · ${scope === 'demo' ? '演示用量' : coverage}`;
  usage.append(usageTop, track, element('p', detail, 'hint'));
  if (scope !== 'demo') {
    const d1 = account.usage.d1RowsRead == null ? '未知' : format(account.usage.d1RowsRead);
    const kv = account.usage.kvReads == null ? '未知' : format(account.usage.kvReads);
    const extra = element('p', undefined, 'hint');
    const d1Label = element('span', `D1 读取 ${d1}${d1 === '未知' ? '' : ' 行'}`);
    const kvLabel = element('span', `KV 读取 ${kv}${kv === '未知' ? '' : ' 次'}`);
    if (errors.d1RowsRead) d1Label.title = errors.d1RowsRead;
    if (errors.kvReads) kvLabel.title = errors.kvReads;
    extra.append(d1Label, ' · ', kvLabel);
    usage.append(extra);
  }

  const projects = element('div', undefined, 'projects');
  projects.append(projectList('Workers', account.workers, errors.workers), projectList('Pages', account.pages, errors.pages));
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
  wrapper.append(heading, usage, projects, copy);
  return wrapper;
}

function render(report) {
  currentReport = report;
  select('#demo').hidden = !report.demo;
  const ranking = new Map((report.ranking ?? []).map((entry, index) => [entry.alias, index]));
  const accounts = [...report.accounts].sort((a, b) => (ranking.get(a.alias) ?? Infinity) - (ranking.get(b.alias) ?? Infinity));
  select('#summary').textContent = `${accounts.length} 个账号 · UTC 统计${accounts.length && !report.demo ? ' · 每分钟自动查询' : ''}`;
  select('#updated').textContent = report.window?.end ? `查询于 ${new Date(report.window.end).toLocaleTimeString('zh-CN', { hour12: false })}` : '';
  grid.replaceChildren(...accounts.map(card));
  if (accounts.length === 0 && !report.error) grid.append(element('p', '还没有账号，点击「添加账号」开始。', 'card empty'));
  message(feedback, report.error || '', Boolean(report.error));
}

async function load({ background = false } = {}) {
  const sequence = ++refreshSequence;
  refresh.disabled = true;
  if (!background || !currentReport) message(feedback, '正在查询账号…');
  try {
    const report = await api('/api/status');
    if (sequence === refreshSequence) render(report);
  } catch (error) {
    if (sequence === refreshSequence) {
      message(feedback, error.message, true);
      if (!currentReport) grid.replaceChildren();
    }
  } finally {
    if (sequence === refreshSequence) refresh.disabled = false;
  }
}

select('#add').addEventListener('click', () => openEditor());
select('#close-editor').addEventListener('click', () => editor.close());
editor.addEventListener('close', () => { fields.apiToken.value = ''; });
refresh.addEventListener('click', () => load());
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
  if (document.visibilityState === 'visible' && !editor.open && !refresh.disabled && !currentReport?.demo) {
    void load({ background: true });
  }
}, refreshEvery);
