import net from 'node:net';

export const DEFAULT_AGENT_CRON_SOCKET = '/run/eden3-cron/agent-cron.sock';
const MAX_RESPONSE_BYTES = 262_144;

export function requestAgentCron(payload, options = {}) {
  const socketPath = options.socketPath ?? DEFAULT_AGENT_CRON_SOCKET;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const signal = options.signal;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('cron request aborted'));
      return;
    }
    const socket = net.createConnection(socketPath);
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(signal.reason ?? new Error('cron request aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.setTimeout(timeoutMs, () => finish(new Error('Eden cron bridge timed out')));
    socket.once('error', (error) => finish(error));
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        finish(new Error('Eden cron bridge response was too large'));
        return;
      }
      chunks.push(chunk);
      const frame = Buffer.concat(chunks);
      const newline = frame.indexOf(0x0a);
      if (newline === -1) return;
      if (frame.subarray(newline + 1).toString('utf8').trim()) {
        finish(new Error('Eden cron bridge returned multiple frames'));
        return;
      }
      try {
        finish(null, JSON.parse(frame.subarray(0, newline).toString('utf8')));
      } catch {
        finish(new Error('Eden cron bridge returned invalid JSON'));
      }
    });
    // Keep the writable side open until the bridge returns its frame. Calling
    // socket.end() here half-closes the client; Node servers default to
    // allowHalfOpen=false, so any asynchronous database dispatch can make the
    // server auto-close before it writes the response. The request still
    // commits, leaving the model blocked forever waiting for a tool result.
    socket.once('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
  });
}
