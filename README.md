# OpenAIBOM

**Know what's inside your AI—and prove why it needs review.** An MIT-licensed, offline AI supply-chain analysis prototype. It combines syntax-based discovery, traceable policy findings, observed-reference graphs, release comparison, content fingerprints, and a reproducible benchmark. No LLM or cloud wrapper is involved.

## Run

Requires Node.js 22 or newer. Install the pinned parser dependencies once. The analysis engine, demo, and benchmark make no external enrichment or model calls. Local mode needs no cloud resources; hosted mode sends selected source from the browser to the configured server. No API keys are required.

```sh
npm ci
npm start
```

Open <http://127.0.0.1:3000>. The included VS Code **Start OpenAIBOM** task uses <http://127.0.0.1:4317> to avoid a port conflict in this workspace. To use another port from the terminal:

```sh
PORT=3001 npm start
```

Select a project folder in a directory-selection-capable browser, or run the risky/fixed offline demo. Inspect policy decisions, evidence, remediation guidance, and relationships. Save the current report as a baseline or import a previously exported v0.2.0 report for the same project name. Review state and baseline live in browser memory until exported; checkbox review does not waive a policy finding.

## Hackathon demo

1. Run the **risky** sample: a model is unpinned, remote code is enabled, a loader disables restricted deserialization, and a fictional locked package matches a synthetic advisory.
2. Show the failing policy, separate severity/confidence, and exact source lines. Nothing in the sample is executed or downloaded.
3. Inspect the observed graph and project impact. There is no invented model-to-training-dataset lineage.
4. Run the **fixed** sample against the automatically retained baseline. Show resolved policy findings and changed component revisions. Missing licenses still require review; do not call the project universally safe.
5. Run the benchmark. Show positive/negative cases and fixture-only precision/recall—not a marketing claim about real-world accuracy.
6. Export the inventory, evidence hashes, findings, graph, policy result, review state, and diff.

## Presentation

A clean, 12-slide hackathon presentation covers the problem, architecture, implemented features, innovation, demo flow, validation, limitations, deployment considerations, and future ideas:

- [Editable HTML slides](presentation/openaibom-slides.html)
- [Widescreen PDF slides](presentation/openaibom-slides.pdf)

Open the HTML directly in a browser. Use **Print / Save as PDF** to export edits, with backgrounds enabled and browser headers/footers disabled. The deck has no external assets or network dependencies. The PDF is a snapshot; regenerate it after editing the HTML. Test counts describe the verified v0.2 prototype, not accuracy on unseen projects.

The analyzer supports a public demo with both bundled samples and consent-gated visitor uploads. The Render configuration is included below; preparing these files does not create a live service. The presentation itself can be hosted as static HTML.

## Deploy the online demo on Render

Use a **Node Web Service**, not a Static Site. No database, persistent disk, model API key or Docker image is needed.

1. Put this project in a GitHub/GitLab repository you can connect to Render. Include `package-lock.json` and `render.yaml`; exclude `node_modules`, secrets, personal source projects and exported visitor reports. This workspace is not automatically published by the setup.
2. In the [Render dashboard](https://dashboard.render.com/), choose **New → Blueprint**, connect that repository, and select `render.yaml` from the repository root.
3. Review the proposed **Free** service and deploy. The build runs `npm ci && npm test && npm run check`; startup is `npm start`. Render supplies `PORT` and `RENDER_EXTERNAL_URL` automatically. The blueprint selects Node 22 and `HOSTING_MODE=public`.
4. Wait for the health check (`/api/health`) and open the generated HTTPS URL. Run risky → fixed → benchmark. Confirm six blocking findings resolve and the fixed sample still requires review.
5. To test visitor upload, read the hosted-source notice, explicitly consent, and select a small non-sensitive test project. Inspect and export its report. Never use confidential source for a public demonstration.

For a manually created Web Service, use the same build/start commands, health path and environment variables from `render.yaml`. Do not enter a guessed deployment URL. Public mode fails startup unless `APP_ORIGIN` or Render's `RENDER_EXTERNAL_URL` is a valid HTTPS origin. If using a custom domain, set `APP_ORIGIN=https://your-actual-domain` and use that URL exclusively; the origin/Host allowlist intentionally accepts one canonical origin. Restart after changing it. Do not set `APP_ORIGIN` for the standard generated Render URL.

### Hosting behavior and limits

- Local default: binds `127.0.0.1`, keeps the original local request restrictions.
- Public mode: binds `0.0.0.0` on Render's `PORT`. Render terminates HTTPS; the app checks the configured Host and requires an exact matching Origin on scan POSTs. Arbitrary forwarded-host/IP headers are not trusted. Health probes can use an internal Host only for `/api/health`.
- Visitors can use samples without upload consent. Folder uploads require a browser consent checkbox; this is a disclosure control, **not authentication**. The HTTP API is anonymous and must be treated as publicly callable.
- Source files and imported baselines are processed in memory, not executed, and not intentionally written to disk or logged by the app. The hosting provider can retain network/request metadata. There is no automatic secret redaction. Memory processing is not a guarantee of secure erasure.
- Up to two in-flight scan/upload requests per process. Each scan runs in a separate worker thread with a 10-second deadline and 128 MiB V8 old-generation limit. Worker limits are not a full OS memory sandbox. Workers stop on timeout or client disconnection; source code is parsed, never executed.
- Shared budget: 20 scan requests per minute per process, with HTTP 429 and `Retry-After`. This includes sample scans. At capacity, HTTP 503 asks visitors to retry. There is no queue or per-user fairness guarantee. The budget resets on process restart and is not shared across replicas.
- Requests allow 12 MiB including JSON/baseline overhead; source limits remain 300 files, 128 KiB/file and 1 MiB total. Request/header timeouts bound incomplete uploads. Benchmark results are computed once per process and cached in memory.
- No authentication, persistent user accounts, distributed rate limiter or production availability guarantee is included. For wider use, add appropriate access control/edge protection, review provider data policies and conduct a dedicated deployment review.

The Free plan can sleep after inactivity and may cold-start slowly; open and exercise the actual demo URL before presenting. Review [Render's current free-service limits](https://render.com/docs/free) and pricing. An always-on paid plan is optional and requires an explicit plan/billing choice. See [Render web services](https://render.com/docs/web-services) and [Blueprint specification](https://render.com/docs/blueprint-spec).

### Online acceptance check

- `/api/health` returns `status: ok`; `/api/config` says `hostingMode: public`.
- The page says source will be sent to a hosted server; upload is disabled until consent.
- Risky/fixed demo, benchmark, folder upload, baseline import and JSON export work.
- Scans from an unrelated Origin are rejected; rate/capacity errors provide retry guidance.
- Do not claim deployment complete until these checks pass on the actual Render URL.

## Explainable policy

| Rule | Evidence | Default decision |
| --- | --- | --- |
| `MODEL_UNPINNED` | Supported model loader without a literal 40-hex commit revision | Block: reproducibility policy, not a confirmed vulnerability |
| `REMOTE_CODE_ENABLED` | Explicit `trust_remote_code=True` / `true` | Block: code execution permission needs review |
| `UNSAFE_DESERIALIZATION` | `torch.load(weights_only=False)`, `pickle.load/loads`, or `joblib.load` | Block: input trust determines exploitability |
| `FIXTURE_ADVISORY_MATCH` | Exact locked fictional package version | Block in synthetic demo only; **not a real advisory** |
| Dynamic options/references, parse failures, missing licenses/provenance | Incomplete evidence | Review, never silently safe |

Policy statuses are `fail` (blocking finding), `review` (unresolved evidence), or `pass` (supported checks found no violation). There is no opaque numerical risk score. A literal revision is checked for format only; its existence is not verified. Local model paths get a provenance gap rather than a remote-revision violation. Advisory matching covers ONLY the bundled fictional `@openaibom-fixtures/unsafe-loader@1.0.0` entry, fixed in the fixture at `1.0.1`. No real dependency is declared vulnerability-free.

## Reproducibility and CI

```sh
npm run benchmark
node cli.js scan /path/to/project --out report.aibom.json
node cli.js scan /path/to/project --baseline report.aibom.json --out next.aibom.json
```

Use `node cli.js --help` for options and exit semantics. A blocking policy produces exit code 1, operational errors produce 2, and review is non-blocking unless `--fail-on-review` is set. Reports include SHA-256 fingerprints of selected files and a deterministic input digest; these establish input identity, not trusted upstream provenance or a signed attestation. Stable component/finding IDs support same-project comparisons. Findings are location-sensitive; moving calls can appear as removed/introduced findings. Removed or unparseable files can make findings disappear without fixing them—always compare coverage.

The benchmark's expected rule codes and evidence locations are hand-labeled, not derived from the engine's output. Positive and negative cases cover Python and JavaScript, aliases, comments/quoted examples, malformed syntax, dynamic values, and synthetic advisory matching. Precision/recall apply only to those fixtures and selected rules. Do not extrapolate to unseen repositories.

## Supported analysis

| Input | Output |
| --- | --- |
| `package.json` | Application metadata, declared app license, direct dependencies from dependency/dev/peer/optional sections |
| `requirements.txt`, `requirements-dev.txt`, similar names | Named Python requirements with optional extras, constraints, and environment markers |
| `package-lock.json` v2/v3 | Exact installed package versions, including transitive entries; workspace/link entries disclosed as unresolved |
| Python via Lezer syntax tree; JS/JSX/TS/TSX/MJS/CJS via Babel AST | Supported `from_pretrained`, `load_dataset`, `pipeline`, model-bearing create/generate/invoke calls, literal model assignments, and Python deserialization calls |
| `pyproject.toml` | Explicit unsupported-manifest notice; no dependency extraction yet |

Hidden paths, `node_modules`, virtual environments, build outputs, and unsupported file extensions are excluded before file contents are read. Browser scans skip and disclose oversized files; CLI scans reject them. Limits are 300 accepted files, 128 KB per file, and 1 MB total source content. A selection exceeding count or total-size limits is rejected rather than silently truncated. The HTTP request limit is 12 MB including JSON encoding overhead and a baseline (browser import limit: 5 MB).

## Privacy and scope

- Only selected supported files are sent to the Node server: loopback in local mode, or the configured HTTPS host in public mode. The engine makes no enrichment/model calls and the app adds no telemetry. Source is not executed or intentionally persisted/logged. Hosted visitors must consent before folder selection; provider metadata retention is separate.
- Do not select sensitive projects without reviewing their contents. Credentials embedded in supported source files are not automatically redacted. Exported reports include component identifiers and file paths, but not raw source.
- Source discovery is syntax-based and excludes comments/string examples. It does **not** perform scope-sensitive binding, interprocedural data flow, execution reachability, or runtime verification. Same-named APIs and alias reassignments can be misidentified. Dynamic/computed arguments are unresolved; Python formatted/escaped strings are not decoded.
- Declared dependencies and locked versions are separate inventory entries. Dependency-to-dependency resolution, Python lockfiles, and conditional-install resolution are not supported.
- Upstream licenses, model training data, and provenance are not inferred or fetched. Application and lockfile license declarations remain unverified; they are not legal conclusions.
- Risk findings are configuration evidence and policy decisions, not proof of exploitation. The graph shows project membership and observed references, not execution paths or causal training lineage.
- JSON uses the custom `openaibom-inventory` format, version `0.2.0`. It is **not** a certified SPDX or CycloneDX document. Standards-based export, real advisory integration, signed attestations, model behavioral evaluation, and scope-sensitive data-flow analysis are not implemented.
- Baselines are untrusted, user-supplied snapshots. They are validated for format/project identity, not authenticity. Evidence hashes do not redact component names or file paths.
- The server defaults to loopback-only operation. Explicit public mode supports a bounded anonymous hackathon demo on Render; it is not a production multi-tenant source-analysis service. Both modes reject unexpected Host/Origin values (apart from the inert public health probe). See hosting limits above.

## Development

```sh
npm test
npm run check
npm run benchmark
```

The implementation uses native Node HTTP, the built-in test runner, browser ES modules, and two syntax parsers. [lib/source-analysis.js](lib/source-analysis.js) extracts syntax evidence; [lib/scanner.js](lib/scanner.js) builds inventory; [lib/risk-engine.js](lib/risk-engine.js) evaluates policies, relationships, and differences; [lib/benchmark.js](lib/benchmark.js) measures fixtures; [cli.js](cli.js) supports CI; [public/](public/) provides the dashboard.

Contributions should include positive and negative fixtures, accurate source evidence, and explicit coverage limitations. Unsupported claims should never be converted into a reassuring score.

## License

[MIT](LICENSE).
