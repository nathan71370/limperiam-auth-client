# limperiam-auth-client

Client du service d'identité maison `limperiam-auth`. Il vérifie un jeton de
session opaque auprès du service, et n'assume rien d'autre sur son appelant :
il ne dépend pas de Next (il reçoit un jeton, pas une requête) et il ne met
rien en cache (voir plus bas pourquoi).

## Installation

Le paquet n'est pas publié sur npm ; il s'installe directement depuis Git :

```bash
npm install github:nathan71370/limperiam-auth-client
```

npm exécute automatiquement le script `prepare` (qui compile `src/` vers
`dist/`) lors d'une installation depuis Git. **L'image Docker qui exécute
cette installation doit avoir `git` disponible** — sans lui, `npm install`
échoue à résoudre la dépendance avant même d'atteindre `prepare`.

## Surface publique

```ts
type SessionPayload = {
  userId: number;
  email: string;
  pseudo: string;
  isAdmin: boolean;
  groups: string[];
  apps: string[];
};

type GroupRow = { slug: string; name: string };

type AppRow = {
  slug: string;
  name: string;
  url: string;
  /** URL absolue, résolue depuis AUTH_PUBLIC_URL. */
  iconUrl: string | null;
  categorySlug: string | null;
  categoryName: string | null;
  position: number;
  uptimeMonitor: string | null;
};

class AuthUnavailableError extends Error {}

const SESSION_COOKIE = 'lim_session';

function fetchSession(
  token: string | null | undefined,
  opts?: { authUrl?: string; timeoutMs?: number },
): Promise<SessionPayload | null>;

function fetchGroups(
  token: string | null | undefined,
  opts?: { authUrl?: string; timeoutMs?: number },
): Promise<GroupRow[]>;

function fetchApps(
  token: string | null | undefined,
  opts?: { authUrl?: string; publicUrl?: string; timeoutMs?: number },
): Promise<AppRow[]>;

function loginUrl(next: string, publicUrl?: string): string;

function logoutUrl(publicUrl?: string): string;
```

- `fetchSession` renvoie `null` quand il n'y a pas de session valide (jeton
  absent, périmé ou révoqué), et lève `AuthUnavailableError` quand le service
  d'identité n'a pas pu répondre. Ces deux cas doivent être traités
  différemment par l'appelant : le premier redirige vers la connexion, le
  second affiche une erreur (503) — les confondre enverrait tout le monde vers
  une page de login servie par un service en panne.
- `fetchGroups` renvoie un tableau vide aussi bien sans jeton que sur une
  session refusée : cette liste ne sert qu'à peupler une UI, son absence ne
  doit jamais empêcher une page de s'afficher.
- `fetchApps` renvoie le catalogue **déjà filtré par les droits** de la
  personne — le filtrage est fait par la requête SQL du service, jamais dans
  le navigateur. Elle renvoie un tableau vide sans jeton et sur un 401, mais
  **lève** `AuthUnavailableError` dès que le service ne répond pas
  correctement. Cette différence de contrat avec `fetchGroups` est délibérée :
  une liste de groupes vide ne fait que vider des cases à cocher, alors qu'une
  liste d'applications vide afficherait un dashboard désert, exactement comme
  si la personne n'avait droit à rien. Mieux vaut une page d'erreur explicite
  qu'un mensonge silencieux.

  C'est aussi elle qui résout `iconPath` (relatif, tel que le service le
  stocke) en URL absolue : le service n'a pas à connaître sa propre adresse
  publique, c'est le consommateur qui sait par où il le joint. `fetchApps` est
  donc la seule fonction à avoir besoin des **deux** variables d'URL à la fois.
- `loginUrl` / `logoutUrl` construisent les URL publiques de connexion et de
  déconnexion. `logoutUrl` doit être utilisée en **POST** : la route refuse
  volontairement le GET, pour qu'une balise `<img>` sur un site tiers ne
  déconnecte pas de toutes les applications du domaine.

## Variables d'environnement

| Variable            | Rôle                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| `AUTH_INTERNAL_URL`  | Base URL par laquelle le serveur de l'application appelle `limperiam-auth` (ex. `http://limperiam-auth:3000`, résolution interne au réseau Docker). Requise par `fetchSession`, `fetchGroups` et `fetchApps`. |
| `AUTH_PUBLIC_URL`    | Base URL publique du service, utilisée pour construire les liens de connexion/déconnexion vus par le navigateur (ex. `https://auth.limperiam.com`). Requise par `loginUrl`, `logoutUrl` et `fetchApps` (résolution des URL d'icônes). |

Chaque fonction accepte aussi `authUrl` / `publicUrl` en option pour
surcharger la variable d'environnement correspondante — utile pour les tests,
inutile en usage normal.

Une variable manquante lève une erreur explicite qui la nomme, plutôt que de
se déguiser en panne du service : c'est une erreur de configuration, pas un
incident réseau.

## Pourquoi aucun cache

Le jeton de session est **opaque** : il ne contient aucune information, il
n'est qu'une clé vérifiée en base à chaque appel via `GET /api/session`.
C'est ce qui permet de désactiver un compte et de le déconnecter
**immédiatement** de toutes les applications du domaine. Mettre en cache la
réponse — même quelques secondes — réintroduirait une fenêtre pendant
laquelle un compte révoqué resterait connecté ailleurs : cela viderait le
jeton opaque de sa seule raison d'être.

## Exemple d'adaptateur Next.js

Le paquet ne lit pas le cookie lui-même (voir plus haut) ; c'est à
l'application de le récupérer et de le transmettre :

```ts
// lib/session.ts
import { cookies } from 'next/headers';
import { fetchSession, SESSION_COOKIE, type SessionPayload } from 'limperiam-auth-client';

export async function getSession(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return fetchSession(token);
}

export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) {
    // AuthUnavailableError n'est pas rattrapée ici : elle doit remonter
    // jusqu'à une page d'erreur 503, pas se confondre avec "pas connecté".
    throw new Response(null, { status: 302, headers: { Location: '/login' } });
  }
  return session;
}
```
