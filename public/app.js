import { accountSortScore, pickRoomiestAccount, rankWorkers, summarizeUsage } from './quotas.js';

const select = selector => document.querySelector(selector);
const tbody = select('#accounts');
const feedback = select('#feedback');
const refresh = select('#refresh');
const editor = select('#editor');
const form = select('#account-form');
const confirmDelete = select('#confirm-delete');
const commandDialog = select('#command-dialog');
const commandForm = select('#command-form');
const directoryField = select('#build-directory');
const preview = select('#command-preview');
const drawer = select('#detail');
let commandAccount;
const fields = form.elements;
let session;
let editing;
let selected;
const rows = new Map();
let demo = false;
let refreshSequence = 0;
const refreshEvery = 60_000;
const warnAt = 60;
const highAt = 80;
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 });
const svg = 'http://www.w3.org/2000/svg';

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

function quoteArgument(value) {
  if (/^[a-zA-Z0-9][a-zA-Z0-9_.@+-]*$/.test(value) || /^\.\/[a-zA-Z0-9_./-]+$/.test(value)) return value;
  const quoted = navigator.platform.startsWith('Win')
    ? value.replace(/['‘’‚‛]/g, character => character.repeat(2))
    : value.replaceAll("'", "'\\''");
  return `'${quoted}'`;
}

function updateCommand() {
  const pages = directoryField.required;
  const directory = directoryField.value;
  const invalid = !directory.trim() || /[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(directory);
  directoryField.setCustomValidity(pages && invalid ? '请输入单行构建目录，例如 ./dist。' : '');
  const path = directory.startsWith('-') ? './' + directory : directory;
  const args = pages ? 'pages deploy ' + quoteArgument(path) : 'deploy';
  preview.textContent = pages && invalid ? '' : `cf-hub run ${quoteArgument(commandAccount)} -- ${args}`;
  message(select('#copy-feedback'), '');
}

function openCommand(account, pages) {
  commandAccount = account.name;
  commandForm.reset();
  select('#command-title').textContent = pages ? '复制 Pages 部署命令' : '复制 Workers 部署命令';
  select('#command-shell').textContent = navigator.platform.startsWith('Win') ? '在项目目录的 PowerShell 中使用' : '在项目目录的终端中使用';
  directoryField.required = pages;
  select('#directory-label').hidden = !pages;
  updateCommand();
  commandDialog.showModal();
  if (pages) directoryField.focus();
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

function level(percent) {
  if (percent === null || percent === undefined) return 'unknown';
  return percent >= highAt ? 'high' : percent >= warnAt ? 'warn' : 'ok';
}

function percentText(percent) {
  if (percent === null || percent === undefined) return '未知';
  if (percent > 0 && percent < 1) return '<1%';
  return `${Math.floor(percent)}%`;
}

function pill(percent, title) {
  const node = element('span', percentText(percent), `pill ${level(percent)}`);
  if (title) node.title = title;
  return node;
}

function createRow(account) {
  const tr = element('tr');
  const nameCell = element('th');
  nameCell.scope = 'row';
  const open = element('button', undefined, 'row-name');
  const dot = element('i', undefined, 'dot unknown');
  const name = element('span', account.name, 'name');
  const status = element('span', '', 'row-status');
  status.setAttribute('role', 'status');
  open.append(dot, name, status);
  open.setAttribute('aria-label', `查看 ${account.name} 的详情`);
  open.addEventListener('click', event => { event.stopPropagation(); openDetail(account.name); });
  nameCell.append(open);
  const cells = ['requests', 'd1', 'kv', 'ai', 'r2', 'projects'].map(key => element('td', undefined, key === 'projects' ? 'project-col' : undefined));
  tr.append(nameCell, ...cells);
  tr.addEventListener('click', () => openDetail(account.name));
  return { tr, dot, status, cells, account, name: account.name, accountId: account.accountId };
}

function renderRow(row) {
  const report = row.shown;
  row.tr.classList.toggle('selected', selected === row.name);
  row.tr.classList.toggle('failed', !report && row.error !== undefined);
  if (!report) {
    row.dot.className = 'dot unknown';
    for (const cell of row.cells) cell.replaceChildren(element('span', row.error === undefined ? '…' : '—', 'placeholder'));
    return;
  }
  const { groups, worst } = summarizeUsage(report);
  row.dot.className = `dot ${level(row.latest ? worst?.item.percent : null)}`;
  groups.forEach((group, index) => {
    const cell = row.cells[index];
    const top = group.worst;
    const reasons = group.items.filter(entry => entry.error).map(entry => `${entry.label}：${entry.error}`).join('\n');
    const content = [pill(top?.percent ?? null, reasons || undefined)];
    if (top && group.items.length > 1) content.push(element('small', top.label + (group.partial ? ' · 部分未知' : '')));
    else if (!top && reasons) content.push(element('small', '查看原因'));
    cell.replaceChildren(...content);
  });
  const count = list => list === null ? '?' : list.length;
  row.cells[5].replaceChildren(element('span', `Workers ${count(report.workers)}`, 'projects-count'), element('span', `Pages ${count(report.pages)}`, 'projects-count'));
}

function setRowStatus(row, text, error = false) {
  row.status.textContent = text;
  row.status.classList.toggle('error', error);
  if (selected === row.name) message(select('#detail-status'), text, error);
}

function meter(percent) {
  const track = element('div', undefined, `track ${level(percent)}`);
  const fill = element('span');
  fill.style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`;
  track.append(fill);
  return track;
}

function ring(percent) {
  const radius = 34;
  const length = 2 * Math.PI * radius;
  const node = document.createElementNS(svg, 'svg');
  node.setAttribute('viewBox', '0 0 88 88');
  node.setAttribute('class', `ring ${level(percent)}`);
  node.setAttribute('aria-hidden', 'true');
  for (const name of ['base', 'value']) {
    const circle = document.createElementNS(svg, 'circle');
    circle.setAttribute('cx', '44');
    circle.setAttribute('cy', '44');
    circle.setAttribute('r', String(radius));
    circle.setAttribute('class', name);
    if (name === 'value') {
      circle.setAttribute('stroke-dasharray', `${length * Math.min(100, percent ?? 0) / 100} ${length}`);
      circle.setAttribute('transform', 'rotate(-90 44 44)');
    }
    node.append(circle);
  }
  const label = document.createElementNS(svg, 'text');
  label.setAttribute('x', '44');
  label.setAttribute('y', '50');
  label.setAttribute('text-anchor', 'middle');
  label.textContent = percentText(percent);
  node.append(label);
  return node;
}

function quotaLine(entry) {
  const line = element('div', undefined, 'quota-line');
  const head = element('div', undefined, 'quota-head');
  const value = entry.used === null ? '未知' : `${format(entry.used)} / ${format(entry.limit)}${entry.unit ? ` ${entry.unit}` : ''}`;
  head.append(element('span', entry.label), element('span', value, 'quota-value'), element('strong', entry.percent === null ? '' : percentText(entry.percent), `quota-percent ${level(entry.percent)}`));
  line.append(head, meter(entry.percent));
  if (entry.error) line.append(element('p', entry.error, entry.noSample ? 'hint' : 'hint error-hint'));
  return line;
}

function link(text, href) {
  const node = element('a', text);
  node.href = href;
  node.target = '_blank';
  node.rel = 'noopener noreferrer';
  return node;
}

function renderDetail() {
  const row = rows.get(selected);
  if (!row) return closeDetail();
  select('#detail-title').textContent = row.name;
  message(select('#detail-status'), row.status.textContent, row.status.classList.contains('error'));
  const body = select('#detail-body');
  const scroll = body.scrollTop;
  const parts = [];
  const report = row.shown;
  if (report) {
    const { groups, worst } = summarizeUsage(report);
    const hero = element('section', undefined, 'hero');
    const text = element('div');
    if (worst) {
      text.append(
        element('p', '最紧张的一项', 'hint'),
        element('strong', worst.group.items.length > 1 ? `${worst.group.title} · ${worst.item.label}` : worst.group.title),
        element('p', `${format(worst.item.used)} / ${format(worst.item.limit)}${worst.item.unit ? ` ${worst.item.unit}` : ''}`, 'hero-value'),
      );
    } else text.append(element('strong', '暂时没有可用的用量统计'));
    hero.append(ring(worst?.item.percent ?? null), text);
    parts.push(hero);
    for (const group of groups) {
      const section = element('section', undefined, 'detail-group');
      section.append(element('h3', group.title), ...group.items.map(quotaLine));
      if (group.key === 'requests') {
        const { requests, errors } = group;
        section.append(element('p', `来源：Workers ${format(requests.workers)}${errors.workersUsage ? '（未知）' : ''} · Pages Functions ${format(requests.pagesFunctions)}${errors.pagesFunctions ? '（未知）' : ''}`, 'hint'));
        section.append(element('p', 'Workflows 也可能占用这份额度。', 'hint'));
      }
      if (group.key === 'kv') section.append(element('p', 'KV 显示统计次数，批量操作按键计费。', 'hint'));
      if (group.key === 'r2') {
        const { r2 } = group;
        section.append(element('p', `${r2.window.start.slice(0, 7)} UTC 日历月操作估算，账单按订阅周期计算。`, 'hint'));
        if (r2.unclassifiedOperations > 0) section.append(element('p', `另有 ${format(r2.unclassifiedOperations)} 次操作待归类。`, 'hint'));
        const note = element('p', `存储按今日各桶峰值合计，对照每月 ${r2.storageFreeLimitGbMonths} GB-month 免费基准估算 · `, 'hint');
        note.append(link('R2 免费额度', 'https://developers.cloudflare.com/r2/pricing/#free-tier'));
        section.append(note);
      }
      parts.push(section);
    }
    const errors = Object.fromEntries(report.errors.map(({ section, message }) => [section, message]));
    const projects = element('section', undefined, 'projects');
    projects.append(projectList('Workers', report.workers, errors.workers), projectList('Pages', report.pages, errors.pages));
    parts.push(projects);
  } else {
    parts.push(element('p', row.error === undefined ? '正在查询这个账号…' : '这个账号这次没查到结果，可以稍后点「刷新」再试。', 'empty-detail'));
  }
  const commands = element('div', undefined, 'command-actions');
  for (const product of ['Workers', 'Pages']) {
    const button = element('button', `复制 ${product} 部署命令`, product === 'Workers' ? 'primary' : undefined);
    button.addEventListener('click', () => openCommand(row.account, product === 'Pages'));
    commands.append(button);
  }
  parts.push(commands);
  body.replaceChildren(...parts);
  body.scrollTop = scroll;
}

function openDetail(name) {
  const previous = selected;
  selected = name;
  for (const row of rows.values()) row.tr.classList.toggle('selected', row.name === name);
  renderDetail();
  if (previous !== name) select('#detail-body').scrollTop = 0;
  drawer.classList.add('open');
  drawer.inert = false;
  document.body.classList.add('drawer-open');
}

function closeDetail() {
  selected = undefined;
  drawer.classList.remove('open');
  drawer.inert = true;
  document.body.classList.remove('drawer-open');
  for (const row of rows.values()) row.tr.classList.remove('selected');
}

function score(row, mode, workerRanks) {
  return accountSortScore(row.latest, mode, workerRanks);
}

function sortRows() {
  const list = [...rows.values()];
  const mode = select('#sort').value;
  const workerRanks = new Map(rankWorkers(list.filter(row => row.latest).map(row => row.latest)).map(entry => [entry.name, entry.requests]));
  const scores = new Map(list.map(row => [row.name, score(row, mode, workerRanks)]));
  list.sort((a, b) => (scores.get(a.name) ?? Infinity) - (scores.get(b.name) ?? Infinity) || a.name.localeCompare(b.name));
  list.forEach(({ tr }, index) => {
    if (tbody.children[index] !== tr) tbody.insertBefore(tr, tbody.children[index] ?? null);
  });
}

function renderOverview() {
  const box = select('#overview');
  const list = [...rows.values()];
  if (!list.length) return box.replaceChildren();
  const counts = { high: 0, warn: 0, ok: 0, unknown: 0 };
  for (const row of list) {
    const worst = row.latest ? summarizeUsage(row.latest).worst : null;
    counts[level(worst?.item.percent ?? null)] += 1;
  }
  const roomiest = pickRoomiestAccount(list.map(row => row.latest));
  const chip = (className, label, value) => {
    const node = element('div', undefined, `chip ${className}`);
    node.append(element('strong', String(value)), element('span', label));
    return node;
  };
  const chips = [chip('high', '个告急（80% 以上）', counts.high), chip('warn', '个偏高（60%–80%）', counts.warn), chip('ok', '个充裕', counts.ok)];
  if (counts.unknown) chips.push(chip('unknown', '个未查到', counts.unknown));
  if (roomiest) {
    const pick = element('button', undefined, 'chip pick');
    pick.type = 'button';
    pick.append(element('span', '余量最多'), element('strong', roomiest.name), element('span', `最紧张一项 ${percentText(roomiest.percent)}`));
    pick.addEventListener('click', () => openDetail(roomiest.name));
    chips.push(pick);
  }
  box.replaceChildren(...chips);
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
    for (const [name, row] of rows) {
      if (ids.get(name) !== row.accountId) {
        row.tr.remove();
        rows.delete(name);
      }
    }
    if (selected && !rows.has(selected) && !ids.has(selected)) closeDetail();
    tbody.querySelector('.empty')?.remove();
    if (!accounts.length) {
      const tr = element('tr', undefined, 'empty');
      const td = element('td', '还没有账号，点击「添加账号」开始。');
      td.colSpan = 7;
      tr.append(td);
      tbody.append(tr);
    }
    select('#summary').textContent = `${accounts.length} 个账号${accounts.length && !demo ? ' · 每分钟自动查询' : ''}`;
    message(feedback, '');
    await Promise.all(accounts.map(async account => {
      let row = rows.get(account.name);
      if (!row) {
        row = createRow(account);
        rows.set(account.name, row);
        tbody.append(row.tr);
        renderRow(row);
      }
      row.account = account;
      const last = row.time ? ` · 上次 ${row.time}` : '';
      setRowStatus(row, '查询中…' + last);
      if (selected === row.name) renderDetail();
      try {
        const result = await api(`/api/status/${encodeURIComponent(account.name)}?at=${encodeURIComponent(directory.queryTime)}`);
        if (sequence !== refreshSequence) return;
        if (result.account.accountId !== row.accountId || result.account.name !== row.name) throw new Error('账号已变更，请刷新列表。');
        row.latest = result.account;
        row.shown = result.account;
        row.error = undefined;
        row.time = new Date(result.window.end).toLocaleTimeString('zh-CN', { hour12: false });
        setRowStatus(row, `查询于 ${row.time}`);
      } catch (error) {
        if (sequence !== refreshSequence) return;
        row.latest = null;
        row.error = error.message;
        setRowStatus(row, error.message + last, true);
      }
      renderRow(row);
      if (selected === row.name) renderDetail();
    }));
    if (sequence === refreshSequence) {
      sortRows();
      renderOverview();
    }
  } catch (error) {
    if (sequence === refreshSequence) message(feedback, error.message, true);
  } finally {
    if (sequence === refreshSequence) refresh.disabled = false;
  }
}

select('#add').addEventListener('click', () => openEditor());
select('#close-editor').addEventListener('click', () => editor.close());
select('#close-detail').addEventListener('click', closeDetail);
select('#detail-edit').addEventListener('click', () => { const row = rows.get(selected); if (row) openEditor(row.account); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && selected && !document.querySelector('dialog[open]')) closeDetail();
});
editor.addEventListener('close', () => { fields.apiToken.value = ''; });
refresh.addEventListener('click', () => load());
select('#sort').addEventListener('change', () => { if (!refresh.disabled) sortRows(); });
select('#close-command').addEventListener('click', () => commandDialog.close());
directoryField.addEventListener('input', updateCommand);
commandForm.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await navigator.clipboard.writeText(preview.textContent);
    message(select('#copy-feedback'), '已复制');
  } catch {
    message(select('#copy-feedback'), '复制失败，请选中上面的完整命令手动复制。', true);
  }
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  message(select('#form-error'), '');
  try {
    const name = fields.name.value.trim();
    await mutate(editing ? 'PATCH' : 'POST', editing, Object.fromEntries(new FormData(form)));
    editor.close();
    if (editing && selected === editing) selected = name;
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
    if (selected === editing) closeDetail();
    await load();
  } catch (error) {
    message(select('#form-error'), error.message, true);
  }
});
void load();
setInterval(() => {
  if (document.visibilityState === 'visible' && !editor.open && !commandDialog.open && !refresh.disabled && !demo) {
    void load({ background: true });
  }
}, refreshEvery);
