const fictionalRevision = '0123456789abcdef0123456789abcdef01234567';

export function getDemo() {
  const project = fixed => ({
    projectName: 'offline-risk-demo',
    files: [
      {
        path: 'app.py',
        content: [
          '# FICTIONAL OFFLINE FIXTURE: model IDs and revisions are invented, not verified.',
          '# These examples are scanned as text only; do not execute or download them.',
          'from transformers import AutoModel',
          'import torch',
          `encoder = AutoModel.from_pretrained('openaibom-fixtures/fictional-encoder', revision='${fixed ? fictionalRevision : 'main'}', trust_remote_code=${fixed ? 'False' : 'True'})`,
          `weights = torch.load('fictional-weights.pt', weights_only=${fixed ? 'True' : 'False'})`,
          ''
        ].join('\n')
      },
      {
        path: 'app.js',
        content: [
          '// FICTIONAL OFFLINE FIXTURE: no model or revision has been verified.',
          "import { AutoModel } from '@huggingface/transformers';",
          `const encoder = AutoModel.from_pretrained('openaibom-fixtures/fictional-encoder', { revision: '${fixed ? fictionalRevision : 'main'}', trust_remote_code: ${fixed ? 'false' : 'true'} });`,
          ''
        ].join('\n')
      },
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'offline-risk-demo',
          version: '1.0.0',
          private: true,
          description: 'FICTIONAL OFFLINE FIXTURE. Synthetic advisory only; not a real package vulnerability.',
          dependencies: { '@openaibom-fixtures/unsafe-loader': fixed ? '1.0.1' : '1.0.0' }
        }, null, 2)
      },
      {
        path: 'package-lock.json',
        content: JSON.stringify({
          name: 'offline-risk-demo',
          lockfileVersion: 3,
          packages: {
            '': { name: 'offline-risk-demo', version: '1.0.0' },
            'node_modules/@openaibom-fixtures/unsafe-loader': { version: fixed ? '1.0.1' : '1.0.0' }
          }
        }, null, 2)
      }
    ]
  });
  return { before: project(false), after: project(true) };
}
