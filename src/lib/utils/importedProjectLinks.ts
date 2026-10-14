/**
 * Links from an import-service project card into this app.
 * Generic by project id — never special-case a hospital / fixture id.
 */

export function stripSlash(origin: string): string {
  return origin.replace(/\/$/, '');
}

export function projectJsonUrl(apiOrigin: string, projectId: string): string {
  return `${stripSlash(apiOrigin)}/api/projects/${encodeURIComponent(projectId)}.json`;
}

export function filesPageUrl(apiOrigin: string, projectId?: string | null): string {
  const root = `${stripSlash(apiOrigin)}/files`;
  return projectId ? `${root}#p-${encodeURIComponent(projectId)}` : root;
}

/** Query string shared by /editor and /nav for a server-owned project.json. */
export function importedProjectQuery(apiOrigin: string, projectId: string): URLSearchParams {
  const origin = stripSlash(apiOrigin);
  return new URLSearchParams({
    id: projectId,
    projectUrl: projectJsonUrl(origin, projectId),
    apiOrigin: origin,
    filesUrl: `${origin}/files`,
  });
}

export function editorProjectHref(appBase: string, apiOrigin: string, projectId: string): string {
  const root = stripSlash(appBase || '');
  return `${root}/editor?${importedProjectQuery(apiOrigin, projectId)}`;
}

export function navProjectHref(appBase: string, apiOrigin: string, projectId: string): string {
  const root = stripSlash(appBase || '');
  return `${root}/nav?${importedProjectQuery(apiOrigin, projectId)}`;
}
