import { parentPort, workerData } from 'node:worker_threads';
import { scanProject } from './scanner.js';

try {
  parentPort.postMessage({ report: scanProject(JSON.parse(workerData)) });
} catch (error) {
  parentPort.postMessage({ error: error instanceof SyntaxError ? 'Invalid JSON request.' : error instanceof RangeError ? 'Analysis exceeded supported complexity. Select a smaller project.' : error.message });
}
