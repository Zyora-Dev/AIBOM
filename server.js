import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { analyzeInWorker, serverConfig } from './lib/hosted-analysis.js';
import { getDemo } from './lib/demo.js';
import { runBenchmark } from './lib/benchmark.js';

const assets = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/scanner.js', ['lib/path-policy.js', 'text/javascript; charset=utf-8']]
]);
const bodyLimit = 12 * 1024 * 1024;

export function createAppServer({ config = serverConfig(), maxConcurrent = 2, scansPerMinute = 20 } = {}) {
  let benchmark;
  let activeScans = 0;
  let windowStart = Date.now();
  let scanRequests = 0;
  return http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000, connectionsCheckingInterval: 1000 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (config.mode === 'public') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const json = (status, value) => {
      if (res.destroyed || res.writableEnded) return;
      if (status >= 400 && req.method === 'POST') res.setHeader('Connection', 'close');
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    // Render health probes may use an internal Host header. Only this inert endpoint bypasses the allowlist.
    if (config.mode === 'public' && req.method === 'GET' && req.url === '/api/health') return json(200, { status: 'ok', engineVersion: '0.2.0' });
    const expectedHosts = config.mode === 'public' ? [new URL(config.origin).host] : [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
    if (!expectedHosts.includes(req.headers.host)) return json(403, { error: 'This host is not allowed.' });
    const expectedOrigin = config.mode === 'public' ? config.origin : `http://${req.headers.host}`;
    if ((req.headers.origin && req.headers.origin !== expectedOrigin) || (config.mode === 'public' && req.method === 'POST' && req.headers.origin !== expectedOrigin)) return json(403, { error: 'Cross-origin requests are not allowed. Open the configured demo URL.' });
    if (req.method === 'GET' && req.url === '/api/health') return json(200, { status: 'ok', engineVersion: '0.2.0' });
    if (req.method === 'GET' && req.url === '/api/config') return json(200, {
      hostingMode: config.mode, uploadsEnabled: true,
      sourceHandling: { persisted: false, executed: false },
      limits: { files: 300, fileBytes: 131072, totalBytes: 1048576 }, maxScanSeconds: 10
    });
    if (req.method === 'GET' && req.url === '/api/demo') return json(200, getDemo());
    if (req.method === 'GET' && req.url === '/api/benchmark') {
      try {
        benchmark ||= runBenchmark();
        return json(200, benchmark);
      } catch {
        return json(500, { error: 'Benchmark execution failed.' });
      }
    }
    if (req.method === 'POST' && req.url === '/api/scan') {
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') return json(415, { error: 'Use application/json.' });
      if (Number(req.headers['content-length']) > bodyLimit) return json(413, { error: 'Request exceeds the 12 MB limit including the baseline.' });
      if (config.mode === 'public') {
        if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); scanRequests = 0; }
        // A global per-process budget avoids trusting spoofable proxy/IP headers.
        if (scanRequests >= scansPerMinute) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((windowStart + 60_000 - Date.now()) / 1000))));
          return json(429, { error: 'The shared demo scan limit was reached. Wait up to one minute and retry.' });
        }
        scanRequests++;
      }
      if (activeScans >= maxConcurrent) {
        res.setHeader('Retry-After', '10');
        return json(503, { error: 'The demo is busy. Wait 10 seconds and retry.' });
      }
      activeScans++;
      let size = 0;
      const chunks = [];
      const controller = new AbortController();
      const cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', cancel);
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > bodyLimit) return json(413, { error: 'Request exceeds the 12 MB limit including the baseline.' });
          chunks.push(chunk);
        }
        if (res.destroyed) return;
        const report = await analyzeInWorker(Buffer.concat(chunks).toString('utf8'), { signal: controller.signal });
        return json(200, report);
      } catch (error) {
        if (error.status === 503) res.setHeader('Retry-After', '10');
        return json(error.status || 400, { error: error.message });
      } finally {
        res.removeListener('close', cancel);
        activeScans--;
      }
    }
    const asset = req.method === 'GET' && assets.get(req.url);
    if (!asset) return json(404, { error: 'Not found.' });
    try {
      const data = await readFile(new URL(asset[0], import.meta.url));
      res.writeHead(200, { 'Content-Type': asset[1] });
      res.end(data);
    } catch {
      json(500, { error: 'Could not load application assets.' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const config = serverConfig();
  const server = createAppServer({ config });
  server.on('error', error => {
    console.error(`Could not start OpenAIBOM: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, config.host, () => console.log(`OpenAIBOM: ${config.origin || `http://127.0.0.1:${port}`} (${config.mode} mode)`));
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 15_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
