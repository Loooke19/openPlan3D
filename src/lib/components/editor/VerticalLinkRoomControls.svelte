<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Floor, Project, Room } from '$lib/models/types';
  import { currentProject, setActiveFloor, selectedRoomId } from '$lib/stores/project';
  import { verticalBindSession, verticalBindMessage } from '$lib/stores/verticalLinkBind';
  import { getFloorAbove, getFloorBelow } from '$lib/utils/floors';
  import { getRoomPolygon, roomCentroid } from '$lib/utils/roomDetection';
  import {
    verticalKindFromName,
    verticalKindLabel,
    type VerticalKind,
  } from '$lib/utils/verticalFacility';
  import { editorProjectApi, fetchVerticalLinks } from '$lib/utils/verticalLinksApi';

  let {
    room,
    floor,
  }: {
    room: Room;
    floor: Floor;
  } = $props();

  let busy = $state(false);
  let summary = $state('');
  let apiMissing = $state(false);
  let project = $state<Project | null>(null);
  let kind = $state<VerticalKind>('elevator');

  onDestroy(currentProject.subscribe((value) => { project = value; }));

  const show = $derived((project?.floors.length || 0) > 1);
  const above = $derived(getFloorAbove(project));
  const below = $derived(getFloorBelow(project));

  $effect(() => {
    void room.id;
    void room.name;
    kind = verticalKindFromName(room.name) || 'elevator';
  });

  $effect(() => {
    void room.id;
    void floor.id;
    void refreshSummary();
  });

  async function refreshSummary() {
    const api = editorProjectApi();
    apiMissing = !api;
    if (!api) {
      summary = '';
      return;
    }
    try {
      const { links } = await fetchVerticalLinks(api.apiOrigin, api.projectId);
      // Prefer exact roomId; only fall back to bare landing points (no roomId).
      const mine = links.find((link) =>
        (link.stops || []).some((stop) => stop.floorId === floor.id && stop.roomId === room.id),
      ) || links.find((link) => {
        const center = centroid();
        return (link.stops || []).some(
          (stop) =>
            stop.floorId === floor.id &&
            !stop.roomId &&
            Math.hypot((stop.x ?? 0) - center.x, (stop.y ?? 0) - center.y) <= 120,
        );
      });
      if (!mine) {
        summary = '尚未绑定上下层（任意房间都可连）';
        return;
      }
      const labels = (mine.stops || [])
        .map((stop) => {
          const floorName =
            project?.floors.find((item) => item.id === stop.floorId)?.name || stop.floorId;
          return floorName;
        })
        .join(' · ');
      summary = `当前竖井：${mine.name || mine.kind}（${labels}）`;
    } catch {
      summary = '';
    }
  }

  function centroid() {
    const polygon = getRoomPolygon(room, floor.walls || []);
    return polygon.length ? roomCentroid(polygon) : { x: 0, y: 0 };
  }

  function startBind(direction: 'up' | 'down') {
    if (!project) return;
    const target = direction === 'up' ? above : below;
    if (!target) {
      verticalBindMessage.set(direction === 'up' ? '已经是最上层' : '已经是最下层');
      return;
    }
    if (!editorProjectApi()) {
      verticalBindMessage.set('当前工程未连接导入 API（需要 ?projectUrl=…）');
      return;
    }
    const center = centroid();
    if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) {
      verticalBindMessage.set('当前房间没有可用轮廓');
      return;
    }
    busy = true;
    verticalBindMessage.set('');
    verticalBindSession.set({
      direction,
      kind,
      name: room.name || verticalKindLabel(kind),
      fromFloorId: floor.id,
      fromFloorName: floor.name || floor.id,
      toFloorId: target.id,
      toFloorName: target.name || target.id,
      fromRoomId: room.id,
      fromRoomName: room.name || room.id,
      fromX: center.x,
      fromY: center.y,
    });
    selectedRoomId.set(null);
    setActiveFloor(target.id);
    busy = false;
  }
</script>

{#if show}
  <div class="vertical-bind">
    <div class="head">上下层连通</div>
    <p class="hint">
      任意房间都可绑定。一对一：本层该房间向上/向下各只能连一个；再选会改绑替换。
      整井可保留多站，不影响跨多层直达。
    </p>
    {#if apiMissing}
      <p class="warn">需要通过导入服务打开工程（带 projectUrl）才能保存连通。</p>
    {:else}
      {#if summary}<p class="summary">{summary}</p>{/if}
      <label class="kind">
        <span>连通类型</span>
        <select bind:value={kind} aria-label="连通类型">
          <option value="elevator">电梯</option>
          <option value="stairs">楼梯</option>
          <option value="escalator">扶梯</option>
        </select>
      </label>
      <div class="actions">
        <button type="button" disabled={busy || !above} onclick={() => startBind('up')}>
          连接上层
        </button>
        <button type="button" disabled={busy || !below} onclick={() => startBind('down')}>
          连接下层
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .vertical-bind {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid #e8e8e8;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .head {
    font-size: 12px;
    font-weight: 600;
    color: #374151;
  }
  .hint,
  .summary,
  .warn {
    margin: 0;
    font-size: 11px;
    line-height: 1.45;
    color: #6b7280;
  }
  .warn { color: #b45309; }
  .kind {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
    color: #6b7280;
  }
  .kind select {
    height: 30px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    background: #fff;
    color: #111827;
    font-size: 12px;
    padding: 0 8px;
  }
  .actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .actions button {
    height: 32px;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    background: #fff;
    font-size: 12px;
    color: #111827;
    cursor: pointer;
  }
  .actions button:hover:not(:disabled) {
    border-color: #93c5fd;
    background: #eff6ff;
  }
  .actions button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
