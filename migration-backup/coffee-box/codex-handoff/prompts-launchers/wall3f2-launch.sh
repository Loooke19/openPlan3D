#!/bin/bash
until tail -1 /workspace/codex-gapdoor.status 2>/dev/null | grep -q '^exit'; do sleep 60; done
rm -rf /workspace/codex-wall3f2; git -C /workspace/kit-wt worktree add --detach /workspace/codex-wall3f2 5f77cdc >/dev/null 2>&1
cd /workspace/codex-wall3f2 && git apply /workspace/merge-9/fe.patch || { echo "exit apply-fail $(date +%H:%M)" >> /workspace/codex-wall3f2.status; exit 1; }
echo "src=wall3f2 $(date +%H:%M)" >> /workspace/codex-wall3f2.status
codex exec -m gpt-6-sol -c model_reasoning_effort=high -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir /workspace --skip-git-repo-check "$(cat /workspace/wall3f2-prompt.md)" > /workspace/codex-wall3f2.run.log 2>&1
echo "exit $? $(date +%H:%M)" >> /workspace/codex-wall3f2.status
