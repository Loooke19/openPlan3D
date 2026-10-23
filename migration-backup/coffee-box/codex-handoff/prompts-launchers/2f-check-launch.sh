#!/bin/bash
echo "src=2f-check $(date +%H:%M)" >> /workspace/codex-2f-check.status
cd /workspace/codex-2f-check
codex exec -m gpt-6-sol -c model_reasoning_effort=high -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir /workspace --skip-git-repo-check "$(cat /workspace/2f-check-prompt.md)" > /workspace/codex-2f-check.run.log 2>&1
echo "exit $? $(date +%H:%M)" >> /workspace/codex-2f-check.status
