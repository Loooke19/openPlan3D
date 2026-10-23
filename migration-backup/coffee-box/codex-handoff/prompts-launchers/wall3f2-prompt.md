修复任务，不推送。岐阜医院 3D 导航。底版是 /workspace/merge-9 的累计补丁（相对 kit-wt 5f77cdc 和后端 1ceb251），打在新的干净副本上。
问题：P1 3F 细菌室、药剂存放处（北C）、Room 51、Room 27、中医一带的墙全挤在了一起，碎成很多小格，跟 PDF 对不上（Luke 截图：/home/box/agent-data/agents/4a93a8d4-0107-43c0-b4a5-6bcbfc0996a3/attachments/a336f5be764c3fabf573ca15cb9abb588e44afab03f0ce910795f8c98d800b85.png；PDF 是 /home/box/agent-data/agents/4a93a8d4-0107-43c0-b4a5-6bcbfc0996a3/attachments/67dd2d122f792d3756c1be797426f16ab1a921c2b5253a7705f467524cfc4afb.pdf 第 1 页，即 3F）。
要求：先把 PDF 这块放大，跟模型逐段对照，查清楚这些多出来的墙是怎么来的，比如家具框线、设备线、尺寸线被当成了墙，或者墙被重复生成、错误延长。然后用通用规则修，三栋楼所有楼层都要生效，不要按楼栋或房间 ID 写特例。
验收：每一步都跑 /workspace/codex-stair-guard.sh；这块的房间、墙、门要和 PDF 一致；跨层寻路和已有测试都要通过；之前修过的门洞、通道口、重叠墙、门厅地面、外圈地面、贴图、柱子、过道墙都不能改回去。截图从 kit-wt 拍，端口用 4311 和 5441，拍这块同机位的修复前后对比，再附一张 PDF 这块的放大图。
导出到 /workspace/merge-10/：累计 fe.patch、be.patch，加 README 和 shots。README 用中文、简短，写原因和数字。
