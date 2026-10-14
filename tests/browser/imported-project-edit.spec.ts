import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('port'));
      });
    });
    server.on('error', reject);
  });
}

test('import-service project cards open the editor for that project.json', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, [path.resolve('scripts/dev-import-server.mjs')], {
    env: { ...process.env, IMPORT_PORT: String(port), OPENPLAN_ORIGIN: baseURL || 'http://127.0.0.1:4251' },
    stdio: 'pipe',
  });
  try {
    await expect.poll(async () => {
      try {
        const response = await fetch(`${origin}/api/projects`);
        return response.ok ? 200 : response.status;
      } catch {
        return 0;
      }
    }, { timeout: 15_000 }).toBe(200);
    const listing = await (await fetch(`${origin}/api/projects`)).json();
    const project = listing.projects.find((item: { id: string }) => item.id === 'qa-project-import-safety')
      || listing.projects[0];
    expect(project?.id).toBeTruthy();
    await page.goto(`${origin}/files`);
    await expect(page.getByRole('heading', { name: '导航项目管理' })).toBeVisible();
    const card = page.locator(`[data-project-id="${project.id}"]`);
    await expect(card.getByTestId('nav-browse')).toHaveText('导航浏览');
    await expect(card.getByTestId('edit-project')).toHaveText('编辑项目');
    await card.getByTestId('edit-project').click();
    await expect(page).toHaveURL(new RegExp(`/editor\\?.*id=${encodeURIComponent(project.id)}`));
    await expect(page).toHaveURL(/projectUrl=/);
    await expect(page.getByRole('application')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: project.name })).toBeVisible();
  } finally {
    child.kill('SIGTERM');
  }
});
