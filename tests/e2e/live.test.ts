import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { mkdtemp, writeFile, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const RUN_E2E = process.env.HULL_E2E === '1';
const projectRoot = join(__dirname, '../..');

describe.skipIf(!RUN_E2E)('Live E2E', () => {
  let tempHome: string;
  let config: { endpoint: string; ownerToken: string; subdomain: string };
  const subdomain = `e2e-${Date.now()}`;

  beforeAll(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'toss-e2e-'));

    // Ensure built
    execSync('npm run build', { cwd: projectRoot, stdio: 'ignore' });

    // Deploy non-interactively
    execSync('node dist/index.js deploy', {
      cwd: projectRoot,
      env: { ...process.env, HOME: tempHome, HULL_SUBDOMAIN: subdomain },
      stdio: 'pipe',
    });

    const raw = await readFile(join(tempHome, '.toss', 'config.json'), 'utf-8');
    config = JSON.parse(raw);
    console.log(`Deployed to ${config.endpoint}`);
  }, 120000);

  afterAll(async () => {
    try {
      execSync('node dist/index.js destroy', {
        cwd: projectRoot,
        env: { ...process.env, HOME: tempHome },
        stdio: 'pipe',
      });
      console.log('Destroyed.');
    } catch {
      // cleanup best-effort
    }
    await rm(tempHome, { recursive: true, force: true });
  }, 60000);

  it('full lifecycle: share → fetch → list → revoke → dead link', async () => {
    const htmlFile = join(tempHome, 'test.html');
    await writeFile(htmlFile, '<html><body>Hello E2E</body></html>');

    // Share
    const shareJson = execSync('node dist/index.js share test.html --expires 1h --json', {
      cwd: projectRoot,
      env: { ...process.env, HOME: tempHome },
      encoding: 'utf-8',
    });
    const { id, url } = JSON.parse(shareJson);
    expect(id).toBeDefined();
    expect(url).toMatch(/^https:\/\//);

    // Fetch the share link
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(await res.text()).toBe('<html><body>Hello E2E</body></html>');

    // List should contain the artifact
    const listOut = execSync('node dist/index.js list', {
      cwd: projectRoot,
      env: { ...process.env, HOME: tempHome },
      encoding: 'utf-8',
    });
    expect(listOut).toContain(id.slice(0, 8));

    // Revoke
    execSync(`node dist/index.js revoke ${id}`, {
      cwd: projectRoot,
      env: { ...process.env, HOME: tempHome },
      encoding: 'utf-8',
    });

    // Link should be dead
    const res2 = await fetch(url);
    expect(res2.status).toBe(404);
  }, 30000);
});
