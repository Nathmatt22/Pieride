// Ce que le trousseau garde d'un compte Skolengo. Le jeton de rafraîchissement change à chaque
// renouvellement : c'est le dernier reçu qui vaut. `userId` ne sert qu'à reconnaître le même
// élève quand il ajoute son compte une deuxième fois.

export interface SkolengoSecret {
  userId: string;
  refreshToken: string;
  /** Le point d'échange OIDC, d'où vient un nouveau jeton d'accès. */
  tokenEndpoint: string;
  /** La configuration OIDC de l'ENT, pour relire les droits de l'élève. */
  wellKnown: string;
  /** Le code de l'ENT (« gdest », « rra »…), envoyé avec chaque requête. */
  emsCode: string;
}

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** Le secret lu dans le trousseau, ou `null` s'il est illisible. */
export function parseSecret(text: string): SkolengoSecret | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const fields: Partial<Record<keyof SkolengoSecret, unknown>> = value;
  const { userId, refreshToken, tokenEndpoint, wellKnown, emsCode } = fields;
  if (
    !isText(userId) ||
    !isText(refreshToken) ||
    !isText(tokenEndpoint) ||
    !isText(wellKnown) ||
    !isText(emsCode)
  ) {
    return null;
  }
  return { userId, refreshToken, tokenEndpoint, wellKnown, emsCode };
}
