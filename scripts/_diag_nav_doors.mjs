import { navDoors } from '../src/lib/components/viewer3d/nav/navDoors.ts';
const API = 'http://127.0.0.1:8884';
const PID = '4a87b204fb564d1689764b226ef99312';
const doc = await (await fetch(`${API}/api/projects/${PID}.json`)).json();
const floor = doc.floors.find((f) => f.name === '3F');
const doors = navDoors(floor);
console.log(
  'on south wall',
  doors
    .filter((d) => d.wallId === 'drawn--1153_172-n')
    .map((d) => ({ id: d.id, pos: d.position, type: d.type, w: d.width })),
);
const room = floor.rooms.find((r) => r.name && r.name.includes('病房') && r.name.includes('8'));
console.log('room8 doorAt', room?.doorAt, 'walls', room?.walls);
