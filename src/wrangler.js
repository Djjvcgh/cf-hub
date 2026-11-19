import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { proxyEnvironment } from './cloudflare.js';

const appDir = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const overrides = new Set([
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL',
  'CLOUDFLARE_API_HEADERS', 'CLOUDFLARE_API_BASE_URL', 'CLOUDFLARE_COMPLIANCE_REGION', 'CLOUDFLARE_AUTH_PROFILE', 'CLOUDFLARE_ENV',
  'CF_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_API_KEY', 'CF_EMAIL', 'CF_API_BASE_URL',
  'WRANGLER_API_ENVIRONMENT', 'WRANGLER_AUTH_DOMAIN', 'WRANGLER_AUTH_URL', 'WRANGLER_CF_AUTHORIZATION_TOKEN',
]);
const blockedOptions = new Set(['profile', 'temporary', 'account-id', 'account', 'api-base-url', 'experimental-new-config']);

function optionsFor(definitions) {
  const options = Object.create(null);
  for (const [name, definition] of Object.entries(definitions)) {
    const option = { type: definition.type === 'boolean' ? 'boolean' : 'string', multiple: true };
    for (const spelling of [name, ...[definition.alias ?? []].flat()]) options[spelling] = option;
  }
  return options;
}

function parse(args, options) {
  return parseArgs({ args, options, allowPositionals: true, strict: false, tokens: true });
}

function oneOption(parsed, names) {
  const matches = parsed.tokens.filter(token => token.kind === 'option' && names.includes(token.name));
  if (matches.length > 1 || matches.some(token => !token.value)) throw new Error(`请明确指定一次 --${names[0]}。`);
  return matches[0]?.value;
}

function withoutCwd(parsed, args) {
  const token = parsed.tokens.find(entry => entry.kind === 'option' && entry.name === 'cwd');
  if (!token) return args;
  return args.filter((_, index) => index !== token.index && (token.inlineValue || index !== token.index + 1));
}

function assertEnvFiles(cwd, env, paths) {
  const defaults = ['.env', '.env.local'];
  if (env) defaults.push(`.env.${env}`, `.env.${env}.local`);
  for (const file of paths ?? defaults) {
    const path = resolve(cwd, file);
    try {
      const contents = readFileSync(path, 'utf8');
      const keys = [...Object.keys(parseEnv(contents)), ...Array.from(contents.matchAll(/^\s*(?:export\s+)?([\w]+)\s*:\s+/gm), match => match[1])];
      const conflict = keys.find(key => overrides.has(key.toUpperCase()));
      if (conflict) throw new Error(`${path} 设置了 ${conflict}，请移除这项账号或认证覆盖后再运行。`);
    } catch (error) {
      if (error.code === 'ENOENT' && !paths) continue;
      if (!error.code) throw error;
      throw new Error(`无法检查 Wrangler 环境文件 ${path}。`);
    }
  }
}

function assertAccount(account, value, path) {
  if (value !== undefined && (typeof value !== 'string' || value.toLowerCase() !== account.accountId)) {
    throw new Error(`账号冲突：${path} 的 account_id 与 ${account.name ?? account.alias}（${account.accountId}）不一致。`);
  }
}

export function checkWrangler(account, args, cwd = process.cwd()) {
  if (args.some(arg => /[\r\n]/.test(arg))) throw new Error('Wrangler 参数不能包含换行。');
  const wrangler = require('wrangler');
  const { registry, globalFlags } = wrangler.experimental_getWranglerCommands();
  const globals = optionsFor(globalFlags);
  const first = parse(args, globals);
  let command = registry;
  let depth = 0;
  for (const part of first.positionals) {
    const child = command.subtree.get(part);
    if (!child) break;
    command = child;
    depth += 1;
  }
  const firstWord = first.positionals[0];
  const definition = command.definition;
  if (['auth', 'login', 'logout'].includes(firstWord)) throw new Error('登录凭据由 cf-hub 的账号配置提供，请在看板里管理。');
  if (!definition?.handler && !args.some(arg => ['--help', '-h', '--version', '-v'].includes(arg))) {
    throw new Error('无法识别 Wrangler 命令，无法确认它会使用的账号。');
  }
  const parsed = parse(args, { ...globals, ...optionsFor(definition?.args ?? {}) });
  for (const token of parsed.tokens) {
    if (token.kind === 'option' && (blockedOptions.has(token.name) || token.name.startsWith('temporary-'))) {
      throw new Error(`无法安全使用 ${token.rawName}。请让 cf-hub 选择账号并使用常规 Wrangler 配置。`);
    }
  }
  const workDir = resolve(cwd, oneOption(parsed, ['cwd']) ?? '.');
  const config = oneOption(parsed, ['config', 'c']);
  const env = oneOption(parsed, ['env', 'e']);
  const pages = firstWord === 'pages';
  const commandName = first.positionals.slice(0, depth).join(' ');
  const usesPagesRedirect = ['pages deploy', 'pages publish', 'pages functions build'].includes(commandName);
  if (usesPagesRedirect && (config || env) && commandName !== 'pages functions build') {
    throw new Error('Pages 部署从项目目录读取配置。请使用 --cwd 选择目录，使用 --branch 选择分支。');
  }
  const location = definition?.positionalArgs?.[0];
  const positional = ['script', 'path'].includes(location) && parsed.positionals[depth];
  const chosenScript = oneOption(parsed, ['script']);
  const script = positional && !(location === 'path' && statSync(resolve(workDir, positional), { throwIfNoEntry: false })?.isDirectory())
    ? positional : chosenScript;
  const useRedirectIfAvailable = Boolean(definition?.behaviour?.useConfigRedirectIfAvailable || usesPagesRedirect || commandName === 'dev');

  assertEnvFiles(workDir, env, parsed.values['env-file']);
  const previousDir = process.cwd();
  try {
    process.chdir(workDir);
    for (const entry of script && !config ? [script, undefined] : [undefined]) {
      let path = config ? resolve(workDir, config) : workDir;
      try {
        const checked = wrangler.experimental_readRawConfig({ config, script: entry }, { useRedirectIfAvailable });
        path = checked.configPath ?? path;
        const raw = checked.rawConfig;
        if (pages) {
          assertAccount(account, raw.account_id, path);
          for (const target of ['production', 'preview']) assertAccount(account, raw.env?.[target]?.account_id, path);
        } else if (checked.configPath) {
          const effective = wrangler.unstable_readConfig({ config: checked.configPath, env, script: entry }, { hideWarnings: true });
          assertAccount(account, effective.account_id, path);
        }
      } catch (error) {
        if (error.message.startsWith('账号冲突')) throw error;
        throw new Error(`无法确认 ${account.name ?? account.alias} 的 Wrangler 配置，请检查 ${path} 及可能的生成配置。`);
      }
    }
  } finally {
    process.chdir(previousDir);
  }

  return ['--cwd', workDir, ...withoutCwd(parsed, args)];
}

function npmEntry() {
  const nodeDir = dirname(process.execPath);
  const dirs = [nodeDir, ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)];
  for (const dir of dirs) {
    for (const path of [join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js'), join(dir, 'npx')]) {
      if (!existsSync(path)) continue;
      const actual = realpathSync(path);
      if (actual.endsWith('npx-cli.js')) return actual;
    }
  }
  throw new Error('找不到 Node.js 自带的 npx，请检查 Node.js 和 npm 安装。');
}

export async function runWrangler(account, args) {
  const launch = checkWrangler(account, args);
  const npx = npmEntry();
  const expectedBin = resolve(appDir, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler');
  if (!existsSync(expectedBin)) throw new Error('cf-hub 的 Wrangler 未安装，请在 cf-hub 目录运行 npm install。');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => {
    const key = name.toUpperCase();
    return !overrides.has(key) && !['NODE_OPTIONS', 'NODE_PATH'].includes(key) && !key.startsWith('NPM_CONFIG_');
  }));
  Object.assign(env, await proxyEnvironment(), {
    CLOUDFLARE_API_TOKEN: account.apiToken,
    CLOUDFLARE_ACCOUNT_ID: account.accountId,
    CLOUDFLARE_API_BASE_URL: 'https://api.cloudflare.com/client/v4',
    WRANGLER_LOG_SANITIZE: 'true',
    WRANGLER_SEND_METRICS: 'false',
  });
  const shell = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe') : '/bin/sh';
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npx, '--offline', '--no', '--global=false', `--prefix=${appDir}`,
      `--script-shell=${shell}`, 'wrangler', ...launch], { cwd: appDir, env, stdio: 'inherit' });
    child.on('error', () => reject(new Error('无法启动 cf-hub 随附的 Wrangler。')));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
  });
}
