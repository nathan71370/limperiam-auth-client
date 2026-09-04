/**
 * Client du service d'identité `limperiam-auth`.
 *
 * Ce paquet ne dépend PAS de Next : il reçoit un jeton, pas une requête. Lire
 * le cookie tient en une ligne côté application (`cookies().get(...)`) ; le
 * faire ici y ferait entrer `next/headers` en dépendance de pair pour masquer
 * un appel trivial, et rendrait le module intestable sans état de requête.
 *
 * Il ne met RIEN en cache. Le jeton de session est opaque et vérifié en base à
 * chaque appel, précisément pour que désactiver un compte le déconnecte
 * immédiatement partout. Un cache, même court, rendrait cette propriété fausse
 * pendant sa durée.
 */

export type SessionPayload = {
  userId: number;
  email: string;
  pseudo: string;
  isAdmin: boolean;
  groups: string[];
  apps: string[];
};

export type GroupRow = { slug: string; name: string };

/**
 * Le service d'identité n'a pas pu répondre. À distinguer absolument de
 * « pas de session » : la première situation doit produire une erreur visible
 * (503), la seconde une redirection vers la connexion. Les confondre enverrait
 * tout le monde vers une page de login servie par un service en panne.
 */
export class AuthUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Service d'identité injoignable");
    this.name = 'AuthUnavailableError';
    this.cause = cause;
  }
}

export const SESSION_COOKIE = 'lim_session';

const DEFAULT_TIMEOUT_MS = 3000;

function internalUrl(override?: string): string {
  const url = override ?? process.env.AUTH_INTERNAL_URL;
  if (!url) {
    throw new Error(
      "AUTH_INTERNAL_URL n'est pas définie : impossible de vérifier une session.",
    );
  }
  return url.replace(/\/+$/, '');
}

function publicBase(override?: string): string {
  const url = override ?? process.env.AUTH_PUBLIC_URL;
  if (!url) {
    throw new Error(
      "AUTH_PUBLIC_URL n'est pas définie : impossible de construire l'URL de connexion.",
    );
  }
  return url.replace(/\/+$/, '');
}

/**
 * `base` est résolue par l'APPELANT, avant son `try`. Une variable
 * d'environnement manquante est une erreur de configuration, pas une panne du
 * service : la laisser tomber dans le `catch` qui fabrique
 * `AuthUnavailableError` masquerait « tu as oublié AUTH_INTERNAL_URL » derrière
 * « service injoignable », et enverrait chercher un conteneur en bonne santé.
 */
async function callAuth(
  base: string,
  path: string,
  token: string,
  timeoutMs?: number,
): Promise<Response> {
  const controller = new AbortController();
  // Sans délai d'attente, une panne réseau silencieuse (paquets avalés plutôt
  // que refusés) suspendrait le rendu de la page jusqu'au timeout par défaut
  // de l'agent HTTP, qui se compte en minutes.
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(`${base}${path}`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vérifie un jeton auprès du service d'identité.
 *
 * - `null` renvoyé = pas de session valide (jeton absent, périmé, révoqué).
 * - `AuthUnavailableError` levée = on ne sait pas. L'appelant échoue fermé.
 */
export async function fetchSession(
  token: string | null | undefined,
  opts?: { authUrl?: string; timeoutMs?: number },
): Promise<SessionPayload | null> {
  // Pas de jeton = pas de session, sans aller déranger le service : une page
  // publique visitée par un inconnu ne doit pas produire d'appel réseau.
  if (!token) return null;

  // Hors du try : voir le commentaire de `callAuth`.
  const base = internalUrl(opts?.authUrl);

  let res: Response;
  try {
    res = await callAuth(base, '/api/session', token, opts?.timeoutMs);
  } catch (err) {
    throw new AuthUnavailableError(err);
  }

  if (res.status === 401) return null;
  if (!res.ok) throw new AuthUnavailableError(new Error(`HTTP ${res.status}`));

  try {
    return (await res.json()) as SessionPayload;
  } catch (err) {
    throw new AuthUnavailableError(err);
  }
}

/**
 * Liste des groupes. Renvoie un tableau vide plutôt que de lever, que ce
 * soit parce que la session est refusée ou parce que `callAuth` échoue (panne
 * réseau, service muet) : cette liste ne sert qu'à peupler une UI, son
 * absence ne doit jamais empêcher une page de s'afficher. Contrairement à
 * `fetchSession`, on ne distingue pas ici « pas de session » de « service
 * injoignable » — ce n'est pas dangereux, car une liste de groupes vide ne
 * fait que vider des cases à cocher : elle n'accorde et ne retire aucun
 * accès. C'est `fetchSession` qui garde cette distinction stricte, parce que
 * c'est elle qui décide qui entre.
 */
export async function fetchGroups(
  token: string | null | undefined,
  opts?: { authUrl?: string; timeoutMs?: number },
): Promise<GroupRow[]> {
  if (!token) return [];
  // internalUrl() est résolue hors du try, comme dans fetchSession : une
  // variable d'environnement manquante est une erreur de configuration, pas
  // une panne réseau, et ne doit pas se retrouver avalée par le catch
  // ci-dessous.
  const base = internalUrl(opts?.authUrl);
  let res: Response;
  try {
    res = await callAuth(base, '/api/groups', token, opts?.timeoutMs);
  } catch {
    return [];
  }
  if (!res.ok) return [];
  // Le corps est décodé dans un try au même titre que l'appel réseau : une
  // réponse 200 mal formée (page d'erreur HTML d'un proxy, corps tronqué) fait
  // lever `res.json()`, et ce SyntaxError sortirait du contrat annoncé
  // au-dessus. `fetchGroups` est appelée hors de tout try par ses appelants
  // — dans `app/page.tsx` du dashboard, notamment — précisément parce qu'elle
  // promet de ne pas lever : une liste de cases à cocher vide ne doit jamais
  // faire échouer le rendu d'une page.
  try {
    const body = (await res.json()) as { groups?: GroupRow[] };
    return body.groups ?? [];
  } catch {
    return [];
  }
}

export type AppRow = {
  slug: string;
  name: string;
  url: string;
  /** URL absolue, résolue depuis `AUTH_PUBLIC_URL`. `null` si l'app n'a pas d'icône. */
  iconUrl: string | null;
  categorySlug: string | null;
  categoryName: string | null;
  position: number;
  uptimeMonitor: string | null;
};

/**
 * Le catalogue filtré par les droits de la personne.
 *
 * Contrairement à `fetchGroups`, une panne du service **lève** au lieu de
 * renvoyer un tableau vide : une liste de groupes vide ne fait que vider des
 * cases à cocher, alors qu'une liste d'applications vide afficherait un
 * dashboard désert, exactement comme si la personne n'avait droit à rien.
 * Mieux vaut une page d'erreur explicite qu'un mensonge silencieux. Un 401
 * reste un tableau vide : là, l'absence de session est une réponse, pas une
 * panne, et l'appelant redirigera vers la connexion.
 *
 * C'est ici qu'`iconPath`, relatif tel que le service le stocke, devient une
 * URL absolue : le service n'a pas à connaître sa propre adresse publique,
 * c'est le consommateur qui sait par où il le joint.
 */
export async function fetchApps(
  token: string | null | undefined,
  opts?: { authUrl?: string; publicUrl?: string; timeoutMs?: number },
): Promise<AppRow[]> {
  if (!token) return [];

  // Hors du try : voir le commentaire de `callAuth`. Les deux variables sont
  // résolues avant le moindre appel réseau, pour qu'une configuration
  // incomplète se dise comme telle plutôt qu'en « service injoignable ».
  const base = internalUrl(opts?.authUrl);
  const publicOrigin = publicBase(opts?.publicUrl);

  let res: Response;
  try {
    res = await callAuth(base, '/api/apps', token, opts?.timeoutMs);
  } catch (err) {
    throw new AuthUnavailableError(err);
  }

  if (res.status === 401) return [];
  if (!res.ok) throw new AuthUnavailableError(new Error(`HTTP ${res.status}`));

  let body: { apps?: (Omit<AppRow, 'iconUrl'> & { iconPath: string | null })[] };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    throw new AuthUnavailableError(err);
  }

  return (body.apps ?? []).map(({ iconPath, ...app }) => ({
    ...app,
    iconUrl: iconPath ? `${publicOrigin}${iconPath}` : null,
  }));
}

/** URL de la page de connexion, avec la destination de retour. */
export function loginUrl(next: string, publicUrl?: string): string {
  return `${publicBase(publicUrl)}/login?next=${encodeURIComponent(next)}`;
}

/**
 * Cible du formulaire de déconnexion. À utiliser en **POST** : la route refuse
 * volontairement le GET, pour qu'une balise `<img>` sur un site tiers ne
 * déconnecte pas de toutes les applications du domaine.
 */
export function logoutUrl(publicUrl?: string): string {
  return `${publicBase(publicUrl)}/logout`;
}
