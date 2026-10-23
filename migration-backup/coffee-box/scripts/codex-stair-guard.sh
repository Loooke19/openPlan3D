#!/usr/bin/env bash
# 用法: codex-stair-guard.sh <副本fe目录> [允许改动的文件相对路径...]
# 检查 kit-wt 下午的改动在副本里是否还在。不通过退出码 1。
set -u
REF=/workspace/kit-wt; DST=${1:?fe dir}; shift; ALLOW=" $* "; fail=0
V=src/lib/components/viewer3d/nav
for f in $V/kitDressing.ts $V/navDoors.ts $V/layout.ts $V/openingAudit.ts $V/dressing.ts src/app.css; do
  [ -e "$REF/$f" ] || { echo "SKIP 参考缺 $f"; continue; }
  if ! cmp -s "$REF/$f" "$DST/$f"; then
    if [[ "$ALLOW" == *" $f "* ]]; then echo "ALLOW 改动 $f"; else echo "FAIL 不一致 $f"; fail=1; fi
  fi
done
n=0; for g in "$REF"/static/nav-kit/*.glb; do n=$((n+1)); cmp -s "$g" "$DST/static/nav-kit/$(basename "$g")" || { echo "FAIL GLB $(basename "$g")"; fail=1; }; done
echo "GLB 检查 $n 个"
T=src/lib/components/viewer3d/ThreeViewer.svelte
miss=$(cd "$REF" && git diff 5f77cdc -- $T | sed -n 's/^+\([^+].*\)$/\1/p' | sed 's/^[[:space:]]*//' | rg -v '^$' | sort -u | while IFS= read -r l; do rg -qF -- "$l" "$DST/$T" || echo "$l"; done)
if [ -n "$miss" ]; then c=$(printf '%s\n' "$miss" | wc -l)
  if [[ "$ALLOW" == *" $T "* ]]; then echo "WARN ThreeViewer 丢失 kit-wt 新增行 $c 条（任务允许改，需人工核）"; else echo "FAIL ThreeViewer 丢失 kit-wt 新增行 $c 条"; fail=1; fi
  printf '%s\n' "$miss" | head -n 40 | sed 's/^/  - /'
fi
[ $fail = 0 ] && echo "GUARD PASS $DST" || echo "GUARD FAIL $DST"; exit $fail
