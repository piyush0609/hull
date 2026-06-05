function b64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(str: string): string {
  const padLen = (4 - (str.length % 4)) % 4;
  str += new Array(padLen + 1).join('=');
  return atob(str.replace(/\-/g, '+').replace(/\_/g, '/'));
}

export async function signJWT(payload: Record<string, unknown>, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`));
  const sigStr = b64urlEncode(String.fromCharCode(...new Uint8Array(sig)));
  return `${header}.${body}.${sigStr}`;
}

export async function verifyJWT(token: string, secret: string): Promise<Record<string, unknown>> {
  const [h, b, s] = token.split('.');
  if (!h || !b || !s) throw new Error('Invalid token format');

  let payload: string;
  let sigData: string;
  let header: string;
  try {
    header = b64urlDecode(h);
    payload = b64urlDecode(b);
    sigData = b64urlDecode(s);
  } catch {
    throw new Error('Invalid token format');
  }

  // Pin the algorithm: we only ever issue HS256. Asserting it here rejects any
  // token whose header claims a different alg (e.g. "none"), so the verifier can
  // never be tricked into skipping the HMAC check.
  try {
    if ((JSON.parse(header) as { alg?: string }).alg !== 'HS256') {
      throw new Error('Unexpected token algorithm');
    }
  } catch {
    throw new Error('Invalid token format');
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const sig = new Uint8Array([...sigData].map((c) => c.charCodeAt(0)));
  const valid = await crypto.subtle.verify('HMAC', key, sig, encoder.encode(`${h}.${b}`));
  if (!valid) throw new Error('Invalid signature');

  return JSON.parse(payload);
}
