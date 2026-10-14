import { describe, expect, it } from 'vitest';
import { projectHomeUrl, projectLibraryUrl, resolveProjectLibraryUrl } from '../src/lib/utils/projectLibraryUrl';

describe('projectLibraryUrl', () => {
  it('returns the openPlan library root', () => {
    expect(projectLibraryUrl()).toBe('/');
  });

  it('sends an imported project back to its import /files card', () => {
    const params = new URLSearchParams({
      filesUrl: 'http://127.0.0.1:8884/files',
      apiOrigin: 'http://127.0.0.1:8884',
      id: 'abc',
    });
    expect(resolveProjectLibraryUrl(params, 'http://127.0.0.1:5175')).toBe('http://127.0.0.1:8884/files#p-abc');
  });

  it('projectHomeUrl prefers the import origin, else the library', () => {
    expect(projectHomeUrl('abc', 'http://127.0.0.1:8882/')).toBe('http://127.0.0.1:8882/files#p-abc');
    expect(projectHomeUrl('abc', null)).toBe('/');
  });

  it('uses the imported project source even when an old libraryUrl points to the local library', () => {
    const params = new URLSearchParams({
      libraryUrl: 'http://127.0.0.1:5175/',
      filesUrl: 'http://127.0.0.1:5175/',
      projectUrl: 'http://127.0.0.1:8884/api/projects/abc.json',
    });
    expect(resolveProjectLibraryUrl(params, 'http://127.0.0.1:5175')).toBe('http://127.0.0.1:8884/files#p-abc');
  });

  it('honors an explicit libraryUrl for a local project', () => {
    const params = new URLSearchParams({ libraryUrl: 'http://127.0.0.1:5175/projects' });
    expect(resolveProjectLibraryUrl(params, 'http://127.0.0.1:5175')).toBe('http://127.0.0.1:5175/projects');
  });
});
