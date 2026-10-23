#!/bin/bash
echo "src=dupwall $(date +%H:%M)" >> /workspace/codex-dupwall.status
cd /workspace/codex-dupwall
codex exec -m gpt-6-sol -c model_reasoning_effort=high -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir /workspace --skip-git-repo-check "$(cat /workspace/dupwall-prompt.md)" > /workspace/codex-dupwall.run.log 2>&1
echo "exit $? $(date +%H:%M)" >> /workspace/codex-dupwall.status
