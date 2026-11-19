import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkWrangler } from '../src/wrangler.js';

const account = { alias: 'cf-2', accountId: '2'.repeat(32), apiToken: 'never-printed' };
const different = '1'.repeat(32);

test('deploy uses relative directories, active environments and generated config for the target check', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cf-hub-wrangler-'));
  const work = join(root, 'site with spaces');
  const redirect = join(work, '.wrangler', 'deploy');
  await mkdir(redirect, { recursive: true });
  const files = new Set();
  async function write(dir, name, data) {
    const path = join(dir, name);
    files.add(path);
    await writeFile(path, data);
  }
  t.after(async () => {
    for (const file of files) await rm(file, { force: true });
    for (const dir of [redirect, join(work, '.wrangler'), work, root]) await rmdir(dir);
  });
  await write(work, 'wrangler.toml', `name = "example"\naccount_id = "${account.accountId}"\n`);
  assert.deepEqual(checkWrangler(account, ['deploy', '--cwd', 'site with spaces', '--dry-run'], root),
    ['--cwd', work, 'deploy', '--dry-run']);

  await write(work, 'different.jsonc', `// test\n{"account_id":"${different}"}`);
  assert.throws(() => checkWrangler(account, ['deploy', '-c', 'different.jsonc'], work), /账号冲突.*different\.jsonc/);
  await write(work, 'wrangler.toml', `name = "example"\n[env.stage]\naccount_id = "${different}"\n`);
  assert.throws(() => checkWrangler(account, ['deploy', '-e', 'stage'], work), /账号冲突/);

  await write(redirect, 'config.json', '{"configPath":"../../different.jsonc"}');
  assert.throws(() => checkWrangler(account, ['deploy'], work), /账号冲突.*different\.jsonc/);
  assert.throws(() => checkWrangler(account, ['pages', 'deploy', './dist'], work), /账号冲突.*different\.jsonc/);
  assert.doesNotThrow(() => checkWrangler(account, ['d1', 'list'], work));

  await write(work, '.env.local', 'export CLOUDFLARE_API_BASE_URL="https://example.com"');
  assert.throws(() => checkWrangler(account, ['deploy'], work), /\.env\.local 设置了 CLOUDFLARE_API_BASE_URL/);
  assert.throws(() => checkWrangler(account, ['whoami', '--profile', 'other'], work), /--profile/);
});
