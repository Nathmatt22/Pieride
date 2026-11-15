// Le cahier de textes d'une séance quand le service ne le donne pas avec l'emploi du temps
// (Skolengo). Demandé à l'ouverture du cours, puis gardé pour ce rendu.
import { useEffect, useState } from "react";

import { htmlToText } from "@/lib/html";
import { accountManager } from "@/services";
import type { Course, CourseContent } from "@/services/shared/models";

interface Loaded {
  key: string;
  contents?: CourseContent[];
}

export function useCourseContents(
  serviceId: string | undefined,
  course: Course
): CourseContent[] | undefined {
  const stored = course.contents;
  const key = `${serviceId ?? ""}:${course.id}`;
  const [loaded, setLoaded] = useState<Loaded>({ key, contents: stored });

  useEffect(() => {
    if (!serviceId || stored?.length) {
      return;
    }
    let active = true;
    accountManager.courseContents(serviceId, course.id).then(
      next => {
        if (!active) {
          return;
        }
        const cleaned = next.map(content => ({
          ...content,
          description: content.description && htmlToText(content.description),
        }));
        setLoaded({
          key,
          contents: cleaned.length > 0 ? cleaned : undefined,
        });
      },
      () => {
        if (active) {
          setLoaded({ key, contents: undefined });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [serviceId, course.id, key, stored]);

  if (stored?.length) {
    return stored;
  }
  return loaded.key === key ? loaded.contents : undefined;
}
