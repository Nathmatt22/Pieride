// Le cahier de textes d'une séance quand le service ne le donne pas avec l'emploi du temps
// (Skolengo). Demandé à l'ouverture du cours, puis gardé pour ce rendu. Un échec est visible
// (et retentable) : sans cela, un cours sans contenu et un cours dont la requête a échoué se
// ressemblaient.
import { useCallback, useEffect, useState } from "react";

import { htmlToText } from "@/lib/html";
import { log } from "@/lib/log";
import { accountManager } from "@/services";
import type { Course, CourseContent } from "@/services/shared/models";

/** `unsupported` : le service ne sait pas fournir le cahier de textes (PRONOTE, iCal…). */
export type CourseContentsStatus =
  "loading" | "ready" | "unsupported" | "error";

interface Loaded {
  key: string;
  status: "ready" | "error" | "unsupported";
  contents: CourseContent[];
}

export interface CourseContentsState {
  status: CourseContentsStatus;
  contents: CourseContent[];
  retry(): void;
}

export function useCourseContents(
  serviceId: string | undefined,
  course: Course
): CourseContentsState {
  const stored = course.contents?.length ? course.contents : undefined;
  const key = `${serviceId ?? ""}:${course.id}`;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    // Ce que la synchro a déjà donné n'est pas redemandé.
    if (!serviceId || stored) {
      return;
    }
    let active = true;
    accountManager.courseContents(serviceId, course.id).then(
      next => {
        if (!active) {
          return;
        }
        if (!next) {
          // Le service ne fournit pas cette capability : rien à afficher.
          setLoaded({ key, status: "unsupported", contents: [] });
          return;
        }
        setLoaded({
          key,
          status: "ready",
          contents: next.map(content => ({
            ...content,
            description: content.description && htmlToText(content.description),
          })),
        });
      },
      (error: unknown) => {
        if (!active) {
          return;
        }
        log(
          "warn",
          "cours",
          `Cahier de texte indisponible : ${
            error instanceof Error
              ? error.message.slice(0, 120)
              : "erreur inconnue"
          }`
        );
        setLoaded({ key, status: "error", contents: [] });
      }
    );
    return () => {
      active = false;
    };
  }, [serviceId, course.id, key, stored, attempt]);

  const retry = useCallback(() => {
    setLoaded(null);
    setAttempt(value => value + 1);
  }, []);

  if (stored) {
    return { status: "ready", contents: stored, retry };
  }
  if (!serviceId) {
    return { status: "unsupported", contents: [], retry };
  }
  if (loaded?.key !== key) {
    return { status: "loading", contents: [], retry };
  }
  return { status: loaded.status, contents: loaded.contents, retry };
}
