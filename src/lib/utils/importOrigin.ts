const KEY = 'openplan.importOrigin';
const FALLBACK = 'http://127.0.0.1:8882';

function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Remember the drawing-import service a project was opened from (?projectUrl). */
export function rememberImportOrigin(projectUrl: string): void {
  const origin = originOf(projectUrl);
  if (!origin) return;
  try {
    localStorage.setItem(KEY, origin);
  } catch {
    // Storage can be disabled; the fallback origin still applies.
  }
}

/** The import service to send 导入图纸 to: this page's ?projectUrl / ?apiOrigin, the remembered one, then the default stack. */
export function importOrigin(): string {
  const params = new URL(window.location.href).searchParams;
  const fromPage = originOf(params.get('projectUrl')) || originOf(params.get('apiOrigin'));
  if (fromPage) return fromPage;
  let remembered: string | null = null;
  try {
    remembered = originOf(localStorage.getItem(KEY));
  } catch {
    remembered = null;
  }
  return remembered || originOf(import.meta.env.VITE_IMPORT_ORIGIN ?? null) || FALLBACK;
}
