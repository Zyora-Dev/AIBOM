export const LIMITS = { files: 300, fileBytes: 128 * 1024, totalBytes: 1024 * 1024 };
const excluded = /(^|\/)(?:node_modules|\.git|\.venv|venv|dist|build|__pycache__)(\/|$)/;
export function isSupportedPath(path) {
  if (typeof path !== 'string' || path.length > 500 || path.startsWith('/') || path.includes('\\') || path.split('/').some(p => !p || p === '..' || p.startsWith('.')) || excluded.test(path)) return false;
  return /(?:^|\/)(?:package(?:-lock)?\.json|requirements(?:[-.][\w-]+)?\.txt|pyproject\.toml)$/.test(path) || /\.(?:py|js|jsx|ts|tsx|mjs|cjs)$/.test(path);
}
