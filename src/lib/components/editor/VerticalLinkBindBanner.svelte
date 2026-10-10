<script lang="ts">
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import {
    activeFloor,
    currentProject,
    selectedRoomId,
    setActiveFloor,
    detectedRoomsStore,
  } from '$lib/stores/project';
  import { verticalBindSession, verticalBindMessage } from '$lib/stores/verticalLinkBind';
  import { bindAdjacentVerticalLink, editorProjectApi } from '$lib/utils/verticalLinksApi';
  import { verticalKindLabel } from '$lib/utils/verticalFacility';
  import { resolveRooms, getRoomPolygon, roomCentroid } from '$lib/utils/roomDetection';
  import type { Floor } from '$lib/models/types';

  let session = $state<ReturnType<typeof get<typeof verticalBindSession>>>(null);
  let message = $state('');
  let busy = $state(false);
  let floor = $state<Floor | null>(null);
  let selRoomId: string | null = $state(null);
  let detectedRooms = $state<any[]>([]);
  let lastHandled = '';

  onDestroy(verticalBindSession.subscribe((value) => { session = value; lastHandled = ''; }));
  onDestroy(verticalBindMessage.subscribe((value) => { message = value; }));
  onDestroy(activeFloor.subscribe((value) => { floor = value; }));
  onDestroy(selectedRoomId.subscribe((value) => { selRoomId = value; }));
  onDestroy(detectedRoomsStore.subscribe((value) => { detectedRooms = value; }));

  $effect(() => {
    if (!session || busy || !floor || !selRoomId) return;
    if (floor.id !== session.toFloorId) return;
    if (selRoomId === session.fromRoomId && floor.id === session.fromFloorId) return;
    const key = `${session.fromFloorId}:${session.fromRoomId}->${floor.id}:${selRoomId}`;
    if (key === lastHandled) return;
    lastHandled = key;
    void completeBind(selRoomId);
  });

  async function completeBind(roomId: string) {
    if (!session || !floor) return;
    const room = resolveRooms(floor, detectedRooms).find((item) => item.id === roomId);
    if (!room) return;
    const polygon = getRoomPolygon(room, floor.walls || []);
    if (!polygon.length) {
      verticalBindMessage.set('点选的房间没有可用轮廓');
      return;
    }
    const center = roomCentroid(polygon);
    const api = editorProjectApi();
    if (!api) {
      verticalBindMessage.set('当前工程未连接导入 API（需要 ?projectUrl=…）');
      return;
    }
    busy = true;
    try {
      const result = await bindAdjacentVerticalLink(api.apiOrigin, api.projectId, {
        kind: session.kind,
        name: session.name || room.name || verticalKindLabel(session.kind),
        from: {
          floorId: session.fromFloorId,
          roomId: session.fromRoomId,
          x: session.fromX,
          y: session.fromY,
        },
        to: {
          floorId: session.toFloorId,
          roomId: room.id,
          x: center.x,
          y: center.y,
        },
      });
      const targetName = room.name || room.id;
      const verb = result.replaced ? '已改绑' : '已绑定';
      const backId = session.fromFloorId;
      const backRoomId = session.fromRoomId;
      const fromLabel = session.fromRoomName || session.fromRoomId;
      const fromFloorName = session.fromFloorName;
      const toFloorName = session.toFloorName;
      verticalBindMessage.set(
        `${verb} ${fromFloorName}「${fromLabel}」⇄ ${toFloorName}「${targetName}」（一对一替换）`,
      );
      verticalBindSession.set(null);
      setActiveFloor(backId);
      selectedRoomId.set(backRoomId);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'bind';
      const errors: Record<string, string> = {
        adjacent: '只能连接相邻楼层',
        floor: '楼层无效',
        stop: '房间坐标无效',
        full: '连通数量已满',
      };
      verticalBindMessage.set(errors[code] || '绑定失败');
    } finally {
      busy = false;
    }
  }

  function cancel() {
    if (!session) return;
    const backId = session.fromFloorId;
    verticalBindSession.set(null);
    setActiveFloor(backId);
    verticalBindMessage.set('已取消连接');
  }
</script>

{#if session}
  <div class="bind-banner" role="status">
    <div class="bind-text">
      <strong>连接{session.direction === 'up' ? '上层' : '下层'}</strong>
      <span>
        已选 {session.fromFloorName}「{session.fromRoomName || session.fromRoomId}」·
        请在 {session.toFloorName} 平面图上点选任意房间完成绑定。
        若该侧已有绑定，将直接改绑替换（一对一）。
      </span>
    </div>
    <button type="button" class="cancel" disabled={busy} onclick={cancel}>取消</button>
  </div>
{:else if message}
  <div class="bind-toast" role="status">{message}</div>
{/if}

<style>
  .bind-banner,
  .bind-toast {
    position: absolute;
    left: 50%;
    top: 12px;
    transform: translateX(-50%);
    z-index: 40;
    max-width: min(720px, calc(100% - 24px));
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-radius: 10px;
    background: #0f2744;
    color: #f5f8fc;
    box-shadow: 0 8px 24px rgba(15, 39, 68, 0.28);
    font-size: 13px;
    line-height: 1.45;
  }
  .bind-toast {
    background: #173a2a;
  }
  .bind-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .bind-text strong { font-size: 13px; }
  .bind-text span { opacity: 0.92; }
  .cancel {
    flex: none;
    height: 32px;
    padding: 0 12px;
    border: 1px solid rgba(255, 255, 255, 0.35);
    border-radius: 8px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .cancel:hover { background: rgba(255, 255, 255, 0.08); }
</style>
