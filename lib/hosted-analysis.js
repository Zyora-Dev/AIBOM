import { Worker } from 'node:worker_threads';

export function analyzeInWorker(body, { timeoutMs = 10_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Scan cancelled.'));
    const worker = new Worker(new URL('./analysis-worker.js', import.meta.url), {
      workerData: body,
      resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 }
    });
    let settled = false;
    const finish = (error, report) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Keep the concurrency slot occupied until the worker has actually stopped.
      worker.terminate().then(() => error ? reject(error) : resolve(report), () => reject(new Error('Could not stop analysis worker.')));
    };
    const abort = () => finish(new Error('Scan cancelled.'));
    const timer = setTimeout(() => finish(Object.assign(new Error('Analysis timed out. Select a smaller project and retry.'), { status: 503 })), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', value => finish(value.error ? Object.assign(new Error(value.error), { status: 400 }) : null, value.report));
    worker.once('error', () => finish(Object.assign(new Error('Analysis reached its resource limit. Select a smaller project and retry.'), { status: 503 })));
    worker.once('exit', () => {
      if (!settled) finish(Object.assign(new Error('Analysis stopped before completion. Please retry.'), { status: 503 }));
    });
  });
}

export function serverConfig(env = process.env) {
  const mode = env.HOSTING_MODE || 'local';
  if (!['local', 'public'].includes(mode)) throw new Error('HOSTING_MODE must be local or public.');
  let origin;
  if (mode === 'public') {
    const value = env.APP_ORIGIN || env.RENDER_EXTERNAL_URL;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
      origin = url.origin;
    } catch {
      throw new Error('Public mode requires APP_ORIGIN or RENDER_EXTERNAL_URL to be an HTTPS origin without a path.');
    }
  }
  return { mode, origin, host: mode === 'public' ? '0.0.0.0' : '127.0.0.1' };
}
