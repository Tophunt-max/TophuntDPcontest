import { describe, it, expect } from 'vitest';
import { getNotificationDestination, safeInAppRoute } from '../src/services/notifications/notificationMeta';

/**
 * A notification's `url` comes from the push payload and is handed straight to
 * `router.push`. It used to be returned verbatim, so an absolute or
 * protocol-relative URL in a notification opened an arbitrary external target.
 */
describe('notification deep links stay inside the app', () => {
  it('keeps in-app routes', () => {
    expect(getNotificationDestination('admin', null, '/wallet')).toBe('/wallet');
    expect(getNotificationDestination(undefined, null, '/prizes/m1?x=1')).toBe('/prizes/m1?x=1');
  });

  it.each([
    'https://evil.example/login',
    'http://evil.example',
    '//evil.example/path',
    'javascript:alert(1)',
    'intent://scan/#Intent;scheme=zxing;end',
    'tophunt://wallet',
    '/\\evil.example',
    ' https://evil.example',
    '/wallet\u0000',
  ])('rejects %s and falls back to the type route', (url) => {
    expect(safeInAppRoute(url)).toBeNull();
    expect(getNotificationDestination('purchase', null, url)).toBe('/wallet');
    expect(getNotificationDestination('admin', null, url)).toBeNull();
  });

  it('encodes target ids into the route', () => {
    expect(getNotificationDestination('follow', 'a&b=c')).toBe('/profile?userId=a%26b%3Dc');
    expect(getNotificationDestination('like', '../x')).toBe('/..%2Fx');
  });
});
