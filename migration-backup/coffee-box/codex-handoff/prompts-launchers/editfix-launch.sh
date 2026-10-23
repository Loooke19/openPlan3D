#!/bin/bash
while ! grep -q '^exit' /workspace/codex-editentry.status 2>/dev/null; do sleep 20; done
cd /workspace/kit-wt
codex exec -m gpt-6-sol -c model_reasoning_effort=high -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir /workspace --skip-git-repo-check "$(cat /workspace/editfix-prompt.md)" > /workspace/codex-editfix.run.log 2>&1
echo "exit $?" > /workspace/codex-editfix.status
