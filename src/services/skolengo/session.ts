// Session Skolengo avec skolengojs (GPL-3.0), la bibliothèque de Papillon
// (services/skolengo, GPLv3) : https://github.com/PapillonApp/Papillon
// Skolengo renouvelle le jeton d'accès tout seul, et le jeton de rafraîchissement avec lui : le
// trousseau garde le dernier, sinon la connexion suivante serait refusée.
import { invoke } from "@tauri-apps/api/core";
import { Buffer } from "buffer";
import {
  GetUserInfo,
  Kind,
  OIDCRefresh,
  type Skolengo as SkolengoClient,
} from "skolengojs";

import { allowInstance } from "@/lib/http";
import type { AuthFailure, ServiceAuth } from "@/services/shared/auth";
import {
  AuthenticationError,
  ServiceUnavailable,
} from "@/services/shared/errors";

import { parseSecret, type SkolengoSecret } from "./secret";

// skolengojs décode ses jetons et télécharge ses pièces jointes avec `Buffer`, absent de la
// WebView. Le paquet `buffer` le fournit, seulement quand ce service est chargé.
if (!(globalThis as { Buffer?: typeof Buffer }).Buffer) {
  (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

/** Au-delà, la session est refaite avant une requête. */
export const SESSION_TTL = 25 * 60_000;

/** Les comptes parents Skolengo (plusieurs enfants) ne sont pas encore pris en charge. */
export class ParentAccount extends Error {
  name = "ParentAccount";
}

/** Le retour de la fenêtre de connexion : le code OIDC, ou un refus de l'ENT. */
export type SkolengoCallback =
  | { code: string; state: string; error?: undefined }
  | { error: string; code?: undefined; state?: undefined };

/**
 * Ouvre la page de connexion de l'ENT dans une fenêtre à part et attend le retour OIDC :
 * `{ code, state }`, un `{ error }` (connexion refusée), ou `null` si elle est fermée avant.
 * La fenêtre est privée et n'a accès à aucune commande de l'app (src-tauri/src/skolengo_login.rs).
 */
export const openSkolengoLogin = (url: string, title: string) =>
  invoke<SkolengoCallback | null>("skolengo_login", { url, title });

/**
 * Traduit une erreur de skolengojs en erreur des services. Ses requêtes lèvent une `Error`
 * dont le message commence par le statut HTTP (`401: {...}`) : un refus de jeton, sinon une
 * panne. Le message d'origine n'est jamais recopié dans l'erreur des services.
 */
export function toServiceError(error: unknown): unknown {
  if (
    error instanceof AuthenticationError ||
    error instanceof ServiceUnavailable ||
    error instanceof ParentAccount
  ) {
    return error;
  }
  if (error instanceof Error) {
    if (
      /^(400|401|403)\b/.test(error.message) ||
      /invalid_grant|invalid_token|unauthorized/i.test(error.message)
    ) {
      return new AuthenticationError("Skolengo a refusé la connexion");
    }
    return new ServiceUnavailable("Skolengo est indisponible");
  }
  return new ServiceUnavailable("Skolengo est indisponible");
}

/** La raison d'un échec de connexion, pour `ServiceAuth`. */
export function classifySkolengoError(error: unknown): AuthFailure | undefined {
  if (error instanceof ParentAccount) {
    return undefined;
  }
  if (error instanceof AuthenticationError) {
    return "credential_rejected";
  }
  if (
    error instanceof Error &&
    (/^(400|401|403)\b/.test(error.message) ||
      /invalid_grant|invalid_token|unauthorized/i.test(error.message))
  ) {
    return "credential_rejected";
  }
  return undefined;
}

export class SkolengoSession {
  private current: { client: SkolengoClient; openedAt: number } | null = null;
  private pending: Promise<SkolengoClient> | null = null;

  constructor(
    private secret: SkolengoSecret,
    private readonly saveSecret: (secret: string) => Promise<void>,
    private readonly auth: ServiceAuth
  ) {}

  /** La session ouverte, refaite après `SESSION_TTL` ou après un échec. */
  client(): Promise<SkolengoClient> {
    if (this.current && Date.now() - this.current.openedAt < SESSION_TTL) {
      return Promise.resolve(this.current.client);
    }
    // Une seule connexion à la fois : le jeton de rafraîchissement ne sert qu'une fois.
    this.pending ??= this.refresh().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /**
   * Lance une requête. Le client renouvelle son jeton d'accès quand il expire, en même temps
   * que le jeton de rafraîchissement : le dernier est écrit dans le trousseau après chaque
   * requête, réussie ou non.
   */
  async run<T>(request: (client: SkolengoClient) => Promise<T>): Promise<T> {
    this.auth.assertUsable();
    const client = await this.client();
    try {
      return await request(client);
    } catch (error) {
      throw toServiceError(error);
    } finally {
      await this.keep(client);
    }
  }

  /** Garde le jeton de rafraîchissement que le client vient de changer. */
  private async keep(client: SkolengoClient): Promise<void> {
    if (
      !client.refreshToken ||
      client.refreshToken === this.secret.refreshToken
    ) {
      return;
    }
    this.secret = {
      ...this.secret,
      refreshToken: client.refreshToken,
      tokenEndpoint: client.refreshURL || this.secret.tokenEndpoint,
    };
    await this.saveSecret(JSON.stringify(this.secret));
  }

  private async refresh(): Promise<SkolengoClient> {
    // Rouverte au réseau à chaque lancement : l'adresse de l'ENT est propre au compte.
    await allowInstance(new URL(this.secret.wellKnown).origin);
    await allowInstance(new URL(this.secret.tokenEndpoint).origin);
    const client = await this.auth.login(
      { rotatesCredential: true, classify: classifySkolengoError },
      async tracker => {
        tracker.credentialSent();
        tracker.awaitingNewCredential();
        const tokens = await OIDCRefresh(
          this.secret.tokenEndpoint,
          this.secret.refreshToken
        );
        // Enregistré avant `GetUserInfo` : si cette requête échoue, la connexion suivante a
        // quand même un jeton valable.
        this.secret = {
          ...this.secret,
          refreshToken: tokens.refresh_token || this.secret.refreshToken,
        };
        await this.saveSecret(JSON.stringify(this.secret));
        tracker.credentialReceived();

        const found = await GetUserInfo(
          tokens.access_token,
          this.secret.refreshToken,
          this.secret.wellKnown,
          this.secret.tokenEndpoint,
          this.secret.emsCode
        );
        this.secret = {
          ...this.secret,
          userId: found.userId,
          refreshToken: found.refreshToken,
          tokenEndpoint: found.refreshURL || this.secret.tokenEndpoint,
        };
        await this.saveSecret(JSON.stringify(this.secret));
        if (found.kind !== Kind.STUDENT) {
          throw new ParentAccount();
        }
        return found;
      }
    );
    this.current = { client, openedAt: Date.now() };
    return client;
  }
}

/** Vérifie qu'un secret enregistré est lisible avant d'ouvrir une session. */
export function secretOf(text: string): SkolengoSecret {
  const parsed = parseSecret(text);
  if (!parsed) {
    throw new AuthenticationError("Secret Skolengo illisible");
  }
  return parsed;
}
