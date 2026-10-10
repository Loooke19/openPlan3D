/**
 * Write-back of editor saves to the drawing-import server (`PUT {origin}/api/projects/{id}.json`).
 *
 * The browser library (IndexedDB) stays the first, always-local save. A project that came from the
 * import server is then pushed there (debounced) with optimistic concurrency: the server keeps a
 * monotonic `revision`; a stale `baseRevision` gets 409 + the server copy and the user chooses —
 * nothing is ever overwritten silently. Network failures retry with backoff and on `online`.
 */
import { writable, get } from 'svelte/store';
import type { Project } from '$lib/models/types';

export type SyncState = 'off' | 'pending' | 'syncing' | 'synced' | 'offline' | 'conflict';
export type SyncRecord = { origin: string; revision: number; syncedAt: number };
export type SyncConflict = { projectId: string; revision: number; server: unknown };

export const syncState = writable<SyncState>('off');
export const syncConflict = writable<SyncConflict | null>(null);
export const lastSyncedAt = writable<Date | null>(null);

const KEY = (id: string) => `openplan.serverSync.${id}`;
const DEBOUNCE_MS = 1500;
const MAX_BACKOFF_MS = 60_000;

let bound: { id: string; origin: string } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let backoff = 2000;
let inFlight: Promise<void> | null = null;
let again = false;
let getProject: () => Project | null = () => null;

export const timeOf = (p: { updatedAt?: unknown } | null | undefined) =>
  p?.updatedAt ? new Date(p.updatedAt as string).getTime() || 0 : 0;

export function readRecord(id: string): SyncRecord | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY(id)) || 'null');
    return r && typeof r.revision === 'number' && typeof r.origin === 'string' ? r : null;
  } catch { return null; }
}

function writeRecord(id: string, record: SyncRecord) {
  try { localStorage.setItem(KEY(id), JSON.stringify(record)); } catch { /* storage off: in-memory only */ }
}

export function revisionOf(remote: unknown): number {
  const r = Number((remote as { revision?: unknown } | null)?.revision);
  return Number.isFinite(r) ? r : 0;
}

/** Start syncing this project to `origin`, whose last agreed revision is `revision`. */
export function bindServerSync(id: string, origin: string, revision: number, source: () => Project | null, syncedAt?: number) {
  bound = { id, origin };
  getProject = source;
  const prev = readRecord(id);
  writeRecord(id, { origin, revision, syncedAt: syncedAt ?? prev?.syncedAt ?? 0 });
  syncState.set('synced');
  syncConflict.set(null);
}

export function unbindServerSync() {
  bound = null;
  if (timer) clearTimeout(timer);
  timer = null;
  syncState.set('off');
  syncConflict.set(null);
}

export function boundProjectId() { return bound?.id ?? null; }

/** Called after every successful local save. */
export function scheduleServerSync(delay = DEBOUNCE_MS) {
  if (!bound || get(syncState) === 'conflict') return;
  syncState.set('pending');
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void pushNow(); }, delay);
}

/** Push the current project. `force` = the user chose "keep mine" in a conflict. */
export async function pushNow(force = false): Promise<void> {
  if (!bound) return;
  if (inFlight) { again = true; return inFlight; }
  inFlight = (async () => {
    const target = bound!;
    const project = getProject();
    if (!project || project.id !== target.id) return;
    const record = readRecord(target.id);
    const conflict = get(syncConflict);
    const baseRevision = force && conflict ? conflict.revision : record?.revision ?? 0;
    syncState.set('syncing');
    let response: Response;
    try {
      response = await fetch(`${target.origin}/api/projects/${encodeURIComponent(target.id)}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, baseRevision, force }),
      });
    } catch {
      return offline();
    }
    if (bound?.id !== target.id) return;
    if (response.status === 409) {
      const body = await response.json().catch(() => ({}));
      syncConflict.set({ projectId: target.id, revision: revisionOf(body), server: body.project });
      syncState.set('conflict');
      return;
    }
    if (!response.ok) return offline();
    const body = await response.json();
    writeRecord(target.id, { origin: target.origin, revision: revisionOf(body), syncedAt: timeOf(project) });
    backoff = 2000;
    syncConflict.set(null);
    lastSyncedAt.set(new Date());
    syncState.set(timer ? 'pending' : 'synced');
  })();
  try { await inFlight; } finally {
    inFlight = null;
    if (again) { again = false; if (get(syncState) !== 'conflict') void pushNow(); }
  }
}

function offline() {
  syncState.set('offline');
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void pushNow(); }, backoff);
  backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { if (bound && get(syncState) === 'offline') { backoff = 2000; void pushNow(); } });
}

/** "Use the server version": the caller loads `server` into the editor; record its revision. */
export function acceptServerRevision(id: string, revision: number, project: Project) {
  const record = readRecord(id);
  if (record) writeRecord(id, { ...record, revision, syncedAt: timeOf(project) });
  syncConflict.set(null);
  syncState.set('synced');
}

/**
 * Pick the copy to open. `local` = IndexedDB copy, `remote` = server copy.
 * Returns which to load, whether local edits must be pushed, and whether both sides changed.
 */
export function reconcile(local: Project | null, remote: Project, record: SyncRecord | null) {
  const remoteRev = revisionOf(remote);
  if (!local) return { use: 'remote' as const, push: false, conflict: false, base: remoteRev };
  if (!record) {
    // Never synced from this browser: newest wins (local edits predate write-back).
    const localNewer = timeOf(local) > timeOf(remote);
    return { use: localNewer ? 'local' as const : 'remote' as const, push: localNewer, conflict: false, base: remoteRev };
  }
  const remoteChanged = remoteRev > record.revision;
  const localChanged = timeOf(local) > record.syncedAt;
  if (remoteChanged && localChanged) return { use: 'local' as const, push: false, conflict: true, base: record.revision };
  if (remoteChanged) return { use: 'remote' as const, push: false, conflict: false, base: remoteRev };
  return { use: 'local' as const, push: localChanged, conflict: false, base: record.revision };
}

export function boundOrigin() { return bound?.origin ?? null; }
