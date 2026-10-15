import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';

/** Legacy path: project home is now the app root `/`. */
export function load() {
  const root = (base || '').replace(/\/$/, '') || '';
  throw redirect(308, `${root}/`);
}
