# Task floor3 (Luke bugs, general rules only, all buildings P1/P2/P3)
Workdir: /workspace/codex-floor3 (copy of codex-slab2 result; lineage kit-wt 5f77cdca + merge-2 + later). Follow /workspace/codex-luke-rules.md. Run /workspace/codex-stair-guard.sh after each step. Do NOT push. Ports: dev 5381, playwright 4251.
Screenshot from Luke: /home/box/agent-data/agents/4a93a8d4-0107-43c0-b4a5-6bcbfc0996a3/attachments/0fea5f2b9d8450c92d2c63853d06f23f76ec4f0d828bceca0a88d68dca36fad0.png
Bug 1: 1F shows an extra ring of floor outside the perimeter rooms that doesn't exist (suspected PDF dimension/ruler lines recognized as floor/footprint). First check whether the slab2 change (tile only rooms∪corridors) already fixed it. Find root cause (e.g. footprint in openplan_project.py) and fix with a general rule.
Bug 2: 3F floor has no texture/tiles. Find root cause, fix generally.
Testing minimal: guard, targeted tests, verify_import.
Shots (you take them, and visually confirm the bug is gone before claiming fixed): before/after of P1, P2, P3 1F overview and P1 3F floor -> /workspace/merge-5/shots/.
Export cumulative /workspace/merge-5/fe.patch and be.patch vs kit-wt 5f77cdca, plus README.md (root causes, changes, tests, shots). Write report.md in workdir. Keep it concise.

## Bug 3 (added 14:20 by Luke)
Screenshot: /home/box/agent-data/agents/4a93a8d4-0107-43c0-b4a5-6bcbfc0996a3/attachments/b0fc7f802f0d945a2ed59654f79dd8091dd64aac280c2c4caf175ae78ffb4be8.png — columns/posts in red boxes stick up above wall tops (检验大厅, 细菌室, 内窥镜室 area, merge-4). First determine what they are: PDF structural columns using storey height instead of wall height, or door-frame jamb posts / joint cylinders with wrong height. State root cause in README. Fix with a GENERAL rule (heights clamp to wall height), effective for P1/P2/P3. Guard each step. Before/after shot of that area, visually confirm.
