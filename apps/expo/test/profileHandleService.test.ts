/**
 * The client half of the `/@handle` profile url.
 *
 * `profilePath` is the single place the canonical form is decided, and it is called
 * from two places that must agree: the redirect that rewrites `?userId=<uid>` out of
 * the address bar, and the redirect that follows a released handle to its current
 * owner. If they disagreed about casing, one of them would send the reader to a url
 * the edge Worker immediately 301s again — a second hop for nothing, on every visit.
 *
 * `fetchProfileByHandle` collapses "unknown handle" and "lookup failed" into the same
 * empty answer on purpose; that is asserted here so the choice is deliberate rather
 * than accidental, and so a future caller reading these tests knows it cannot
 * distinguish the two.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const readApi = vi.fn();
vi.mock('@/src/services/api', () => ({
  callApi: vi.fn(),
  readApi: (...args: any[]) => (readApi as any)(...args),
}));

// Braces matter: `mockReset()` RETURNS the mock, and a function returned from
// `beforeEach` is registered by vitest as a teardown callback — so the concise form
// would call the mock after every test, and the rejecting case below would surface as
// an unhandled rejection attributed to that test.
beforeEach(() => {
  readApi.mockReset();
});

const load = () => import('@/src/services/users');

describe('profilePath', () => {
  it('lowercases, so one profile has ONE url', async () => {
    const { profilePath } = await load();
    expect(profilePath('Alice')).toBe('/@alice');
    expect(profilePath('ALICE_99')).toBe('/@alice_99');
  });

  it('strips a leading @ so a stored or pasted handle both work', async () => {
    const { profilePath } = await load();
    expect(profilePath('@alice')).toBe('/@alice');
    expect(profilePath('@@alice')).toBe('/@alice');
  });

  it('trims surrounding whitespace', async () => {
    const { profilePath } = await load();
    expect(profilePath('  alice  ')).toBe('/@alice');
  });

  it('returns null rather than `/@` when there is no handle', async () => {
    // The callers navigate only `if (next)`. Returning a path here would push the app
    // to a url that resolves to nothing — for an account that simply has no username.
    const { profilePath } = await load();
    for (const empty of [null, undefined, '', '   ', '@']) {
      expect(profilePath(empty as any), String(empty)).toBeNull();
    }
  });
});

describe('fetchProfileByHandle', () => {
  it('asks the by-username endpoint and returns the profile', async () => {
    readApi.mockResolvedValue({ uid: 'uid-alice', username: 'alice' });
    const { fetchProfileByHandle } = await load();
    const res = await fetchProfileByHandle('alice');
    expect(readApi).toHaveBeenCalledWith('/read/users/by-username/alice');
    expect(res).toEqual({ status: 'found', profile: { uid: 'uid-alice', username: 'alice' } });
  });

  it('strips a leading @ before calling', async () => {
    readApi.mockResolvedValue({ uid: 'uid-alice', username: 'alice' });
    const { fetchProfileByHandle } = await load();
    await fetchProfileByHandle('@alice');
    expect(readApi).toHaveBeenCalledWith('/read/users/by-username/alice');
  });

  it('percent-encodes the handle it was given', async () => {
    // The handle reaches this function straight off a url segment, so it is not
    // trusted to be safe to interpolate even though a valid username always is.
    readApi.mockResolvedValue(null);
    const { fetchProfileByHandle } = await load();
    await fetchProfileByHandle('a/b');
    expect(readApi).toHaveBeenCalledWith('/read/users/by-username/a%2Fb');
  });

  it('reports a moved handle so the caller can follow it', async () => {
    readApi.mockResolvedValue({ movedTo: 'alice_new' });
    const { fetchProfileByHandle } = await load();
    expect(await fetchProfileByHandle('alice_old')).toEqual({ status: 'moved', movedTo: 'alice_new' });
  });

  it('reports an unknown handle as NOT-FOUND', async () => {
    readApi.mockResolvedValue(null);
    const { fetchProfileByHandle } = await load();
    expect(await fetchProfileByHandle('nobody')).toEqual({ status: 'not-found' });
  });

  it('reports a failed lookup as UNAVAILABLE, not as not-found', async () => {
    /**
     * THE BUG THIS EXISTS FOR. Both cases used to collapse into one empty result, and
     * the screen rendered "This account doesn't exist or is no longer available" for
     * either — so a dropped connection told someone who had just followed a link that a
     * real profile did not exist, with no retry and no hint that trying again would help.
     *
     * The edge Worker already separates these (404 vs 503) so a bad minute upstream is
     * not reported as a missing page. The client owes the person holding the link the
     * same distinction.
     */
    readApi.mockImplementation(async () => {
      throw new Error('network down');
    });
    const { fetchProfileByHandle } = await load();
    expect(await fetchProfileByHandle('alice')).toEqual({ status: 'unavailable' });
  });

  it('does not throw on a failed lookup', async () => {
    // The screen branches on `status`; an exception here would surface as a red error
    // box for what is usually a flaky connection.
    readApi.mockImplementation(async () => {
      throw new Error('network down');
    });
    const { fetchProfileByHandle } = await load();
    await expect(fetchProfileByHandle('alice')).resolves.toBeTruthy();
  });

  it('does not call the API at all for a blank handle', async () => {
    const { fetchProfileByHandle } = await load();
    expect(await fetchProfileByHandle('  @ ')).toEqual({ status: 'not-found' });
    expect(readApi).not.toHaveBeenCalled();
  });
});
