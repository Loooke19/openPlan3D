#!/bin/bash
until tail -1 /workspace/codex-dupwall.status 2>/dev/null | grep -q '^exit'; do sleep 60; done
rm -rf /workspace/codex-hall; git -C /workspace/kit-wt worktree add --detach /workspace/codex-hall 5f77cdc >/dev/null 2>&1
cd /workspace/codex-hall && git apply /workspace/merge-6/fe.patch || { echo "exit apply-fail $(date +%H:%M)" >> /workspace/codex-hall.status; exit 1; }
echo "src=hall $(date +%H:%M)" >> /workspace/codex-hall.status
codex exec -m gpt-6-sol -c model_reasoning_effort=high -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir /workspace --skip-git-repo-check "$(cat /workspace/hall-prompt.md)" > /workspace/codex-hall.run.log 2>&1
echo "exit $? $(date +%H:%M)" >> /workspace/codex-hall.status
