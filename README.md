# makefun-git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/woodhntr1-gif/makefun-git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/woodhntr1-gif/makefun-git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, standard library only, no git binary required at runtime: git smart HTTP (protocol v2 and v0, receive-pack pushes with fast-forward enforcement), the REST v3 API (repos, contents, issues, pull requests, search, notifications, webhooks), a GraphQL subset with introspection, and an MCP endpoint, all served from one in-memory store. Built by an AI agent for make.fun's [Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01) bounty, $500 in USDC. Official kit conformance: 120/120 checks pass, best score 990/1000.

## Run it

```sh
node --experimental-strip-types main.ts
```

The trial lifecycle entrypoint expects `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` in the environment (the grader injects them): it binds an ephemeral port, registers with the environment, serves until `/done`, and exits 0.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rez34v58&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

---

# Git Forge — a GitHub-compatible forge in one Node process

A standalone, no-UI git forge for the make.fun bounty
[github-core-clone-01](https://make.fun/bounty/github-core-clone-01).
One Node 22 process, standard library only, no `git` binary required at
runtime, serving four surfaces from a single in-memory store:

- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch` with shallow/deepen/
  unshallow, wait-for-done negotiation) and v0 fetch, plus `receive-pack`
  pushes with side-band report-status. Full object model implemented from
  scratch: SHA-1 objects, trees, pack read (incl. OFS/REF deltas) and pack
  write, fast-forward enforcement, annotated tags, symref HEAD.
- **REST v3** (`/api/v3`) — repos (CRUD, contents API, branches, commits,
  git refs/trees/blobs), issues + comments + labels, pull requests (list,
  files, squash/merge with conflict detection → 405), users, search
  (`/search/issues`, `/search/repositories`, full-word matching),
  notifications incl. the `/read` collection with idempotent
  mark-all-read, and webhooks (CRUD + best-effort event delivery).
- **GraphQL** (`/api/graphql`) — a small parser/executor covering the
  checked GitHub shapes: `viewer`, `repository` fields, issues/pulls
  connections with cursor pagination, `node(id:)`, mutations
  (`createIssue`, `closeIssue`, `reopenIssue`, `addComment`,
  `createPullRequest`, `mergePullRequest`), batched operations, and the
  `__type` introspection field lists for Issue/PullRequest/Repository/
  SearchType.
- **MCP** (`/mcp`, JSON-RPC) — `initialize` (legacy handshake; unknown
  methods incl. `server/discover` → `-32601`), `tools/list`, `tools/call`
  with `create_repo`, `get_repo`, `list_repos`, `create_issue`,
  `list_issues`, `get_issue`, `update_issue`, `create_pull_request`,
  `list_pull_requests`, `get_pull_request`, `merge_pull_request`.

Auth: every API/MCP call requires `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
(the trial injects it); git endpoints accept the same bearer. The scenario
viewer is derived deterministically from the trial's scenario seed.

## Files

| File | Role |
| --- | --- |
| `main.ts` | Trial lifecycle entrypoint (kit contract, own implementation): bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`, poll `GET /done`, exit 0. Exits 1 when `MAKEFUN_ENV_URL` is unset. |
| `app.ts` | The entire forge (store, git protocol, REST, GraphQL, MCP). |
| `package.json`, `tsconfig.json`, `LICENSE` | Kit scaffolding (Apache-2.0). |

Total source ≈ 145 KB (limits: 16 MiB total / 8 MiB per file).

## Run

Trial (what the grader does):

```sh
node /bot/main.ts        # with MAKEFUN_ENV_URL + MAKEFUN_SHOP_TOKEN set
```

Locally, the same entrypoint works against any env that implements
`/register` + `/done`; for ad-hoc poking, serve `createApp()` from `app.ts`
on any port and use header `Authorization: Bearer <token>`.

## Test results (official kit, this machine, 17 Nov 2026)

Runner: `node --experimental-strip-types sdk/run.ts --url <forge> --token <t> [--perf]`
from the official `github-core-clone-01` kit.

**Conformance: 120 / 120 checks pass**, through both a test driver and the
real `main.ts` lifecycle (stub env → register → suite → `/done` → exit 0).
Re-verified on 17 Nov 2026 with the re-authored `main.ts`: the full suite
again passed 120/120 through the real lifecycle against a stub env
(feature 600, agent 200; perf not re-run in that pass).

| Group | Passed |
| --- | --- |
| git | 30 / 30 |
| repos | 15 / 15 |
| issues | 15 / 15 |
| pulls | 20 / 20 |
| graphql | 20 / 20 |
| mcp | 15 / 15 |
| protocol | 5 / 5 |

**Score columns (best run): feature 600/600, agent (MCP) 200/200,
perf 190/200 → 990/1000.** Perf p50s on this shared VM (kit calibration
T_ref in parens): push 200×1 KiB commits 369 ms (1641), 50 concurrent
shallow clones 80 ms (267), 2000 issue reads 838 ms (2760), 200 issue
creates 106 ms (349). A repeat run under load scored perf 151 — the
workloads are 3–25× under calibration, but exact perf points vary with
machine noise.

**Real git interop** (git 2.43, beyond the kit's client): `git push`,
`git clone`, commit-in-clone → push, and fetch+merge round-trip all work
over HTTP with the bearer header. (One fix came from this: after the
client sends `done`, no `acknowledgments` section may precede the
packfile — the kit's client tolerates it, real git does not.)

## Known gaps (honest list)

- **In-memory store only.** State resets when the process exits; the trial
  is a single process per instance, so nothing persists across instances.
- **Packs are sent undeltified** (valid, just larger); received packs may
  use OFS/REF deltas and are applied correctly.
- **Pushes are fast-forward-only**; force pushes are refused with
  `non-fast-forward`, matching the suite. No `packfile-URIs`, no
  multi-ack negotiation rounds beyond common-commit ACK.
- **GraphQL is a subset**: the fields/types the kit exercises are exact;
  fields far outside that surface return GraphQL errors rather than data.
- **Search** is full-word matching over title/body with the common
  qualifiers (`repo:`, `is:`, `type:`, `state:`, `label:`, `author:`);
  it is not a full GitHub search-syntax engine.
- **Webhooks** are stored and delivered best-effort once (no retry queue,
  no HMAC signature header).
- **One identity**: the bearer token acts as the scenario viewer; there is
  no per-user permission model beyond owner/stranger repo visibility for
  private repos.
