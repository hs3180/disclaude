import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';

interface BrowserClient {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
interface CookieMarker { name: string; value: string; domain: string }

/** Synthetic persistent cookie in the owned service's default profile only. */
export async function seedNativeBrowserCookie(client: BrowserClient): Promise<CookieMarker> {
  const marker = { name: 'disclaude_service_acceptance', value: randomUUID(),
    domain: 'disclaude-acceptance.invalid' };
  await client.call('Storage.setCookies', { cookies: [{ ...marker, path: '/',
    expires: Math.floor(Date.now() / 1000) + 3600, secure: false, httpOnly: false, sameSite: 'Lax' }] });
  expect(await hasNativeBrowserCookie(client, marker), 'Persistent cookie must exist before restart').toBe(true);
  return marker;
}

export async function hasNativeBrowserCookie(client: BrowserClient, marker: CookieMarker): Promise<boolean> {
  const result = await client.call('Storage.getCookies') as { cookies: Array<CookieMarker & { session: boolean; expires: number }> };
  return result.cookies.some(cookie => cookie.name === marker.name && cookie.value === marker.value &&
    cookie.domain === marker.domain && !cookie.session && cookie.expires > Date.now() / 1000);
}
