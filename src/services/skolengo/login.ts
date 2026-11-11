// Connexion à Skolengo : recherche de l'établissement, puis la page de connexion de l'ENT dans
// une fenêtre à part (src-tauri/src/skolengo_login.rs). D'après Papillon
// (app/(onboarding)/services/skolengo et services/skolengo/refresh.ts, GPLv3).
// Le mot de passe reste dans la fenêtre : Piéride ne reçoit qu'un code OIDC, puis des jetons.
import {
  type AuthFlow,
  ChallengeMethod,
  Kind,
  School,
  SearchSchools,
  type Skolengo as SkolengoClient,
} from "skolengojs";

import { allowInstance } from "@/lib/http";
import { ServiceUnavailable } from "@/services/shared/errors";
import type { Account } from "@/services/shared/models";

import type { SkolengoSecret } from "./secret";
import { ParentAccount, toServiceError } from "./session";

/** Un établissement tel que l'écran de recherche l'affiche. */
export interface SkolengoSchool {
  id: string;
  name: string;
  /** Le code de l'ENT (« gdest », « rra »…). */
  emsCode: string;
  /** La configuration OIDC de l'ENT, aussi l'adresse propre au compte. */
  wellKnown: string;
  city?: string;
  postalCode?: string;
}

export function toSchool(school: School): SkolengoSchool {
  return {
    id: school.id,
    name: school.name,
    emsCode: school.emsCode,
    wellKnown: school.OIDCWellKnown,
    city: school.location?.city || undefined,
    postalCode: school.location?.zipCode || undefined,
  };
}

/**
 * Les établissements qui correspondent à la recherche. `SearchSchools` interroge l'API de
 * Skolengo ; une panne devient une erreur des services, jamais son message.
 */
export async function findSchools(query: string): Promise<SkolengoSchool[]> {
  try {
    return (await SearchSchools(query, 50)).map(toSchool);
  } catch (error) {
    throw (
      toServiceError(error) ??
      new ServiceUnavailable("Skolengo est indisponible")
    );
  }
}

/**
 * Prépare la connexion OIDC : l'adresse de l'ENT est ouverte au réseau, puis le défi PKCE et
 * l'adresse de la page de connexion sont calculés. `flow` garde le secret du défi en mémoire :
 * `finalizeLogin` doit être appelé sur ce même objet.
 */
export async function prepareLogin(school: SkolengoSchool): Promise<AuthFlow> {
  await allowInstance(new URL(school.wellKnown).origin);
  const instance = new School(
    school.id,
    school.name,
    school.emsCode,
    school.wellKnown,
    {
      city: school.city ?? "",
      zipCode: school.postalCode,
    }
  );
  try {
    return await instance.initializeLogin(ChallengeMethod.S256);
  } catch (error) {
    throw (
      toServiceError(error) ??
      new ServiceUnavailable("Skolengo est indisponible")
    );
  }
}

/** Le code du retour OIDC, ou l'erreur envoyée par l'ENT. */
export interface SkolengoCallbackCode {
  code: string;
  state: string;
}

/** Termine la connexion : échange le code contre des jetons, puis lit le profil. */
export async function finalizeLogin(
  flow: AuthFlow,
  callback: SkolengoCallbackCode
): Promise<SkolengoClient> {
  // L'échange du code peut se faire sur un autre domaine que la page de connexion.
  await allowInstance(new URL(flow.endpoints.tokenEndpoint).origin);
  try {
    const client = await flow.finalizeLogin(callback.code, callback.state);
    if (client.kind !== Kind.STUDENT) {
      throw new ParentAccount();
    }
    return client;
  } catch (error) {
    throw (
      toServiceError(error) ??
      new ServiceUnavailable("Skolengo est indisponible")
    );
  }
}

export interface SkolengoLogin {
  secret: SkolengoSecret;
  profile: Omit<Account, "id" | "avatar">;
  /** L'adresse propre au compte, rouverte au réseau au lancement suivant. */
  instanceUrl: string;
}

/** Ce qu'il faut garder d'une connexion réussie. */
export function loginOf(client: SkolengoClient, flow: AuthFlow): SkolengoLogin {
  const wellKnown = flow.endpoints.wellKnown;
  return {
    secret: {
      userId: client.userId,
      refreshToken: client.refreshToken,
      tokenEndpoint: client.refreshURL || flow.endpoints.tokenEndpoint,
      wellKnown,
      emsCode: flow.school.emsCode,
    },
    profile: {
      firstName: client.firstName,
      lastName: client.lastName,
      schoolName: client.school.name,
      className: client.className || undefined,
    },
    instanceUrl: new URL(wellKnown).origin,
  };
}

/**
 * Vrai si ce secret du trousseau est celui du même élève que `login` : un même compte ajouté
 * deux fois ferait deux comptes dans Piéride. L'adresse se compare à part.
 */
export const isSameStudent =
  (login: SkolengoLogin) =>
  (secret: string): boolean => {
    let value: unknown;
    try {
      value = JSON.parse(secret);
    } catch {
      return false;
    }
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { userId?: unknown }).userId === login.secret.userId
    );
  };
