修复任务，不推送。岐阜医院 3D 导航。底版是 /workspace/merge-6 的累计补丁（相对 kit-wt 5f77cdc 和后端 1ceb251），打在新的干净副本上。
问题：merge-5 的楼板重修（slab2）规则是只在房间和走廊里铺地面，结果 P1 1F 门厅整块地面被挖掉了（门厅在西侧入口、导医台和西药房之间，楼梯旁边；参考 Luke 给的 PDF 截图 /home/box/agent-data/agents/4a93a8d4-0107-43c0-b4a5-6bcbfc0996a3/attachments/a30d285093856d425a7d1d142a89e29f7a624cf9695e43e7a818672df3cb99de.png）。
修法：用通用规则修，门厅、大厅、候诊区等开放公共区域都要算作有效地面，三栋楼所有楼层都要生效；同时要保持 1F 外圈没有多出来的地面，不能改回去。
验收：每一步都跑 /workspace/codex-stair-guard.sh；列出三栋 12 层里原来被挖掉、这次补回来的区域及面积；外圈多余地面仍为 0；测试全部通过。截图从 kit-wt 拍，端口用 4281 和 5411，拍 P1 1F 门厅同一机位的修复前后对比。
导出到 /workspace/merge-7/：累计 fe.patch、be.patch，加上 README 和 shots。README 用中文、简短。
