import { scanProject } from './scanner.js';

const revision = '0123456789abcdef0123456789abcdef01234567';
const measuredCodes = new Set([
  'MODEL_UNPINNED', 'REMOTE_CODE_ENABLED', 'UNSAFE_DESERIALIZATION',
  'DYNAMIC_REFERENCE', 'REVISION_UNRESOLVED', 'REMOTE_CODE_UNRESOLVED',
  'LOADER_SAFETY_UNRESOLVED', 'LOCAL_MODEL_PROVENANCE_UNKNOWN', 'PARSE_ERROR', 'FIXTURE_ADVISORY_MATCH'
]);
const evidence = (code, path, line) => ({ code, path, line });
const fixture = (name, path, content, labels = []) => ({
  name, files: [{ path, content }],
  expected: labels.map(([code, line]) => evidence(code, path, line))
});

// Ground truth is hand-labelled against the fixture text, never derived from a scan.
// All identifiers and commit hashes below are fictional; nothing is executed/fetched.
const fixtures = [
  fixture('Python unpinned remote-code model', 'model.py',
    "from transformers import AutoModel\nAutoModel.from_pretrained('fictional/model', revision='main', trust_remote_code=True)\n",
    [['MODEL_UNPINNED', 2], ['REMOTE_CODE_ENABLED', 2]]),
  fixture('Python pinned model with remote code disabled', 'model.py',
    `from transformers import AutoModel\nAutoModel.from_pretrained('fictional/model', revision='${revision}', trust_remote_code=False)\n`),
  fixture('Python omitted revision', 'model.py',
    "AutoModel.from_pretrained('fictional/model')\n", [['MODEL_UNPINNED', 1]]),
  fixture('Python multiline call evidence', 'model.py',
    "from transformers import AutoModel\nmodel = AutoModel.from_pretrained(\n    'fictional/model',\n    trust_remote_code=True\n)\n",
    [['MODEL_UNPINNED', 2], ['REMOTE_CODE_ENABLED', 2]]),
  fixture('Python model import alias', 'aliases.py',
    "from transformers import AutoModel as Encoder\nEncoder.from_pretrained('fictional/model')\n", [['MODEL_UNPINNED', 2]]),
  fixture('Python pipeline alias', 'pipeline.py',
    "from transformers import pipeline as build_pipeline\nbuild_pipeline('text-classification', model='fictional/model', trust_remote_code=True)\n",
    [['MODEL_UNPINNED', 2], ['REMOTE_CODE_ENABLED', 2]]),
  fixture('Python safe pinned pipeline', 'pipeline.py',
    `import transformers\ntransformers.pipeline('text-classification', model='fictional/model', revision='${revision}', trust_remote_code=False)\n`),
  fixture('Python dataset remote code', 'dataset.py',
    "from datasets import load_dataset as get_data\nget_data('fictional/data', trust_remote_code=True)\n", [['REMOTE_CODE_ENABLED', 2]]),
  fixture('Python dataset without remote code', 'dataset.py',
    "from datasets import load_dataset\nload_dataset('fictional/data', trust_remote_code=False)\n"),
  fixture('Python unsafe torch module alias', 'loader.py',
    "import torch as tensor\ntensor.load('fictional.pt', weights_only=False)\n", [['UNSAFE_DESERIALIZATION', 2]]),
  fixture('Python safe torch function alias', 'loader.py',
    "from torch import load as load_weights\nload_weights('fictional.pt', weights_only=True)\n"),
  fixture('Python unsafe torch function alias', 'loader.py',
    "from torch import load as load_weights\nload_weights('fictional.pt', weights_only=False)\n", [['UNSAFE_DESERIALIZATION', 2]]),
  fixture('Python pickle and joblib aliases', 'loaders.py',
    "import pickle as objects\nfrom pickle import loads as decode\nfrom joblib import load as restore\nobjects.load(handle)\ndecode(payload)\nrestore('fictional.joblib')\n",
    [['UNSAFE_DESERIALIZATION', 4], ['UNSAFE_DESERIALIZATION', 5], ['UNSAFE_DESERIALIZATION', 6]]),
  fixture('Python repeated findings retain multiplicity', 'loader.py',
    "import pickle\npickle.loads(first); pickle.loads(second)\n",
    [['UNSAFE_DESERIALIZATION', 2], ['UNSAFE_DESERIALIZATION', 2]]),
  fixture('Python omitted torch safety', 'loader.py',
    "import torch\ntorch.load('fictional.pt')\n", [['LOADER_SAFETY_UNRESOLVED', 2]]),
  fixture('Python dynamic torch safety', 'loader.py',
    "import torch\ntorch.load('fictional.pt', weights_only=restricted)\n", [['LOADER_SAFETY_UNRESOLVED', 2]]),
  fixture('Python dynamic model reference', 'dynamic.py',
    `AutoModel.from_pretrained(model_id, revision='${revision}', trust_remote_code=False)\n`, [['DYNAMIC_REFERENCE', 1]]),
  fixture('Python dynamic model options', 'dynamic.py',
    "AutoModel.from_pretrained('fictional/model', revision=commit, trust_remote_code=allow_code)\n",
    [['REVISION_UNRESOLVED', 1], ['REMOTE_CODE_UNRESOLVED', 1]]),
  fixture('Python expanded model options', 'dynamic.py',
    "AutoModel.from_pretrained('fictional/model', **options)\n",
    [['REVISION_UNRESOLVED', 1], ['REMOTE_CODE_UNRESOLVED', 1]]),
  fixture('Python comments and string examples are not calls', 'examples.py',
    "# AutoModel.from_pretrained('fictional/comment', trust_remote_code=True)\nexample = \"AutoModel.from_pretrained('fictional/string')\"\nexample2 = \"torch.load('fictional.pt', weights_only=False)\"\n\"\"\"pickle.loads(payload)\nload_dataset('fictional/data', trust_remote_code=True)\"\"\"\n"),
  fixture('Python ordinary model assignment is not a pin violation', 'candidate.py', "model = 'fictional/candidate'\n"),
  fixture('Python local model needs provenance, not a remote revision', 'local.py',
    "AutoModel.from_pretrained('./model', trust_remote_code=False)\n", [['LOCAL_MODEL_PROVENANCE_UNKNOWN', 1]]),
  fixture('JavaScript local model needs provenance, not a remote revision', 'local.js',
    "AutoModel.from_pretrained('./model', {trust_remote_code: false});\n", [['LOCAL_MODEL_PROVENANCE_UNKNOWN', 1]]),
  fixture('Python unrelated load function', 'ordinary.py', "def load(value):\n    return value\nload('fictional.pt')\n"),
  fixture('Python malformed syntax', 'broken.py', 'def broken(:\n', [['PARSE_ERROR', 1]]),
  fixture('JavaScript unpinned remote-code model', 'model.js',
    "import { AutoModel } from '@huggingface/transformers';\nAutoModel.from_pretrained('fictional/model', {revision: 'main', trust_remote_code: true});\n",
    [['MODEL_UNPINNED', 2], ['REMOTE_CODE_ENABLED', 2]]),
  fixture('JavaScript safe pinned model alias', 'model.js',
    `import { AutoModel as Encoder } from '@huggingface/transformers';\nEncoder.from_pretrained('fictional/model', {revision: '${revision}', trust_remote_code: false});\n`),
  fixture('JavaScript unpinned import alias', 'aliases.js',
    "import { AutoModel as Encoder } from '@huggingface/transformers';\nEncoder.from_pretrained('fictional/model');\n", [['MODEL_UNPINNED', 2]]),
  fixture('TypeScript model call', 'model.ts',
    "import { AutoModel as Encoder } from '@huggingface/transformers';\nconst result: unknown = Encoder.from_pretrained('fictional/model');\n", [['MODEL_UNPINNED', 2]]),
  fixture('JavaScript dynamic reference', 'dynamic.js',
    `AutoModel.from_pretrained(modelId, {revision: '${revision}', trust_remote_code: false});\n`, [['DYNAMIC_REFERENCE', 1]]),
  fixture('JavaScript dynamic option values', 'dynamic.js',
    "AutoModel.from_pretrained('fictional/model', {revision: commit, trust_remote_code: allowCode});\n",
    [['REVISION_UNRESOLVED', 1], ['REMOTE_CODE_UNRESOLVED', 1]]),
  fixture('JavaScript spread options', 'dynamic.js',
    "AutoModel.from_pretrained('fictional/model', {...options});\n",
    [['REVISION_UNRESOLVED', 1], ['REMOTE_CODE_UNRESOLVED', 1]]),
  fixture('JavaScript dynamic options object', 'dynamic.js',
    "AutoModel.from_pretrained('fictional/model', options);\n",
    [['REVISION_UNRESOLVED', 1], ['REMOTE_CODE_UNRESOLVED', 1]]),
  fixture('JavaScript comments and string examples are not calls', 'examples.js',
    "// AutoModel.from_pretrained('fictional/comment', {trust_remote_code: true});\nconst example = \"AutoModel.from_pretrained('fictional/string')\";\n/* pickle.loads(payload); */\nconst literal = `AutoModel.from_pretrained('fictional/template')`;\n"),
  fixture('JavaScript ordinary model variable is not a pin violation', 'candidate.js', "const model = 'fictional/candidate';\n"),
  fixture('JavaScript unrelated load function', 'ordinary.js', "function load(value) { return value; }\nload('fictional.pt');\n"),
  fixture('JavaScript malformed syntax', 'broken.js', 'const = ;\n', [['PARSE_ERROR', 1]]),
  fixture('Synthetic advisory exact lock version v3', 'package-lock.json',
    '{\n  "lockfileVersion": 3,\n  "packages": {\n    "node_modules/@openaibom-fixtures/unsafe-loader": { "version": "1.0.0" }\n  }\n}\n', [['FIXTURE_ADVISORY_MATCH', 4]]),
  fixture('Synthetic advisory exact lock version v2', 'package-lock.json',
    '{\n  "lockfileVersion": 2,\n  "packages": {\n    "node_modules/@openaibom-fixtures/unsafe-loader": { "version": "1.0.0" }\n  }\n}\n', [['FIXTURE_ADVISORY_MATCH', 4]]),
  fixture('Synthetic advisory fixed lock version', 'package-lock.json',
    '{"lockfileVersion":3,"packages":{"node_modules/@openaibom-fixtures/unsafe-loader":{"version":"1.0.1"}}}\n'),
  fixture('Synthetic advisory similarly named package does not match', 'package-lock.json',
    '{"lockfileVersion":3,"packages":{"node_modules/@openaibom-fixtures/unsafe-loader-extra":{"version":"1.0.0"}}}\n'),
  fixture('Synthetic advisory declaration is not a locked version', 'package.json',
    '{"dependencies":{"@openaibom-fixtures/unsafe-loader":"1.0.0"}}\n'),
  fixture('Synthetic advisory nonexact locked version does not match', 'package-lock.json',
    '{"lockfileVersion":3,"packages":{"node_modules/@openaibom-fixtures/unsafe-loader":{"version":"^1.0.0"}}}\n')
];

const key = item => JSON.stringify([item.code, item.path, item.line]);
const sorted = items => items.sort((a, b) => key(a).localeCompare(key(b)));

export function runBenchmark({ scan = scanProject } = {}) {
  let truePositives = 0, falsePositives = 0, falseNegatives = 0, scanFailures = 0;
  const cases = fixtures.map(item => {
    const expected = sorted(item.expected.map(label => ({ ...label })));
    let actual = [], error;
    try {
      const report = scan({ projectName: `fixture-${fixtures.indexOf(item) + 1}`, files: item.files.map(file => ({ ...file })) });
      if (!report || !Array.isArray(report.findings) || !Array.isArray(report.components) || !['pass', 'review', 'fail'].includes(report.analysis?.policy?.status) || !report.analysis?.coverage) {
        throw new Error('Scanner returned an incomplete report.');
      }
      actual = sorted(report.findings.filter(f => measuredCodes.has(f.code)).map(f => evidence(f.code, f.path ?? null, f.line ?? null)));
    } catch (failure) {
      scanFailures++;
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const unmatched = new Map();
    for (const label of expected) unmatched.set(key(label), (unmatched.get(key(label)) || 0) + 1);
    let matched = 0;
    for (const label of actual) {
      const count = unmatched.get(key(label)) || 0;
      if (count) { matched++; unmatched.set(key(label), count - 1); }
    }
    truePositives += matched;
    falsePositives += actual.length - matched;
    falseNegatives += expected.length - matched;
    return { name: item.name, passed: error === undefined && matched === expected.length && matched === actual.length, expected, actual, ...(error === undefined ? {} : { error }) };
  });
  return {
    suiteVersion: '0.2.0',
    cases,
    summary: {
      passed: cases.filter(item => item.passed).length,
      total: cases.length,
      truePositives, falsePositives, falseNegatives,
      precision: truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : null,
      recall: truePositives + falseNegatives ? truePositives / (truePositives + falseNegatives) : null,
      scanFailures
    },
    scope: 'Offline, fictional, hand-labelled fixtures only. Precision and recall measure exact rule + path + line multiset matches for MODEL_UNPINNED, REMOTE_CODE_ENABLED, UNSAFE_DESERIALIZATION, DYNAMIC_REFERENCE, REVISION_UNRESOLVED, REMOTE_CODE_UNRESOLVED, LOADER_SAFETY_UNRESOLVED, LOCAL_MODEL_PROVENANCE_UNKNOWN, PARSE_ERROR and FIXTURE_ADVISORY_MATCH. Inventory-only findings are excluded. Scan errors fail cases and their expected evidence counts as missed; scanFailures is reported separately. Undefined ratios are null. These fixture-only metrics are NOT real-world accuracy, vulnerability detection rates, or evidence of runtime safety. The advisory and all identifiers are synthetic; no network or real advisory feed is used.'
  };
}
