export function sanitizeDeploymentSuffix(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function deriveDeploymentSuffix(
  profileName?: string,
  savedSubdomain?: string,
  envSubdomain?: string
): string {
  const explicit = envSubdomain || savedSubdomain;
  if (explicit) {
    return explicit;
  }

  if (!profileName || profileName === 'default' || profileName === 'owner') {
    return 'toss';
  }

  const sanitized = sanitizeDeploymentSuffix(profileName);
  return sanitized || 'toss';
}

export function getVercelProjectName(subdomain: string): string {
  return subdomain === 'toss' ? 'toss' : `toss-${subdomain}`;
}

export function getCloudflareResourceNames(subdomain: string): {
  workerName: string;
  dbName: string;
  kvTitle: string;
} {
  return {
    workerName: subdomain === 'toss' ? 'toss' : `toss-${subdomain}`,
    dbName: subdomain === 'toss' ? 'toss-db' : `toss-db-${subdomain}`,
    kvTitle: subdomain === 'toss' ? 'toss-kv' : `toss-kv-${subdomain}`,
  };
}
