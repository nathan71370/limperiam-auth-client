import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSession, fetchGroups, loginUrl, logoutUrl, AuthUnavailableError }
  from '../src/index.ts';

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit | undefined }[] = [];

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url);
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  process.env.AUTH_INTERNAL_URL = 'http://limperiam-auth:3000';
  process.env.AUTH_PUBLIC_URL = 'https://auth.limperiam.com';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.AUTH_INTERNAL_URL;
  delete process.env.AUTH_PUBLIC_URL;
});

test('sans jeton, aucune requête réseau n’est faite', async () => {
  stubFetch(() => new Response('{}', { status: 200 }));
  assert.equal(await fetchSession(null), null);
  assert.equal(await fetchSession(undefined), null);
  assert.equal(await fetchSession(''), null);
  assert.equal(calls.length, 0);
});

test('un jeton valide renvoie la charge utile et transmet le cookie', async () => {
  const payload = {
    userId: 1, email: 'a@b.c', pseudo: 'nathan',
    isAdmin: true, groups: ['admin'], apps: ['jellyfin'],
  };
  stubFetch(() => new Response(JSON.stringify(payload), { status: 200 }));

  assert.deepEqual(await fetchSession('jeton-opaque'), payload);
  assert.equal(calls[0].url, 'http://limperiam-auth:3000/api/session');
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).cookie,
    'lim_session=jeton-opaque',
  );
});

test('un 401 signifie « pas de session », pas une panne', async () => {
  stubFetch(() => new Response('{"error":"NOT_AUTHENTICATED"}', { status: 401 }));
  assert.equal(await fetchSession('perime'), null);
});

test('un 500 ou un réseau coupé lève AuthUnavailableError', async () => {
  stubFetch(() => new Response('boom', { status: 500 }));
  await assert.rejects(() => fetchSession('jeton'), AuthUnavailableError);

  globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
  await assert.rejects(() => fetchSession('jeton'), AuthUnavailableError);
});

test('AUTH_INTERNAL_URL manquante lève une erreur explicite', async () => {
  delete process.env.AUTH_INTERNAL_URL;
  stubFetch(() => new Response('{}', { status: 200 }));
  await assert.rejects(() => fetchSession('jeton'), /AUTH_INTERNAL_URL/);
});

test('fetchGroups renvoie la liste, tableau vide sans session', async () => {
  stubFetch(() => new Response('{"groups":[{"slug":"admin","name":"Admin"}]}', { status: 200 }));
  assert.deepEqual(await fetchGroups('jeton'), [{ slug: 'admin', name: 'Admin' }]);
  assert.equal(calls[0].url, 'http://limperiam-auth:3000/api/groups');

  stubFetch(() => new Response('{}', { status: 401 }));
  assert.deepEqual(await fetchGroups('perime'), []);
});

test('fetchGroups renvoie un tableau vide sur panne réseau, sans lever', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
  assert.deepEqual(await fetchGroups('jeton'), []);
});

test('fetchGroups renvoie un tableau vide sur un corps 200 malformé, sans lever', async () => {
  // Le JSDoc promet un tableau vide plutôt que de lever ; `fetchGroups` est
  // appelée hors de tout try dans `app/page.tsx` du dashboard, donc un
  // SyntaxError brut y ferait prendre un 500 sur `/` à un admin — pour une
  // liste qui ne sert qu'à peupler des cases à cocher.
  stubFetch(() => new Response('<html>oups</html>', { status: 200 }));
  assert.deepEqual(await fetchGroups('jeton'), []);
});

test('loginUrl encode la destination, logoutUrl pointe la bonne route', () => {
  assert.equal(
    loginUrl('https://dashboard.limperiam.com/?q=a b'),
    'https://auth.limperiam.com/login?next=https%3A%2F%2Fdashboard.limperiam.com%2F%3Fq%3Da%20b',
  );
  assert.equal(logoutUrl(), 'https://auth.limperiam.com/logout');
});
