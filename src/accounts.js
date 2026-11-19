import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile, chmod, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
export const accountsPath = join(homedir(), '.cf-hub', 'accounts.json');
export class InputError extends Error {}

export function normalizeAccountName(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || /["\x00-\x1f\x7f\u0085\u2028\u2029]/.test(value)) return null;
  const name = value.trim().normalize('NFC');
  return name && name !== '.' && name !== '..' && name.length <= 120 ? name : null;
}

export function findAccount(accounts, selector) {
  const name = normalizeAccountName(selector);
  return name ? accounts.find(account => account.name === name || account.alias === name) : undefined;
}

export function accountRecord(input, previous) {
  const { accountId, apiToken = '' } = input ?? {};
  const name = normalizeAccountName(input?.name);
  if (!name) throw new InputError('请输入 1 至 120 字的账号名称。名称可以有空格，请去掉英文双引号和换行。');
  if (typeof accountId !== 'string' || !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new InputError('Account ID 须为 32 位十六进制字符。');
  }
  const token = apiToken === '' ? previous?.apiToken : apiToken;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{1,512}$/.test(token)) {
    throw new InputError('请输入有效格式的 API Token。');
  }
  return {
    name, accountId: accountId.toLowerCase(), apiToken: token,
    ...(previous?.alias && { alias: previous.alias }),
    ...(previous?.remark && { remark: previous.remark }),
  };
}

export function publicAccount({ alias, name = alias, remark = '', accountId }) {
  return { name, alias: alias ?? name, remark, accountId };
}

function readRecords(records) {
  if (!Array.isArray(records)) throw new InputError('应为 JSON 格式的账号数组。');
  const reserved = new Set(records.flatMap(record => [normalizeAccountName(record?.name), normalizeAccountName(record?.alias)]));
  const used = new Set();
  return records.map(record => {
    const alias = normalizeAccountName(record?.alias);
    const remark = typeof record?.remark === 'string' ? record.remark : '';
    const candidate = normalizeAccountName(remark);
    const name = record?.name ?? (candidate && !reserved.has(candidate) && !used.has(candidate) ? candidate : alias);
    const account = accountRecord({ ...record, name }, { alias, remark });
    for (const selector of new Set([account.name, account.alias].filter(Boolean))) {
      if (used.has(selector)) throw new InputError('存在重复的账号名称。');
      used.add(selector);
    }
    return account;
  });
}

async function protectDirectory(path) {
  if (process.platform !== 'win32') {
    await chmod(path, 0o700);
    return;
  }
  const script = `
    $ErrorActionPreference = 'Stop'
    $path = $env:CF_HUB_ACL_PATH
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [IO.Directory]::GetAccessControl($path, [Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {
      $acl.RemoveAccessRuleSpecific($rule)
    }
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $onlyUser = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', 'Allow')
    $acl.SetAccessRule($onlyUser)
    [IO.Directory]::SetAccessControl($path, $acl)`;
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, CF_HUB_ACL_PATH: path },
    windowsHide: true,
  });
}

export function createAccountStore(path = accountsPath) {
  let pending = Promise.resolve();

  async function read() {
    let contents;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error(`无法读取账号配置 ${path}（${error.code ?? '读取失败'}）。`);
    }
    try {
      return readRecords(JSON.parse(contents.replace(/^\uFEFF/, '')));
    } catch (error) {
      const reason = error instanceof InputError ? error.message : '应为 JSON 格式的账号数组。';
      throw new Error(`账号配置 ${path} 有问题。${reason}`);
    }
  }

  function update(change) {
    const write = pending.then(async () => {
      const dir = dirname(path);
      const temp = join(dir, `.accounts-${randomUUID()}.tmp`);
      let lock;
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        if (!(await lstat(dir)).isDirectory()) throw new Error('账号目录必须是普通目录。');
        await protectDirectory(dir);
        // SQLite holds an OS file lock. Closing the connection or exiting the process releases it.
        lock = new DatabaseSync(`${path}.lock`);
        const deadline = Date.now() + 60_000;
        for (;;) {
          try {
            lock.exec('BEGIN IMMEDIATE');
            break;
          } catch (error) {
            if (error.errcode !== 5) throw error;
            if (Date.now() >= deadline) throw new InputError('另一个窗口仍在保存账号，请稍后重试。');
            await delay(50);
          }
        }
      } catch (error) {
        lock?.close();
        if (error instanceof InputError) throw error;
        throw new Error(`无法锁定账号配置 ${path}，请检查目录权限。`, { cause: error });
      }
      try {
        const next = readRecords(await change(await read()));
        try {
          await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true });
          await rename(temp, path);
        } catch (error) {
          throw new Error(`无法保存账号配置 ${path}，请检查目录权限。`, { cause: error });
        }
        return next;
      } finally {
        lock.close();
        await rm(temp, { force: true }).catch(() => {});
      }
    });
    pending = write.catch(() => {});
    return write;
  }

  return { read, update };
}
