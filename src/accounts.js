import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile, chmod, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const accountsPath = join(homedir(), '.cf-hub', 'accounts.json');
export const aliasPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class InputError extends Error {}

export function accountRecord(input, previous) {
  const { alias, remark = '', accountId, apiToken = '' } = input ?? {};
  if (typeof alias !== 'string' || !aliasPattern.test(alias)) {
    throw new InputError('别名须以小写字母或数字开头，且仅包含小写字母、数字和连字符。');
  }
  if (typeof remark !== 'string' || remark.length > 500) throw new InputError('备注须为 500 字以内的文字。');
  if (typeof accountId !== 'string' || !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new InputError('Account ID 须为 32 位十六进制字符。');
  }
  const token = apiToken === '' ? previous?.apiToken : apiToken;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{1,512}$/.test(token)) {
    throw new InputError('请输入有效格式的 API Token。');
  }
  return { alias, remark, accountId: accountId.toLowerCase(), apiToken: token };
}

export function publicAccount({ alias, remark, accountId }) {
  return { alias, remark, accountId };
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
      const records = JSON.parse(contents.replace(/^\uFEFF/, '')).map(record => accountRecord(record));
      if (new Set(records.map(record => record.alias)).size !== records.length) throw new InputError('存在重复别名。');
      return records;
    } catch (error) {
      const reason = error instanceof InputError ? error.message : '应为 JSON 格式的账号数组。';
      throw new Error(`账号配置 ${path} 有问题。${reason}`);
    }
  }

  function update(change) {
    const write = pending.then(async () => {
      const next = await change(await read());
      const dir = dirname(path);
      const temp = join(dir, `.accounts-${randomUUID()}.tmp`);
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        if (!(await lstat(dir)).isDirectory()) throw new Error('账号目录必须是普通目录。');
        await protectDirectory(dir);
        await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true });
        await rename(temp, path);
      } catch (error) {
        throw new Error(`无法保存账号配置 ${path}，请检查目录权限。`, { cause: error });
      } finally {
        await rm(temp, { force: true }).catch(() => {});
      }
      return next;
    });
    pending = write.catch(() => {});
    return write;
  }

  return { read, update };
}
