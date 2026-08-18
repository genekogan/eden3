import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { URL } from 'node:url';

import { isAllowedHost, parseAllowedPorts, parseAllowlist } from './allowlist.mjs';
import { parseMode, vetTarget } from './policy.mjs';

const PORT = Number.parseInt(process.env.PORT ?? '8080', 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.EDEN3_EGRESS_TIMEOUT_MS ?? '30000', 10);
const MODE = parseMode(process.env.EDEN3_EGRESS_MODE);
const allowlist = parseAllowlist(process.env.EDEN3_EGRESS_ALLOWLIST);
const allowedPorts = parseAllowedPorts(process.env.EDEN3_EGRESS_ALLOWED_PORTS);

function stripHopHeaders(headers) {
  const clean = { ...headers };
  delete clean['proxy-authorization'];
  delete clean['proxy-connection'];
  delete clean.connection;
  return clean;
}

function deny(resOrSocket, statusCode, message) {
  const body = `${message}\n`;
  if ('writeHead' in resOrSocket) {
    resOrSocket.writeHead(statusCode, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      connection: 'close',
    });
    resOrSocket.end(body);
    return;
  }
  resOrSocket.end(`HTTP/1.1 ${statusCode} ${message}\r\ncontent-length: 0\r\n\r\n`);
}

/**
 * Vet a target per the active mode. Returns {ok, address?, reason?}.
 * - open: port must be allowed; the interior must be unreachable (policy.mjs
 *   vetting with resolve-then-pin).
 * - allowlist: legacy provider allowlist AND the interior checks (an
 *   allowlisted name resolving to a private IP is still refused).
 */
async function vet(host, port) {
  if (!allowedPorts.includes(port)) return { ok: false, reason: 'port not allowed' };
  if (MODE === 'allowlist' && !isAllowedHost(host, allowlist)) {
    return { ok: false, reason: 'egress target denied' };
  }
  return vetTarget(host);
}

function handleHealth(req, res) {
  if (req.method === 'GET' && req.url === '/health') {
    const body = JSON.stringify({ ok: true, mode: MODE, allowlistHosts: allowlist.length });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  if (handleHealth(req, res)) return;

  let target;
  try {
    target = new URL(req.url ?? '');
  } catch {
    deny(res, 400, 'proxy requires absolute-form request target');
    return;
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    deny(res, 400, 'unsupported proxy protocol');
    return;
  }
  const port = target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number.parseInt(target.port, 10);
  const verdict = await vet(target.hostname, port);
  if (!verdict.ok) {
    deny(res, 403, `egress target denied (${verdict.reason})`);
    return;
  }

  // Pinned connect: the socket goes to the vetted address; Host/SNI keep the
  // original name so virtual hosting and TLS still work.
  const upstream = (target.protocol === 'https:' ? https : http).request({
    protocol: target.protocol,
    hostname: verdict.address,
    servername: target.protocol === 'https:' ? target.hostname : undefined,
    port,
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers: { ...stripHopHeaders(req.headers), host: `${target.hostname}${target.port ? `:${target.port}` : ''}` },
    timeout: REQUEST_TIMEOUT_MS,
  });

  upstream.on('response', (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, stripHopHeaders(upstreamRes.headers));
    upstreamRes.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', () => deny(res, 502, 'egress upstream failed'));
  req.pipe(upstream);
});

server.on('connect', async (req, clientSocket, head) => {
  const target = String(req.url ?? '');
  const separator = target.lastIndexOf(':');
  if (separator <= 0) {
    deny(clientSocket, 400, 'invalid CONNECT target');
    return;
  }

  const host = target.slice(0, separator);
  const port = Number.parseInt(target.slice(separator + 1), 10);
  const verdict = await vet(host, port);
  if (!verdict.ok) {
    deny(clientSocket, 403, `egress target denied (${verdict.reason})`);
    return;
  }

  // Pinned connect to the vetted address (TLS SNI comes from the client
  // inside the tunnel, addressed to the name it asked for).
  const upstream = net.connect({ host: verdict.address, port });
  upstream.setTimeout(REQUEST_TIMEOUT_MS);
  upstream.on('connect', () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', () => clientSocket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n'));
  clientSocket.on('error', () => upstream.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `eden3 egress proxy listening on :${PORT} (mode=${MODE}${MODE === 'allowlist' ? `, ${allowlist.length} hosts` : ''})`,
  );
});
