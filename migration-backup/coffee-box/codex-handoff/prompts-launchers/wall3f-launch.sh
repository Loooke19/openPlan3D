#!/bin/bash
until tail -1 /workspace/codex-hall.status 2>/dev/null | grep -q '^exit'; do sleep 60; done
rm -rf /workspace/codex-wall3f; git -C /workspace/kit-wt worktree add --detach /workspace/codex-wall3f 5f77cdc >/dev/null 2>&1
cd /workspace/codex-wall3f && git apply /workspace/merge-7/fe.patch || { echo "exit apply-fail $(date +%H:%M)" >> /workspace/codex-wall3f.status; exit 1; }
echo "src=wall3f $(date +%H:%M)" >> /workspace/codex-wall3f.status
codex exec -m gpt-6-sol -c model_reasoning_effort=high -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir /workspace --skip-git-repo-check "$(cat /workspace/wall3f-prompt.md)" > /workspace/codex-wall3f.run.log 2>&1
echo "exit $? $(date +%H:%M)" >> /workspace/codex-wall3f.status
