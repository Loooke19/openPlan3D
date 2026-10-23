#!/bin/bash
while kill -0 341627 2>/dev/null; do sleep 20; done
SRC=/workspace/codex-slab2
[ -f /workspace/merge-3b/fe.patch ] && grep -qiE "exit 0|done|complete" <(tail -c 3000 /workspace/codex-slab2.run.log) || SRC=/workspace/codex-skylight
echo "src=$SRC $(date +%H:%M)" > /workspace/codex-floor3.status
rsync -a --exclude node_modules/.cache "$SRC"/ /workspace/codex-floor3/
cd /workspace/codex-floor3
codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -c service_tier=default -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir /workspace --skip-git-repo-check "$(cat /workspace/floor3-task.md)" > /workspace/codex-floor3.run.log 2>&1
echo "exit $? $(date +%H:%M)" >> /workspace/codex-floor3.status
