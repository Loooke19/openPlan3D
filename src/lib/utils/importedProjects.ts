import { stripSlash } from './importedProjectLinks';

export type ImportedProject = {
  id: string;
  name: string;
  updatedAt?: string;
  floorCount?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalize(value: unknown): ImportedProject | null {
  const row = asRecord(value);
  const id = typeof row?.id === 'string' ? row.id.trim() : '';
  if (!id) return null;
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id;
  const updatedAt = typeof row.updatedAt === 'string' ? row.updatedAt
    : typeof row.updated_at === 'string' ? row.updated_at
    : undefined;
  const floors = row.floors;
  const floorCount = typeof row.floorCount === 'number' ? row.floorCount
    : typeof row.floor_count === 'number' ? row.floor_count
    : Array.isArray(floors) ? floors.length
    : undefined;
  return { id, name, updatedAt, floorCount };
}

function listFromPayload(data: unknown): ImportedProject[] {
  if (Array.isArray(data)) return data.map(normalize).filter((item): item is ImportedProject => !!item);
  const row = asRecord(data);
  const nested = row?.projects ?? row?.items ?? row?.files;
  if (Array.isArray(nested)) return nested.map(normalize).filter((item): item is ImportedProject => !!item);
  return [];
}

/** Cards on the import-service /files page: id="p-{id}" plus data-project-name. */
export function parseFilesPageProjects(html: string): ImportedProject[] {
  const found = new Map<string, ImportedProject>();
  const tagged = html.matchAll(/id="p-([^"]+)"[^>]*data-project-name="([^"]*)"/gi);
  for (const match of tagged) {
    const id = decodeURIComponent(match[1]);
    if (!id || found.has(id)) continue;
    found.set(id, { id, name: match[2] || id });
  }
  const loose = html.matchAll(/id="p-([^"]+)"/gi);
  for (const match of loose) {
    const id = decodeURIComponent(match[1]);
    if (!id || found.has(id)) continue;
    found.set(id, { id, name: id });
  }
  return [...found.values()];
}

export async function fetchImportedProjects(apiOrigin: string, fetcher: typeof fetch = fetch): Promise<ImportedProject[]> {
  const origin = stripSlash(apiOrigin);
  for (const path of ['/api/projects', '/api/projects.json']) {
    try {
      const response = await fetcher(`${origin}${path}`);
      if (!response.ok) continue;
      const list = listFromPayload(await response.json());
      if (list.length) return list;
    } catch {
      /* try the next listing endpoint */
    }
  }
  try {
    const response = await fetcher(`${origin}/files`);
    if (response.ok) return parseFilesPageProjects(await response.text());
  } catch {
    /* import service unreachable */
  }
  return [];
}
