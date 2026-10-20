import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('first-paint auth contract', () => {
  it('has exactly one Firebase auth-state observer, in the shared session store', () => {
    const files = [
      'src/services/authSession.ts',
      'src/hooks/useAuth.ts',
      'app/_layout.tsx',
      'app/splash.tsx',
      'src/hooks/useAuthGate.ts',
    ];
    const owners = files.filter((f) => /onAuthStateChanged\s*\(/.test(read(f)));
    expect(owners).toEqual(['src/services/authSession.ts']);
    expect(read('src/hooks/useAuth.ts')).toContain('useSyncExternalStore');
  });

  it('withholds the route tree while auth is restoring or in recovery', () => {
    const root = read('app/_layout.tsx');
    const restoring = root.indexOf("authSession.status === 'restoring'");
    const error = root.indexOf("authSession.status === 'error'");
    const app = root.indexOf('<RootLayoutNav />');
    expect(restoring).toBeGreaterThan(0);
    expect(error).toBeGreaterThan(restoring);
    expect(app).toBeGreaterThan(error);
    expect(root).toContain('NativeSplash.preventAutoHideAsync');
    expect(root).toContain('NativeSplash.hideAsync');
  });

  it('shows the Explore signup offer only to a confirmed guest', () => {
    const explore = read('app/explore/index.tsx');
    expect(explore).toContain('guestOffer={shell.showGuestUi');
    expect(explore).toContain('balanceLoading={shell.balanceLoading}');
    expect(explore).not.toMatch(/guestOffer=\{!user/);
  });

  it('the auth gate prompts only from the confirmed guest state', () => {
    const gate = read('src/hooks/useAuthGate.ts');
    expect(gate).toContain("if (status !== 'guest') return false");
    expect(gate).not.toContain('auth.currentUser');
  });

  it('the old splash no longer attaches a second observer or treats profile network errors as missing profile', () => {
    const splash = read('app/splash.tsx');
    expect(splash).not.toContain('onAuthStateChanged');
    expect(splash).not.toMatch(/readApi\(`\/read\/users\/\$\{user\.uid\}`\)\.catch\(\(\) => null\)/);
  });
});


describe('cached identity cleanup contract', () => {
  it('signup cancellation uses the central sign-out path, not Firebase directly', () => {
    const signup = read('app/auth/signup/fill-profile/index.tsx');
    expect(signup).toContain("import { signOut } from '@/src/services/auth'");
    expect(signup).not.toContain('import { signOut } from "firebase/auth"');
    expect(signup).toContain('signOut({ skipPushTokenUnregister: true })');
  });
});