# Prebuilt runtime artifacts

`paseo-0.8.0-bounds-dist.tar.gz` retains its deployment filename and now contains version **0.10.3**.
It holds the compiled output of this checkout so the daemon
can keep running from these files without keeping a build environment around.

## What is in it

The `dist` tree of every package, as produced by `npm run build:server` and
`npm run build:daemon-web-ui`:

| Path                                                                                                                       | Contents                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/dist`                                                                                                     | daemon, supervisor entrypoint, terminal worker, and the served web UI in `dist/server/web-ui` (raw plus `.gz`/`.br` precompressed copies) |
| `packages/cli/dist`                                                                                                        | `paseo` CLI used by `paseo.service`                                                                                                       |
| `packages/protocol/dist`, `packages/client/dist`, `packages/plugin/dist`, `packages/highlight/dist`, `packages/relay/dist` | workspace build outputs imported at runtime                                                                                               |
| `packages/app/dist`                                                                                                        | browser export the web UI was copied from                                                                                                 |

Built from `dafbe547d`, merging upstream stable tag `v0.10.3`; see `git log` on branch
`v0.8.0-bounds`. It carries the two
local fixes: bounded directory-suggestion scans and the 4096 MB production worker heap
ceiling (`PRODUCTION_WORKER_MAX_OLD_SPACE_MB` in `dist/scripts/supervisor-entrypoint.js`).

## Restoring it

```bash
cd /home/ubuntu/paseo-src
tar -xzf release-dist/paseo-0.8.0-bounds-dist.tar.gz
```

Extracting overwrites the `dist` trees in place. The running daemon keeps serving the web UI
from `packages/server/dist/server/web-ui`, so a restore is enough to bring a missing bundle
back (no restart needed for static assets).

Running the daemon still needs the production dependency tree in `node_modules`; the build
tooling (metro, expo, vitest, oxlint, tsgo, lefthook) is not kept in this checkout. See the
"Paseo 源码运行与构建规则" section of `/home/ubuntu/AGENTS.md` for the rebuild procedure,
which installs dependencies in a temporary directory instead.

## Why it is committed

The deployment for `paseo.service` runs straight from this checkout, and this program is not
updated often. Keeping the compiled output in git means a working daemon can be restored from
the repository alone, without a 2.8 GB dependency install and a full rebuild.
