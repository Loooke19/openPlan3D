# 门框修复

## 第六轮 A 门框

通用几何规则已修正，guard 和 41 项专项测试通过。P1 对比门口 `door-1` 的共面计数从 35 降为 0，斜面、反向洞侧和净空占用均为 0。P1 1F 全层扫描仍有残余，不能宣称全层几何已清零。

根因是墙记录被独立生成、洞口约束未覆盖所有构件，以及横梁和相邻实体共享表面。本轮在现有未提交改动上继续：生成前归并共线重叠墙，重投影门窗并更新房间墙引用；共享门洞按实际矩形相交切墙、接缝圆柱、踢脚线和 kit 饰面；外来门洞只切到洞顶，保留上方墙体；横梁放在洞内并留 0.5 cm 间距。墙、门框、接缝和踢脚线表面统一求并，去除内部重复面，使用与归并一致的 0.05 cm 几何容差。

检查改为三角形与洞口体积裁剪，并增加净空占用检查；覆盖静态 kit/饰面及实例变换，按材质正反面判断可见共面。检查范围与实际生成的洞口高度一致。没有逐房间修改输入数据。

P1 规范化结果如下；门窗数量保持不变，失效门宿主为 0，门中心漂移为 0，最大宽度浮点误差为 `1.14e-13 cm`。证据见 [规范化数据](verification/doorframe-normalization.json)。

| 楼层 | 墙数：归并前 → 后 | 门数：前 → 后 | 剩余共线重叠 |
| --- | --- | --- | --- |
| 1F | 247 → 236 | 62 → 62 | 0 |
| 2F | 200 → 196 | 40 → 40 | 0 |
| 3F | 258 → 248 | 67 → 67 | 0 |

验证命令：

```bash
bash /workspace/codex-stair-guard.sh /workspace/codex-doorframe-run \
  src/lib/components/viewer3d/nav/layout.ts \
  src/lib/components/viewer3d/nav/openingAudit.ts \
  src/lib/components/viewer3d/nav/dressing.ts \
  src/lib/components/viewer3d/ThreeViewer.svelte
npx vitest run tests/nav/openingGeometry.test.ts tests/nav/doorWallFit.test.ts \
  tests/wall-profiles.test.ts tests/curved-wall-openings.test.ts
```

结果为 `GUARD PASS`，15 个 GLB 字节一致，4 个测试文件、41 项测试全部通过。专项覆盖重叠归并及引用、反向门铰链、交叉墙洞顶保留、踢脚线和圆柱切口、墙体表面求并，以及“1000 cm 实墙挡门但三角形重心在洞外”的漏检反例。记录见 [guard](verification/guard-doorframe.log) 和 [专项测试](verification/tests-doorframe.log)。guard 的 14 条 ThreeViewer 文本差异已核对：对应本轮几何/检查规则替换、重复赋值清理，以及继承的标牌字段扩展；holeCuts/holeKeeper、kit 构建、AO 和资产加载功能保留。kitDressing.ts、navDoors.ts、app.css 未改动；layout.ts、dressing.ts 延续已有改动。

截图已重拍并目视检查：[修改前](shots/sixth-A-P1-door-before.png)、[修改后](shots/sixth-A-P1-door-after.png)。原中断运行的总览/空画面未作为验收证据。两图均为 P1 1F `door-1`，1000×700，`quality=low`，相机 `[156.56942,155,1221.3]`，目标 `[156.56942,130,1021.3]`，浏览器页面错误为 0。修前预览在 4191 通过内存转换恢复中断日志中的修前规则，修后使用 dev 5321；两者使用同一最新版体积扫描。未改动 kit-wt/merge-wt，未推送。

同口径 P1 1F 全层扫描的共面计数由 **2483 → 133**，净空占用由 **9 → 6**；`offAxis/offAxisArea/inwardReveal` 均为 0。对比门口全部指标为 0。完整记录见 [修前](verification/doorframe-before.json)、[修后](verification/doorframe-after.json)。计数单位是洞口内的三角形相交对或“洞口×构件”，不等于问题门的数量。

剩余问题：全层还有墙与墙、墙与框、楼板/天花及饰面之间的 133 对共面；6 项占用包括 5 项 BoxGeometry 和 1 项邻近门框。曲墙保持已有造型，未扩大为曲墙实体布尔修复；P2/P3 未做本轮视觉验收。本轮专项验证通过，但尚未达到根因报告提出的“整层所有静态几何错误为 0”。
