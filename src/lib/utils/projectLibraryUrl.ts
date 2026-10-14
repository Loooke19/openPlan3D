import { base } from '$app/paths';

/** Default app home: navigation project cards (import-service list). */
export function projectLibraryUrl(): string {
  const root = (base || '').replace(/\/$/, '');
  return root ? `${root}/` : '/';
}

function libraryHash(projectId: string | null | undefined): string {
  return projectId ? `#p-${encodeURIComponent(projectId)}` : '';
}

/** Resolve a project's own library before considering a generic return URL. */
export function resolveProjectLibraryUrl(search: URLSearchParams, appOrigin: string): string {
  const projectUrl = search.get('projectUrl');
  const source = projectUrl || search.get('apiOrigin');
  if (source) {
    try {
      const url = new URL(source, appOrigin);
      const id = search.get('id') || (projectUrl && url.pathname.match(/\/api\/projects\/([^/]+)\.json$/)?.[1]);
      return projectHomeUrl(id);
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
      // An imported project's home is its import service's /files page (user review 10-10).
      if (path === '/files') return projectHomeUrl(search.get('id'));
      if (url.origin === appOrigin) return url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/` || projectLibraryUrl();
    } catch {
      /* fall through */
    }
  }
  return projectLibraryUrl();
}

/** Back to the default project list (`/` + optional `#p-<id>`). */
export function projectHomeUrl(projectId: string | null | undefined, _importOrigin?: string | null): string {
  const home = projectLibraryUrl();
  const hash = libraryHash(projectId);
  if (!hash) return home;
  const root = home.replace(/\/$/, '');
  return root ? `${root}${hash}` : `/${hash}`;
}
