#!/bin/bash
cd /workspace/kit-wt
codex exec -m gpt-6-sol -c model_reasoning_effort=high -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir /workspace --skip-git-repo-check "$(cat /workspace/editfix2-prompt.md)" > /workspace/codex-editfix2.run.log 2>&1
echo "exit $?" > /workspace/codex-editfix2.status
