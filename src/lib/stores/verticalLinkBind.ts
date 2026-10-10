import { writable } from 'svelte/store';
import type { VerticalKind } from '$lib/utils/verticalFacility';

export type VerticalBindSession = {
  direction: 'up' | 'down';
  kind: VerticalKind;
  name: string;
  fromFloorId: string;
  fromFloorName: string;
  toFloorId: string;
  toFloorName: string;
  fromRoomId: string;
  fromRoomName: string;
  fromX: number;
  fromY: number;
};

/** Active “点选上层/下层房间完成绑定” session in the editor. */
export const verticalBindSession = writable<VerticalBindSession | null>(null);

export const verticalBindMessage = writable<string>('');
