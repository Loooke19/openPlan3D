/** Resolve import API origin + project id from the editor URL / remembered origin. */

export type BindStop = {
  floorId: string;
  roomId?: string;
  x: number;
  y: number;
};

export type BindResult = {
  link: { id: string; kind: string; name?: string; stops?: unknown[] };
  replaced: boolean;
  links: unknown[];
};

function originOf(value: string | null | undefined): string {
  if (!value) return '';
  try {
    return new URL(value, typeof location !== 'undefined' ? location.href : 'http://127.0.0.1').origin;
  } catch {
    return '';
  }
}

export function editorProjectApi(): { apiOrigin: string; projectId: string } | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const projectUrl = params.get('projectUrl') || '';
  const apiOrigin =
    originOf(projectUrl) ||
    originOf(params.get('apiOrigin')) ||
    originOf(window.localStorage.getItem('openplan.importOrigin'));
  let projectId = params.get('id') || '';
  if (!projectId && projectUrl) {
    const match = projectUrl.match(/\/projects\/([0-9a-f]{32})/i);
    if (match) projectId = match[1];
  }
  if (!apiOrigin || !projectId) return null;
  return { apiOrigin, projectId };
}

export async function fetchVerticalLinks(apiOrigin: string, projectId: string) {
  const response = await fetch(`${apiOrigin}/api/projects/${projectId}/vertical-links.json`);
  if (!response.ok) throw new Error('links');
  return (await response.json()) as { links: Array<{ id: string; kind: string; name?: string; source?: string; stops: BindStop[] }> };
}

export async function bindAdjacentVerticalLink(
  apiOrigin: string,
  projectId: string,
  body: {
    kind?: string;
    name?: string;
    from: BindStop;
    to: BindStop;
  },
): Promise<BindResult> {
  const response = await fetch(`${apiOrigin}/api/projects/${projectId}/vertical-links/bind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({})))?.detail;
    throw new Error(typeof detail === 'string' ? detail : 'bind');
  }
  return response.json();
}
