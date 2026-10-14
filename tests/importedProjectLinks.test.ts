import { describe, expect, it } from 'vitest';
import { editorProjectHref, importedProjectQuery, navProjectHref, projectJsonUrl } from '../src/lib/utils/importedProjectLinks';
import { parseFilesPageProjects } from '../src/lib/utils/importedProjects';

describe('importedProjectLinks', () => {
  it('builds editor and nav hrefs from any project id without special cases', () => {
    const id = 'abcdef0123456789abcdef0123456789';
    const api = 'http://127.0.0.1:8884';
    const app = 'http://127.0.0.1:5381';
    expect(projectJsonUrl(api, id)).toBe(`${api}/api/projects/${id}.json`);
    const editor = editorProjectHref(app, api, id);
    const nav = navProjectHref(app, api, id);
    expect(editor).toContain('/editor?');
    expect(nav).toContain('/nav?');
    const editorParams = new URL(editor).searchParams;
    const navParams = new URL(nav).searchParams;
    expect(editorParams.get('id')).toBe(id);
    expect(navParams.get('id')).toBe(id);
    expect(editorParams.get('projectUrl')).toBe(`${api}/api/projects/${id}.json`);
    expect(navParams.get('projectUrl')).toBe(`${api}/api/projects/${id}.json`);
    expect(importedProjectQuery(api, 'other-id').get('id')).toBe('other-id');
  });

  it('parses import-service /files cards by data attributes', () => {
    const html = `
      <article id="p-one" data-project-name="门诊楼">x</article>
      <article id="p-two" data-project-name="住院楼">y</article>`;
    expect(parseFilesPageProjects(html)).toEqual([
      { id: 'one', name: '门诊楼' },
      { id: 'two', name: '住院楼' },
    ]);
  });
});
