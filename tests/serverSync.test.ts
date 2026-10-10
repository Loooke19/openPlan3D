import { describe, it, expect } from 'vitest';
import { reconcile } from '../src/lib/services/serverSync';

const p = (iso: string, revision?: number) => ({ id: 'x', updatedAt: new Date(iso), revision } as any);

describe('serverSync.reconcile', () => {
  it('opens the server copy when nothing is stored locally', () => {
    expect(reconcile(null, p('2026-01-01', 3), null)).toMatchObject({ use: 'remote', base: 3, conflict: false });
  });
  it('never-synced local copy: newest wins and is pushed', () => {
    expect(reconcile(p('2026-01-02'), p('2026-01-01', 1), null)).toMatchObject({ use: 'local', push: true });
    expect(reconcile(p('2026-01-01'), p('2026-01-02', 1), null)).toMatchObject({ use: 'remote', push: false });
  });
  const record = { origin: 'http://s', revision: 4, syncedAt: new Date('2026-01-05').getTime() };
  it('only the server changed: take the server copy', () => {
    expect(reconcile(p('2026-01-05'), p('2026-01-03', 6), record)).toMatchObject({ use: 'remote', base: 6 });
  });
  it('only local changed: keep local and push against the agreed revision', () => {
    expect(reconcile(p('2026-01-07'), p('2026-01-03', 4), record)).toMatchObject({ use: 'local', push: true, base: 4 });
  });
  it('both changed: keep local, raise a conflict, never push silently', () => {
    expect(reconcile(p('2026-01-07'), p('2026-01-06', 5), record)).toMatchObject({ use: 'local', push: false, conflict: true, base: 4 });
  });
});
