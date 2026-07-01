/**
 * Shared MyAnimeList connect flow, used by both the side panel and the options
 * page (previously two copies that could drift). MUST be called from a UI page —
 * launchWebAuthFlow needs a window to host the auth popup; the MV3 service
 * worker has none.
 */
import { authorizeUrl, exchangeCode } from './mal';
import { randomVerifier } from './pkce';
import { setTokenData } from './tracker-store';

/** Run the full OAuth dance and persist the token. Throws on failure/cancel. */
export async function connectMal(): Promise<void> {
  const redirectUri = chrome.identity.getRedirectURL();
  const verifier = randomVerifier(); // PKCE "plain": challenge == verifier
  const state = randomVerifier().slice(0, 16);
  const responseUrl = await new Promise<string | undefined>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authorizeUrl(verifier, redirectUri, state), interactive: true },
      (url) => {
        const e = chrome.runtime.lastError;
        if (e) reject(new Error(e.message));
        else resolve(url);
      },
    );
  });
  const params = new URLSearchParams((responseUrl ?? '').split('?')[1] ?? '');
  if (params.get('state') !== state) throw new Error('State mismatch');
  const code = params.get('code');
  if (!code) throw new Error(params.get('error') ?? 'No authorization code');
  const token = await exchangeCode(code, verifier, redirectUri);
  await setTokenData(token);
}
