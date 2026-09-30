import { describe, expect, it } from 'vitest';
import { projectLibraryUrl, resolveProjectLibraryUrl } from '../src/lib/utils/projectLibraryUrl';

describe('projectLibraryUrl', () => {
  it('returns the openPlan library root', () => {
    expect(projectLibraryUrl()).toBe('/');
  });

  it('ignores import-API /files and stays on the library', () => {
    const params = new URLSearchParams({
      filesUrl: 'http://127.0.0.1:8884/files',
      apiOrigin: 'http://127.0.0.1:8884',
    });
    expect(resolveProjectLibraryUrl(params, 'http://127.0.0.1:5175')).toBe('/');
  });

  it('honors an explicit libraryUrl', () => {
    const params = new URLSearchParams({
      libraryUrl: 'http://127.0.0.1:5175/',
      filesUrl: 'http://127.0.0.1:8884/files',
    });
    expect(resolveProjectLibraryUrl(params, 'http://127.0.0.1:5175')).toBe('http://127.0.0.1:5175/');
  });
});
