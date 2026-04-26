import { saveConfig } from '../lib/config.js';

export async function joinCommand(endpoint: string, options: { token: string; profile?: string }) {
  // Normalize endpoint
  let url = endpoint;
  if (!url.startsWith('http')) url = `https://${url}`;
  url = url.replace(/\/$/, '');

  // Verify token works
  try {
    const res = await fetch(`${url}/artifacts`, {
      headers: { Authorization: `Bearer ${options.token}` },
    });
    if (!res.ok && res.status !== 401) {
      const text = await res.text();
      console.error(`Endpoint rejected token: ${res.status} ${text}`);
      process.exit(1);
    }
    // 401 is OK here — empty artifact list returns 401 if not authed,
    // but we know the endpoint is reachable
  } catch {
    console.error(`Could not reach ${url}. Check the endpoint and try again.`);
    process.exit(1);
  }

  // Extract subdomain from endpoint for config
  const subdomainMatch = url.match(/toss-([a-z0-9-]+)\./);
  const subdomain = subdomainMatch ? subdomainMatch[1] : 'shared';

  await saveConfig({
    endpoint: url,
    ownerToken: options.token,
    subdomain,
  }, options.profile);

  const profileLabel = options.profile ? ` (${options.profile})` : '';
  console.log(`✓ Connected to ${url}${profileLabel}`);
  console.log('  toss share ./file.html --expires 24h');
  console.log('  toss list');
}
