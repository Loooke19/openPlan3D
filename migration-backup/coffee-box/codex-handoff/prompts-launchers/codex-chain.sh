#!/bin/bash
cd /workspace
for n in 4 5 6; do
  codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -s workspace-write -c sandbox_workspace_write.network_access=true --add-dir /workspace --skip-git-repo-check -C /workspace/codex-ab-on-kit "按 /workspace/codex-ab-on-kit/round$n.md 做第${n}轮。" </dev/null > codex-ab-on-kit.run$n.log 2>&1
  echo "round $n exit $? $(date +%H:%M)" >> codex-chain.status
done
