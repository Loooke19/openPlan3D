#!/bin/bash
echo "src=floor3b $(date +%H:%M)" >> /workspace/codex-floor3.status
cd /workspace/codex-floor3b
codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -c service_tier=default -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir /workspace --skip-git-repo-check "$(cat /workspace/floor3b-prompt.md)" > /workspace/codex-floor3b.run.log 2>&1
echo "exit $? $(date +%H:%M)" >> /workspace/codex-floor3.status
