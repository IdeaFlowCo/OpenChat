import { describe, expect, it } from 'vitest';
import {
  LAST_LOGIN_METHOD_KEY,
  readLastLoginMethod,
  resolveLastLoginMethod,
  signInAndRemember,
  type KeyValueStorage,
  type LoginMethod,
} from './lastLoginMethod';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const writes: Array<[string, string]> = [];
  const storage: KeyValueStorage = {
    getItem: async key => data.get(key) ?? null,
    setItem: async (key, value) => {
      writes.push([key, value]);
      data.set(key, value);
    },
  };
  return { storage, data, writes };
}

const brokenStorage: KeyValueStorage = {
  getItem: () => { throw new Error('SecurityError: storage unavailable'); },
  setItem: async () => { throw new Error('QuotaExceededError'); },
};

const webWithIdeaflow: LoginMethod[] = ['ideaflow', 'google', 'password'];

describe('signInAndRemember', () => {
  it('records the method only after the sign-in resolves', async () => {
    const { storage, data, writes } = memoryStorage();
    let settle!: () => void;
    const pending = signInAndRemember(storage, 'ideaflow', () => new Promise<string>(resolve => {
      settle = () => resolve('session');
    }));
    await Promise.resolve();
    expect(writes).toEqual([]); // started, but nothing recorded before success

    settle();
    await expect(pending).resolves.toBe('session');
    expect(data.get(LAST_LOGIN_METHOD_KEY)).toBe('ideaflow');
    expect(writes).toEqual([[LAST_LOGIN_METHOD_KEY, 'ideaflow']]);
  });

  it('leaves the previous hint untouched when the sign-in fails or is cancelled', async () => {
    const { storage, data, writes } = memoryStorage({ [LAST_LOGIN_METHOD_KEY]: 'google' });

    await expect(
      signInAndRemember(storage, 'ideaflow', async () => { throw new Error('link_required'); }),
    ).rejects.toThrow('link_required');
    await expect(
      signInAndRemember(storage, 'apple', async () => {
        throw Object.assign(new Error('cancelled'), { code: 'ERR_REQUEST_CANCELED' });
      }),
    ).rejects.toThrow('cancelled');

    expect(writes).toEqual([]);
    expect(data.get(LAST_LOGIN_METHOD_KEY)).toBe('google');
  });

  it('overwrites the previous hint on a later successful sign-in', async () => {
    const { storage, data } = memoryStorage({ [LAST_LOGIN_METHOD_KEY]: 'google' });
    await signInAndRemember(storage, 'password', async () => undefined);
    expect(data.get(LAST_LOGIN_METHOD_KEY)).toBe('password');
  });

  it('still completes the sign-in when storage is unavailable', async () => {
    await expect(
      signInAndRemember(brokenStorage, 'google', async () => 'session'),
    ).resolves.toBe('session');
  });
});

describe('readLastLoginMethod (session restore path never writes)', () => {
  it('reads the stored id without writing anything', async () => {
    const { storage, writes } = memoryStorage({ [LAST_LOGIN_METHOD_KEY]: 'password' });
    await expect(readLastLoginMethod(storage)).resolves.toBe('password');
    expect(writes).toEqual([]);
  });

  it('returns null when storage throws or is empty', async () => {
    await expect(readLastLoginMethod(brokenStorage)).resolves.toBeNull();
    await expect(readLastLoginMethod(memoryStorage().storage)).resolves.toBeNull();
  });
});

describe('resolveLastLoginMethod', () => {
  it('returns the stored method when it is currently enabled', () => {
    expect(resolveLastLoginMethod('google', webWithIdeaflow)).toBe('google');
    expect(resolveLastLoginMethod('ideaflow', webWithIdeaflow)).toBe('ideaflow');
    expect(resolveLastLoginMethod('apple', ['apple', 'google', 'password'])).toBe('apple');
  });

  it('ignores unknown, stale, or malformed stored values', () => {
    expect(resolveLastLoginMethod('facebook', webWithIdeaflow)).toBeNull();
    expect(resolveLastLoginMethod('GOOGLE', webWithIdeaflow)).toBeNull();
    expect(resolveLastLoginMethod('{"method":"google"}', webWithIdeaflow)).toBeNull();
    expect(resolveLastLoginMethod('', webWithIdeaflow)).toBeNull();
    expect(resolveLastLoginMethod(null, webWithIdeaflow)).toBeNull();
    expect(resolveLastLoginMethod(undefined, webWithIdeaflow)).toBeNull();
  });

  it('ignores a stored method that is not enabled right now', () => {
    // e.g. ideaflow remembered, but the server kill switch turned it off
    expect(resolveLastLoginMethod('ideaflow', ['google', 'password'])).toBeNull();
    // apple is iOS-only
    expect(resolveLastLoginMethod('apple', webWithIdeaflow)).toBeNull();
  });

  it('shows nothing unless two or more methods are enabled', () => {
    expect(resolveLastLoginMethod('google', ['google'])).toBeNull();
    expect(resolveLastLoginMethod('google', [])).toBeNull();
    expect(resolveLastLoginMethod('google', ['google', 'password'])).toBe('google');
  });
});
