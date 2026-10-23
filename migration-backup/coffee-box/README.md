# coffee-box migration backup (2026-10-23)

Snapshot of the hospital 3D-nav work that existed only on the Grok Bot box (`/workspace`), taken before switching Cursor accounts.
Base branch: `coffee/nav-merge8-1014` (FE 0042023 / BE 9ff42a0, already pushed). **No business code was changed**; everything here is copied files, patches and reports only.

Rules used: no `node_modules`, `.git`, build/dist/.svelte-kit outputs, `.env*`, or files >50MB. Secret scan with rg (GitHub/OpenAI/AWS/Slack/Google key patterns, private keys, Bearer tokens, `*_TOKEN=`/`*_KEY=` assignments, user:pass URLs) found only false positives (base64 inside vendored pdf.js worker).

| Path | What it is |
|---|---|
| `editentry/` | Codex investigation: why the project-management page lost its "edit" entry (`REPORT.md`). |
| `editfix/` | Codex fix #1 for the edit entry on FE `kit-wt` (`fe.patch`, `REPORT.md`, screenshot). |
| `editfix2/` | Codex fix #2: "编辑项目" button on BE `/files` cards (`be.patch`, `fe.patch`, `REPORT.md`, screenshot). |
| `merge-9/` | Interrupted merge-9 round: `work/{base,new,new2,new3,final}/P*.json` nav data and before/after `shots/`. |
| `codex-gapdoor-be/` | BE worktree (base `1ceb251`) from the gap-door Codex task, copied without `.git`; contains uncommitted changes (see `worktree-diffs/codex-gapdoor-be/` for the exact diff). |
| `push-handoff/1014/` | Git bundles `openPlan3D-coffee.bundle`, `gifu-be-coffee.bundle` from the 10/14 push handoff, plus `*-commits.txt` lists. |
| `scripts/codex-stair-guard.sh` | Guard script checking that `kit-wt` afternoon changes survive in a Codex copy (refs `/workspace/kit-wt`, base 5f77cdc). |
| `codex-handoff/prompts-launchers/` | Codex task prompts (`*-prompt.md`, `floor3-task.md`, `round6*.md`, `codex-luke-rules.md`, `codex-stair-common.md`) and launch scripts. |
| `codex-handoff/run-status/` | `codex-*.status` final status lines of each Codex run. |
| `codex-handoff/codex-reports/` | `report.md` / `task.md` / `brief.md` / `TASK-*.md` / patches from each `/workspace/codex-*` run dir. |
| `codex-handoff/merge-history/` | `fe.patch` / `be.patch` / reports of merge rounds merge-1015, merge-2..merge-8 (screenshots omitted). |
| `codex-handoff/top-level-patches/`, `patches-dir/` | Standalone patches (door-sign, route-arrow, wall-color, gifu-route-perf, zone/route fixes, kit-p1). |
| `codex-handoff/navi-progress-1014/` | 10/14 progress notes: handoff, codex todo, compare/version notes, first-person shot scripts + shots. |
| `codex-handoff/integ-work/` | 2F/3F integration diffs. |
| `worktree-diffs/<worktree>/` | For every dirty git worktree under `/workspace`: `HEAD.txt` (path, remote, base commit), `status.txt`, `tracked.stat`, `tracked.diff` (`git diff HEAD`), `untracked-all.txt`, and `untracked.tar.gz` (untracked text files ≤1MB). Restore: `git checkout <HEAD> && git apply tracked.diff && tar xzf untracked.tar.gz`. Notes in `HEAD.txt` mark where large embedded copies (`be/`, `verification/`, `work/`, `shots/`) or binary hunks were left out. Key ones: `kit-wt` (FE main working copy), `codex-stair-*`, `codex-gapdoor*`, `editfix2-be`, `gifu-hospital-3d-tour`. |

Not included (too large / regenerable): Codex `*.run.log` files (up to 4MB each), `qa-build-*`/`qa-gifu-*` clean checkouts (no local changes), full worktree copies with embedded `be/` and `verification/` trees, `.secrets/`, `gh-login.log`, wheel files, `mini-viewer-dist.zip`.
