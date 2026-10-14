import { base } from '$app/paths';

/** App root; the live project list is the import-service `/files` page. */
export function projectLibraryUrl(): string {
  const root = (base || '').replace(/\/$/, '');
  return root ? `${root}/` : '/';
}

/** Resolve a project's own library before considering a generic return URL. */
export function resolveProjectLibraryUrl(search: URLSearchParams, appOrigin: string): string {
  const projectUrl = search.get('projectUrl');
  const source = projectUrl || search.get('apiOrigin');
  if (source) {
    try {
      const url = new URL(source, appOrigin);
      const id = search.get('id') || (projectUrl && url.pathname.match(/\/api\/projects\/([^/]+)\.json$/)?.[1]);
      return projectHomeUrl(id, url.origin);
    } catch {
      /* use the supplied return URL */
    }
  }
  const library = search.get('libraryUrl');
  if (library) {
    try {
      return new URL(library, appOrigin).href;
    } catch {
      /* fall through */
    }
  }
  const files = search.get('filesUrl');
  if (files) {
    try {
      const url = new URL(files, appOrigin);
      const path = url.pathname.replace(/\/$/, '') || '/';
      if (path === '/files') return projectHomeUrl(search.get('id'), url.origin);
      if (url.origin === appOrigin) return url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/` || projectLibraryUrl();
    } catch {
      /* fall through */
    }
  }
  return projectLibraryUrl();
}

/** Back target: the import-service file card list (`/files#p-<id>`). */
export function projectHomeUrl(projectId: string | null | undefined, importOrigin: string | null | undefined): string {
  if (!importOrigin) return projectLibraryUrl();
  const root = importOrigin.replace(/\/$/, '');
  return projectId ? `${root}/files#p-${encodeURIComponent(projectId)}` : `${root}/files`;
}
