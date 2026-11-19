import { createHash } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';

// Only real Windows dashboards register. The pipe disappears when its owner exits.
export async function registerDashboard(key, url, onReuse) {
  const hash = createHash('sha256').update(key.toLowerCase()).digest('hex');
  const pipe = '\\\\.\\pipe\\cf-hub-ui-' + hash;
  const registry = createServer(socket => {
    socket.on('error', () => {});
    onReuse();
    socket.end(url);
  });
  try {
    registry.listen(pipe);
    await once(registry, 'listening');
    return { url, close: () => registry.close() };
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
  }
  const socket = createConnection(pipe);
  socket.setTimeout(2000, () => socket.destroy(new Error('读取已打开的看板地址超时。')));
  let address = '';
  for await (const chunk of socket) {
    address += chunk;
    if (address.length > 32) throw new Error('已打开的看板地址无效。');
  }
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(address) || Number(new URL(address).port) > 65535) {
    throw new Error('已打开的看板地址无效。');
  }
  return { url: address };
}
