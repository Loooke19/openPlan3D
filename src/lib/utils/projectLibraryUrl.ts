import { base } from '$app/paths';

/**
 * openPlan project library (「N 个项目」/「+ 新建项目」).
 * Never the import API `/files` page — that is a different product surface.
 */
export function projectLibraryUrl(): string {
  const root = (base || '').replace(/\/$/, '');
  return root ? `${root}/` : '/';
}

/**
 * Resolve a back-to-library href from nav query params.
 * Accepts `libraryUrl`, or a same-origin `filesUrl` that is not API `/files`.
 * Anything else (including `http://127.0.0.1:888x/files`) falls back to this app's `/`.
 */
export function resolveProjectLibraryUrl(search: URLSearchParams, appOrigin: string): string {
  const library = search.get('libraryUrl');
  if (library) {
    try {
      const url = new URL(library, appOrigin);
      if (url.origin === appOrigin || url.pathname === '/' || url.pathname.endsWith('/')) {
        return url.href;
      }
      return url.href;
    } catch {
      /* fall through */
    }
  }
  const files = search.get('filesUrl');
  if (files) {
    try {
      const url = new URL(files, appOrigin);
      const path = url.pathname.replace(/\/$/, '') || '/';
      // Import-API file cards — not the openPlan library.
      if (path === '/files') return projectLibraryUrl();
      if (url.origin === appOrigin) return url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/` || projectLibraryUrl();
    } catch {
      /* fall through */
    }
  }
  return projectLibraryUrl();
}
