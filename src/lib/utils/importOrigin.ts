const KEY = 'openplan.importOrigin';
const BY_PROJECT = 'openplan.importOrigin.byProject';
const FALLBACK = 'http://127.0.0.1:8884';

export function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function readMap(): Record<string, string> {
  try {
    const map = JSON.parse(localStorage.getItem(BY_PROJECT) || '{}');
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

/**
 * Remember the drawing-import service a project was opened from (?projectUrl).
 * Stored per project: one global key flipped between stacks (old worktree on another port,
 * a second server) and sent 「导入图纸 / 打开已生成的文件」 to whichever server opened a project last.
 */
export function rememberImportOrigin(projectUrl: string, projectId?: string): void {
  const origin = originOf(projectUrl);
  if (!origin) return;
  try {
    localStorage.setItem(KEY, origin);
    if (projectId) {
      const map = readMap();
      map[projectId] = origin;
      localStorage.setItem(BY_PROJECT, JSON.stringify(map));
    }
  } catch {
    // Storage can be disabled; the URL ?apiOrigin and fallback origin still apply.
  }
}

/** Import service that owns a given project, if this browser opened it from one. */
export function projectImportOrigin(projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  return originOf(readMap()[projectId]);
}

/** The import service to send 导入图纸 to: this page's ?projectUrl / ?apiOrigin, the project's own service, the last one, then the default stack. */
export function importOrigin(): string {
  const params = new URL(window.location.href).searchParams;
  const fromPage = originOf(params.get('projectUrl')) || originOf(params.get('apiOrigin'));
  if (fromPage) return fromPage;
  let remembered: string | null = null;
  try {
    remembered = projectImportOrigin(params.get('id')) || originOf(localStorage.getItem(KEY));
  } catch {
    remembered = null;
  }
  return remembered || originOf(import.meta.env.VITE_IMPORT_ORIGIN ?? null) || FALLBACK;
}
