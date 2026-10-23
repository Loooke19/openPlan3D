# Task: 3F bare slab / wall stubs — general fix (round slab2)
Read and obey /workspace/codex-luke-rules.md. Work ONLY in /workspace/codex-slab2 (copy of codex-skylight = merge-3 content, git base kit-wt 5f77cdca). Do NOT push, do NOT touch kit-wt, merge-wt, codex-taskc (another Codex is running there) or other copies. Every step must pass /workspace/codex-stair-guard.sh. Ports: dev 5371, playwright 4241. Keep ThreeViewer kit lines (holeCuts, holeKeeper).

## Problem
Previous skylight fix (see TASK-skylight.md, /workspace/merge-3/README.md) only subtracted the walls_remove_box void. Its own after shot /workspace/merge-3/shots/P1-3F-after.png still shows a large bare tiled slab north of the building on P1 3F plus several isolated vertical wall stubs (user screenshot: /home/box/agent-data/agents/225d0b48-896c-41a2-89c0-087c7a1a1fea/attachments/755660dd2658311ed5e85a3b7f2a6f8b06eaf9d1504edb018c37a94f3e2eaa78.png). The 3F footprint extends north (~x149..1179, y -443..-1798) beyond any room.

## GENERAL rules (all floors/buildings, NO per-room/per-floor edits or ID branches)
1. Floor tiles AND walkable nav area exist only where rooms/corridors/walkable regions exist. Footprint regions not covered by any room/corridor/walkable region are not tiled and not walkable. (E.g. tile = union of room/corridor polygons (with small tolerance/door-gap bridging), intersected with footprint minus exclusions.) Make sure real rooms, corridors, stair/elevator areas and door thresholds keep their floors.
2. Remove isolated free-standing wall stubs not connected to any room boundary (no endpoint touching other walls/room edges, not hosting doors, not manual walls).

## Minimal testing
- guard, targeted tests for the new rules (+ existing related FE/BE tests), verify_import, build.
- P1 3F before/after with the SAME camera as merge-3 shots; then OPEN the after image and visually confirm no bare slab and no stubs remain. If any remain, iterate.
- Quick 1F/2F overview shots (P1) to confirm no regression (no missing floors in real rooms).

## Output
- Export cumulative patches to /workspace/merge-3b/: fe.patch, be.patch vs kit-wt 5f77cdca (verify they apply cleanly on clean 5f77cdca), README.md (Chinese, short: changes, results, numbers), shots/.
- Write report.md here too. If you hit a usage limit, stop and write that to report.md.
