export function parseVercelEnvValue(content: string, key: string): string | undefined {
  const patterns = [
    new RegExp(`^${key}="([^"]*)"$`, 'm'),
    new RegExp(`^${key}=(.*)$`, 'm'),
  ];

  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (!match) continue;
    return match[1].trim().replace(/^['"]|['"]$/g, '');
  }

  return undefined;
}

export function extractVercelStorageEnv(content: string): {
  databaseUrl?: string;
  blobToken?: string;
} {
  return {
    databaseUrl:
      parseVercelEnvValue(content, 'DATABASE_URL') ||
      parseVercelEnvValue(content, 'POSTGRES_URL'),
    blobToken: parseVercelEnvValue(content, 'BLOB_READ_WRITE_TOKEN'),
  };
}
