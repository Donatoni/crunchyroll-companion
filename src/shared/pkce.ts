/** OAuth PKCE helpers shared by the MAL and Supabase sign-in flows. */

/** PKCE verifier: 43–128 chars from the unreserved set. */
export function randomVerifier(): string {
  // 64-char alphabet so a byte maps to a character with no modulo bias.
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = new Uint8Array(96);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b & 63]).join('');
}

/**
 * S256 code challenge: base64url(sha256(verifier)). Used by Supabase; NOT by
 * MyAnimeList, which only supports the `plain` method (challenge == verifier).
 */
export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const bin = String.fromCharCode(...new Uint8Array(digest));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
