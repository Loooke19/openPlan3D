#!/bin/bash
until tail -1 /workspace/codex-wall3f.status 2>/dev/null | grep -q '^exit'; do sleep 60; done
rm -rf /workspace/codex-gapdoor; git -C /workspace/kit-wt worktree add --detach /workspace/codex-gapdoor 5f77cdc >/dev/null 2>&1
cd /workspace/codex-gapdoor && git apply /workspace/merge-8/fe.patch || { echo "exit apply-fail $(date +%H:%M)" >> /workspace/codex-gapdoor.status; exit 1; }
echo "src=gapdoor $(date +%H:%M)" >> /workspace/codex-gapdoor.status
codex exec -m gpt-6-sol -c model_reasoning_effort=high -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir /workspace --skip-git-repo-check "$(cat /workspace/gapdoor-prompt.md)" > /workspace/codex-gapdoor.run.log 2>&1
echo "exit $? $(date +%H:%M)" >> /workspace/codex-gapdoor.status
