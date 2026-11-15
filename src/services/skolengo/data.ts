// Données Skolengo vers les modèles communs : emploi du temps, devoirs, notes, actualités et
// absences, d'après services/skolengo de Papillon (GPLv3). Les types sont ceux de skolengojs.
import { Buffer } from "buffer";
import {
  type Assignment,
  type Attachment as SkolengoAttachment,
  type AttendanceItem,
  AttendanceItemState,
  AttendanceItemType,
  type Grade as SkolengoGrade,
  type Lesson,
  type News as SkolengoNews,
  Permissions,
  type Skolengo as SkolengoClient,
  type Subject as SkolengoSubject,
} from "skolengojs";

import { log } from "@/lib/log";
import { addDays } from "@/lib/week";

import { ServiceUnavailable } from "../shared/errors";
import type {
  Attachment,
  Attendance,
  Course,
  CourseContent,
  Grade,
  Homework,
  News,
  Period,
  PeriodGrades,
} from "../shared/models";
import type { CapabilityMethods } from "../shared/plugin";
import type { SkolengoSession } from "./session";

const finite = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? value : undefined;

const positive = (value: number | undefined) => {
  const found = finite(value);
  return found !== undefined && found > 0 ? found : undefined;
};

const joined = (names: readonly string[]) => names.join(", ") || undefined;

const SKOLENGO_API = "https://api.skolengo.com/api/v1/bff-sko-app";

/** Le jeton est protégé dans les types du SDK, mais public à l'exécution. */
const accessTokenOf = (client: SkolengoClient) =>
  (client as unknown as { accessToken?: string }).accessToken;

/**
 * Les identifiants élève que `/absence-files` peut attendre : celui du profil et le `sub`
 * du jeton. Le second n'est pas toujours le même (le `sub` est un identifiant de compte),
 * et un 403 sur l'un ne dit pas lequel est le bon : on essaie les deux.
 */
function studentIdsOf(
  client: SkolengoClient
): { id: string; source: string }[] {
  const candidates = [{ id: client.userId, source: "profil" }];
  const token = accessTokenOf(client);
  if (token) {
    try {
      const part = token.split(".")[1];
      if (part) {
        // `base64url` (JWT), ramené à `base64` pour `Buffer`.
        const claims = JSON.parse(
          Buffer.from(
            part.replace(/-/g, "+").replace(/_/g, "/"),
            "base64"
          ).toString("utf8")
        ) as { sub?: unknown };
        if (
          typeof claims.sub === "string" &&
          claims.sub &&
          claims.sub !== client.userId
        ) {
          candidates.push({ id: claims.sub, source: "jeton" });
        }
      }
    } catch {
      // Jeton opaque : seul l'identifiant du profil est disponible.
    }
  }
  return candidates;
}

interface RawResource {
  id?: unknown;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
  [key: string]: unknown;
}

interface RawRef {
  id: string;
}

const isRef = (value: unknown): value is RawRef =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string";

/** Les identifiants d'une relation JSON:API, simple ou multiple. */
const refs = (relationship: unknown): RawRef[] => {
  const data = (relationship as { data?: unknown } | undefined)?.data;
  if (Array.isArray(data)) {
    return data.filter(isRef);
  }
  return isRef(data) ? [data] : [];
};

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : undefined;

/** Un champ d'une ressource JSON:API, ou d'une ressource déjà désérialisée. */
const field = (resource: RawResource, key: string) =>
  resource.attributes?.[key] ?? resource[key];

/** Les ressources d'une liste JSON:API ou d'un tableau déjà désérialisé. */
const resourceList = (value: unknown): RawResource[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is RawResource => typeof item === "object" && item !== null
  );
};

/** Une pièce jointe, qu'elle vienne de `included` ou qu'elle soit déjà imbriquée. */
const fileOf = (
  attachment: RawResource,
  lessonId: string
): Attachment | undefined => {
  const url = text(field(attachment, "url"));
  if (!url) {
    return undefined;
  }
  return {
    kind: "file",
    name:
      text(field(attachment, "name")) ??
      text(field(attachment, "fileName")) ??
      text(field(attachment, "alternativeText")) ??
      "Pièce jointe",
    url,
    ref: JSON.stringify({ source: "lesson", id: lessonId, url }),
  };
};

/**
 * Le cahier de textes d'une leçon, tel que `/lessons/{id}` le renvoie : un contenu HTML,
 * ou un lien, avec ses pièces jointes. Les ressources sont retrouvées par leur identifiant,
 * sans dépendre du nom que Skolengo donne à leur type JSON:API.
 */
export function toCourseContents(
  payload: unknown,
  lessonId: string
): CourseContent[] {
  const body = payload as {
    data?: {
      attributes?: Record<string, unknown>;
      relationships?: Record<string, unknown>;
      contents?: unknown;
    };
    included?: unknown;
  };
  const included = resourceList(body?.included);
  const resources = new Map(
    included.flatMap(item =>
      typeof item.id === "string" ? [[item.id, item] as const] : []
    )
  );
  // Les identifiants de la relation, ou les contenus eux-mêmes s'ils sont déjà imbriqués.
  const listed = refs(body?.data?.relationships?.contents);
  const embedded = [
    ...resourceList(body?.data?.contents),
    ...resourceList(body?.data?.attributes?.contents),
  ];
  const contents = [
    ...listed.map(
      ({ id }) =>
        resources.get(id) ?? embedded.find(content => content.id === id)
    ),
    ...embedded.filter(content => !listed.some(({ id }) => id === content.id)),
  ];

  return contents.flatMap(content => {
    if (!content) {
      return [];
    }
    const title = text(field(content, "title"));
    const description =
      text(field(content, "html")) ??
      text(field(content, "content")) ??
      text(field(content, "text"));
    const attachments: Attachment[] = [];
    const seen = new Set<string>();
    const add = (attachment: Attachment | undefined) => {
      if (attachment && !seen.has(attachment.url)) {
        seen.add(attachment.url);
        attachments.push(attachment);
      }
    };
    for (const { id } of refs(content.relationships?.attachments)) {
      const file = resources.get(id);
      if (file) {
        add(fileOf(file, lessonId));
      }
    }
    // Un contenu peut aussi porter ses pièces jointes déjà désérialisées.
    for (const file of resourceList(field(content, "attachments"))) {
      add(fileOf(file, lessonId));
    }
    const link = text(field(content, "url"));
    if (link) {
      add({ kind: "link", name: title ?? link, url: link });
    }
    if (!title && !description && attachments.length === 0) {
      return [];
    }
    return [{ title, description, category: undefined, attachments }];
  });
}

/** Le détail d'une leçon, demandé seulement quand l'élève ouvre le cours. */
export async function getCourseContents(
  client: SkolengoClient,
  lessonId: string
): Promise<CourseContent[]> {
  // Le jeton peut avoir expiré depuis la dernière requête du SDK : il le renouvelle lui-même.
  await client.refreshAccessToken();
  const token = accessTokenOf(client);
  if (!token) {
    throw new ServiceUnavailable("Session Skolengo sans jeton");
  }
  const query = new URLSearchParams({
    include:
      "teachers,contents,contents.attachments,subject,toDoForTheLesson,toDoForTheLesson.subject,toDoAfterTheLesson,toDoAfterTheLesson.subject",
    "filter[student.id]": client.userId,
  });
  const response = await fetch(
    `${SKOLENGO_API}/lessons/${encodeURIComponent(lessonId)}?${query}`,
    {
      // Mêmes en-têtes que le SDK, qui n'envoie pas d'`Accept` : un serveur strict
      // répond 406 à `application/vnd.api+json`.
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Skolengo-Date-Format": "utc",
        "X-Skolengo-School-Id": client.school.id,
        "X-Skolengo-Ems-Code": client.school.emsCode,
      },
      credentials: "omit",
    }
  );
  if (!response.ok) {
    log(
      "warn",
      "skolengo",
      `Cahier de texte ${lessonId} : HTTP ${response.status}`
    );
    throw new Error(`${response.status}: Skolengo`);
  }
  const payload = await response.json();
  const contents = toCourseContents(payload, lessonId);
  if (contents.length === 0) {
    // De quoi savoir si Skolengo annonce un contenu (anyContent) sans l'envoyer.
    const body = payload as {
      data?: { attributes?: { anyContent?: unknown } };
      included?: unknown;
    };
    log(
      "warn",
      "skolengo",
      `Cahier de texte ${lessonId} : aucun contenu (anyContent=${String(
        body.data?.attributes?.anyContent
      )}, ${Array.isArray(body.included) ? body.included.length : 0} ressources incluses)`
    );
  }
  return contents;
}

/** L'identifiant de la leçon dans celui d'un cours (`<leçon>@<début>`). */
const lessonIdOf = (courseId: string) => {
  const at = courseId.lastIndexOf("@");
  return at > 0 ? courseId.slice(0, at) : courseId;
};

/** Le nombre d'absences demandées par page : le serveur en renvoie 20 au plus. */
const ATTENDANCE_PAGE = 20;
/** Au-delà, on s'arrête : un élève n'a pas 500 absences dans l'année. */
const ATTENDANCE_MAX_PAGES = 25;

/** Une date d'un fichier d'absence, ou une date invalide (filtrée par `validAttendance`). */
const dateOf = (value: unknown) =>
  new Date(typeof value === "string" ? value : "");

/**
 * Une entrée de `/absence-files`, avec son état courant et son motif. Le type `CLATENESS`
 * (retard de cours) de certaines instances est ramené à un retard, et `LOCKED` (dossier
 * traité) à une absence justifiée.
 */
function attendanceOf(
  file: RawResource,
  included: readonly RawResource[]
): AttendanceItem | undefined {
  if (typeof file.id !== "string" || !file.id) {
    return undefined;
  }
  const stateId = refs(file.relationships?.currentState)[0]?.id;
  const state = stateId
    ? (included.find(resource => resource.id === stateId) ?? undefined)
    : undefined;
  const reasonId =
    refs(state?.relationships?.absenceReason)[0]?.id ??
    refs(file.relationships?.absenceReason)[0]?.id;
  const reason = reasonId
    ? included.find(resource => resource.id === reasonId)
    : undefined;
  // Les dates et le type sont sur le fichier, l'état courant porte le statut : chaque
  // attribut est cherché sur l'état puis sur le fichier, comme le fait scolengo-api.
  const attribute = (key: string) =>
    field(state ?? {}, key) ?? field(file, key);
  const type = String(attribute("absenceType") ?? "ABSENCE")
    .toUpperCase()
    .includes("LATENESS")
    ? AttendanceItemType.LATENESS
    : AttendanceItemType.ABSENCE;
  const status = String(attribute("absenceFileStatus") ?? "OPEN").toUpperCase();
  return {
    id: file.id,
    creationDate: dateOf(attribute("creationDateTime")),
    startDate: dateOf(attribute("absenceStartDateTime")),
    endDate: dateOf(attribute("absenceEndDateTime")),
    type,
    state:
      status === "LOCKED"
        ? AttendanceItemState.LOCKED
        : AttendanceItemState.OPEN,
    reason:
      text(field(reason ?? {}, "longLabel")) ??
      text(field(reason ?? {}, "shortLabel")) ??
      text(field(reason ?? {}, "label")) ??
      text(field(reason ?? {}, "code")) ??
      "",
  };
}

/**
 * Toutes les absences et retards de l'élève, page par page. Le SDK s'arrête à la première
 * page (20 éléments) : les plus anciennes disparaîtraient au fil de l'année.
 */
export async function getAttendanceItems(
  client: SkolengoClient
): Promise<AttendanceItem[]> {
  await client.refreshAccessToken();
  const token = accessTokenOf(client);
  if (!token) {
    throw new ServiceUnavailable("Session Skolengo sans jeton");
  }
  if (!client.permissions?.includes(Permissions.READ_ABSENCE_FILES)) {
    // L'établissement ne partage peut-être pas les absences : le 403 qui suit le confirme.
    log("warn", "skolengo", "Absences : droit READ_ABSENCE_FILES absent");
  }
  const found = new Map<string, AttendanceItem>();
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-Skolengo-Date-Format": "utc",
    "X-Skolengo-School-Id": client.school.id,
    "X-Skolengo-Ems-Code": client.school.emsCode,
  };
  const candidates = studentIdsOf(client);
  let candidate = 0;
  for (let page = 0; page < ATTENDANCE_MAX_PAGES; page++) {
    const query = new URLSearchParams({
      "filter[student.id]": candidates[candidate]!.id,
      include:
        "currentState,currentState.absenceReason,currentState.absenceRecurrence",
      "page[limit]": String(ATTENDANCE_PAGE),
      "page[offset]": String(page * ATTENDANCE_PAGE),
    });
    const request = () =>
      fetch(`${SKOLENGO_API}/absence-files?${query}`, {
        headers,
        credentials: "omit",
      });
    let response = await request();
    if (response.status === 403 && candidate + 1 < candidates.length) {
      const refused = candidates[candidate]!.source;
      candidate += 1;
      log(
        "warn",
        "skolengo",
        `Absences : 403 avec l'identifiant du ${refused}, nouvel essai avec celui du ${candidates[candidate]!.source}`
      );
      query.set("filter[student.id]", candidates[candidate]!.id);
      response = await request();
    }
    if (page === 0 && candidate > 0 && response.ok) {
      log(
        "info",
        "skolengo",
        `Absences : identifiant du ${candidates[candidate]!.source} accepté`
      );
    }
    if (!response.ok) {
      // De quoi distinguer un droit absent (403) d'une panne (5xx), et savoir si
      // l'établissement a souscrit au module absences (`ABS`).
      const services = client.school.subscribedServices?.join(",") ?? "?";
      log(
        "warn",
        "skolengo",
        `Absences : HTTP ${response.status} (services ${services})`
      );
      if (response.status === 403) {
        const detail = (await response.json().catch(() => null)) as {
          errors?: { code?: string; title?: string }[];
        } | null;
        log(
          "warn",
          "skolengo",
          `Absences : ${detail?.errors?.[0]?.code ?? detail?.errors?.[0]?.title ?? "sans détail"}`
        );
      }
      throw new Error(`${response.status}: Skolengo`);
    }
    let body: {
      data?: unknown;
      included?: unknown;
      meta?: { page?: { total?: number }; total?: number };
    };
    try {
      body = await response.json();
    } catch (error) {
      log("warn", "skolengo", "Absences : réponse illisible");
      throw error;
    }
    const files = resourceList(body.data).filter(
      file => file.type === undefined || file.type === "absenceFile"
    );
    const included = resourceList(body.included);
    let added = 0;
    for (const file of files) {
      const item = attendanceOf(file, included);
      if (item && !found.has(item.id)) {
        found.set(item.id, item);
        added += 1;
      }
    }
    const total = body.meta?.page?.total ?? body.meta?.total;
    if (
      added === 0 ||
      files.length < ATTENDANCE_PAGE ||
      (typeof total === "number" && found.size >= total)
    ) {
      break;
    }
  }
  return [...found.values()];
}

/** Une absence sans dates exploitables ne doit pas faire échouer l'enregistrement des autres. */
const validAttendance = (item: AttendanceItem) => {
  const start = item.startDate.getTime();
  const end = item.endDate.getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end >= start;
};

export function toCourse(lesson: Lesson): Course {
  return {
    // Un cours qui revient chaque semaine garde son identifiant : l'heure de début en fait
    // une séance unique.
    id: `${lesson.id}@${lesson.startDateTime.toISOString()}`,
    subject: lesson.subject?.label ?? "Cours",
    from: lesson.startDateTime,
    to: lesson.endDateTime,
    room: lesson.room || undefined,
    teacher:
      joined(
        (lesson.teacher ?? []).map(teacher =>
          `${teacher.firstName} ${teacher.lastName}`.trim()
        )
      ) ?? undefined,
    status: lesson.canceled ? "canceled" : undefined,
  };
}

const homeworkAttachment =
  (assignmentId: string) =>
  (attachment: SkolengoAttachment): Attachment => ({
    kind: "file",
    name: attachment.fileName || "Pièce jointe",
    url: attachment.url,
    ref: JSON.stringify({ source: "homework", id: assignmentId }),
  });

/** `attachments` : celles déjà demandées au service pour ce devoir. */
export function toHomework(
  assignment: Assignment,
  attachments: readonly SkolengoAttachment[]
): Homework {
  return {
    id: assignment.id,
    subject: assignment.subject?.label ?? "Devoir",
    content: assignment.html,
    dueAt: assignment.dueDateTime,
    done: assignment.done,
    attachments: attachments.map(homeworkAttachment(assignment.id)),
  };
}

/** L'actualité telle que Skolengo l'envoie. Lue et accusée de réception restent locales. */
export function toNews(item: SkolengoNews, known?: News): News {
  const attachments: Attachment[] = [];
  if (item.illustration?.url) {
    attachments.push({
      kind: "file",
      name: item.illustration.fileName || "Illustration",
      url: item.illustration.url,
      ref: JSON.stringify({ source: "news", id: item.id }),
    });
  }
  if (item.linkedWebSiteUrl) {
    attachments.push({
      kind: "link",
      name: item.linkedWebSiteUrl,
      url: item.linkedWebSiteUrl,
    });
  }
  return {
    id: item.id,
    kind: "information",
    title: item.title || undefined,
    author: item.author?.name ?? "",
    date: item.publicationDateTime,
    content: item.content,
    read: known?.read ?? false,
    needsAcknowledgement: false,
    acknowledged: false,
    attachments,
  };
}

export function toAttendance(item: AttendanceItem): Attendance {
  const justified = item.state === AttendanceItemState.LOCKED;
  const durationMinutes = Math.max(
    0,
    Math.round((item.endDate.getTime() - item.startDate.getTime()) / 60_000)
  );
  if (item.type === AttendanceItemType.LATENESS) {
    return {
      id: item.id,
      kind: "delay",
      from: item.startDate,
      to: item.endDate,
      durationMinutes,
      reason: item.reason || undefined,
      justified,
    };
  }
  return {
    id: item.id,
    kind: "absence",
    from: item.startDate,
    to: item.endDate,
    durationMinutes,
    reason: item.reason || undefined,
    justified,
  };
}

export function toGrade(
  grade: SkolengoGrade,
  subject: string,
  periodId: string
): Grade {
  const graded = grade.isGraded && finite(grade.value) !== undefined;
  return {
    id: grade.id,
    subject: subject || grade.subject?.label || "Matière",
    periodId,
    title: grade.title || grade.topic || "",
    date: grade.date,
    value: graded ? grade.value : undefined,
    status: graded ? undefined : grade.notGradedReason || "Non noté",
    outOf: positive(grade.outOf) ?? 20,
    coefficient: positive(grade.coefficient) ?? 1,
    bonus: false,
    optional: false,
  };
}

/** Moyenne pondérée par les coefficients des matières, quand il y en a. */
function weightedAverage(
  subjects: readonly SkolengoSubject[],
  pick: (subject: SkolengoSubject) => number
): number | undefined {
  const graded = subjects.filter(
    subject =>
      finite(pick(subject)) !== undefined && positive(subject.coefficient)
  );
  const weight = graded.reduce(
    (sum, subject) => sum + (positive(subject.coefficient) ?? 0),
    0
  );
  if (weight === 0) {
    return undefined;
  }
  return (
    graded.reduce(
      (sum, subject) =>
        sum + (positive(subject.coefficient) ?? 0) * pick(subject),
      0
    ) / weight
  );
}

function toPeriodGrades(
  period: Period,
  subjects: readonly SkolengoSubject[]
): PeriodGrades {
  return {
    grades: subjects.flatMap(subject =>
      subject.grades.map(grade => toGrade(grade, subject.name, period.id))
    ),
    averages: subjects.map(subject => ({
      subject: subject.name,
      student: finite(subject.value),
      classAverage: finite(subject.average),
      outOf: positive(subject.outOf) ?? 20,
    })),
    overall: {
      student: weightedAverage(subjects, subject => subject.value),
      classAverage: weightedAverage(subjects, subject => subject.average),
    },
  };
}

/** L'année scolaire en cours (elle commence en septembre). */
function schoolYear(now: Date): Period {
  const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    id: `skolengo-year-${year}`,
    name: "Année scolaire",
    start: new Date(year, 8, 1),
    end: new Date(year + 1, 6, 31, 23, 59, 59, 999),
  };
}

/** Une période qui couvre les absences reçues, ou l'année scolaire s'il n'y en a aucune. */
export function attendancePeriod(
  items: readonly AttendanceItem[],
  now = new Date()
): Period {
  const times = items
    .flatMap(item => [item.startDate.getTime(), item.endDate.getTime()])
    .filter(Number.isFinite);
  if (times.length === 0) {
    return schoolYear(now);
  }
  const start = new Date(Math.min(...times));
  const end = new Date(Math.max(...times));
  return {
    id: `skolengo-attendance-${start.getTime()}`,
    name: "Année scolaire",
    start,
    end,
  };
}

/**
 * Les capabilities des droits ouverts à l'élève. Les actualités ne dépendent d'aucun droit
 * dans l'API : elles sont toujours proposées, comme dans Papillon. Les absences aussi :
 * l'API refuse elle-même l'accès si l'établissement ne l'autorise pas.
 */
export function capabilities(
  session: SkolengoSession,
  permissions: readonly Permissions[]
): Partial<CapabilityMethods> {
  const allowed = new Set(permissions);
  /** Les absences sont demandées une fois, puis filtrées par période. */
  let attendanceItems: AttendanceItem[] | null = null;

  const timetable: CapabilityMethods["TIMETABLE"] = {
    getWeeklyTimetable: weekStart =>
      session.run(async client => {
        const to = addDays(weekStart, 7);
        const days = await client.GetTimetable(weekStart, addDays(to, -1));
        return days
          .flatMap(day => day.lessons.map(toCourse))
          .filter(course => course.from >= weekStart && course.from < to);
      }),
    getCourseContents: courseId =>
      session.run(client => getCourseContents(client, lessonIdOf(courseId))),
  };

  const homework: CapabilityMethods["HOMEWORK"] = {
    getHomeworks: weekStart =>
      session.run(async client => {
        const to = addDays(weekStart, 7);
        const found = await client.GetAssignments(weekStart, addDays(to, -1));
        const list: Homework[] = [];
        // L'un après l'autre : chaque devoir a sa requête de pièces jointes.
        for (const assignment of found) {
          list.push(toHomework(assignment, await assignment.getAttachments()));
        }
        return list.filter(item => item.dueAt >= weekStart && item.dueAt < to);
      }),
    setHomeworkCompletion: (id, done) =>
      session.run(async client => {
        const now = new Date();
        const found = await client.GetAssignments(
          addDays(now, -365),
          addDays(now, 365)
        );
        const assignment = found.find(candidate => candidate.id === id);
        if (!assignment) {
          throw new ServiceUnavailable("Devoir introuvable chez Skolengo");
        }
        await assignment.setCompletion(done);
      }),
  };

  const grades: CapabilityMethods["GRADES"] = {
    getGradesPeriods: () =>
      session.run(async client =>
        (await client.GetGradesSettings()).periods.map((period): Period => ({
          id: period.id,
          name: period.label,
          start: period.startDate,
          end: period.endDate,
        }))
      ),
    getGradesForPeriod: period =>
      session.run(async client =>
        toPeriodGrades(period, await client.GetGradesForPeriod(period.id))
      ),
  };

  const news: CapabilityMethods["NEWS"] = {
    getNews: known =>
      session.run(async client =>
        (await client.GetNews()).map(item => toNews(item, known.get(item.id)))
      ),
    // Lu et accusé de réception restent dans la base locale : l'API n'en garde rien.
    setNewsAsRead: async () => undefined,
    setNewsAsAcknowledged: async () => undefined,
  };

  const attendance: CapabilityMethods["ATTENDANCE"] = {
    getAttendancePeriods: async () => {
      attendanceItems = await session.run(getAttendanceItems);
      return [attendancePeriod(attendanceItems)];
    },
    getAttendanceForPeriod: async period => {
      attendanceItems ??= await session.run(getAttendanceItems);
      const valid = attendanceItems.filter(validAttendance);
      if (valid.length < attendanceItems.length) {
        log(
          "warn",
          "skolengo",
          `Absences : ${attendanceItems.length - valid.length} sans dates exploitables`
        );
      }
      return valid
        .filter(
          item => item.startDate >= period.start && item.startDate <= period.end
        )
        .map(toAttendance);
    },
  };

  return {
    ...(allowed.has(Permissions.READ_LESSONS) && { TIMETABLE: timetable }),
    ...(allowed.has(Permissions.READ_ASSIGNMENTS) && { HOMEWORK: homework }),
    ...(allowed.has(Permissions.READ_EVALUATIONS) && { GRADES: grades }),
    NEWS: news,
    // L'API refuse elle-même l'accès : on demande toujours, comme Papillon, pour ne pas
    // dépendre d'un droit que certains établissements n'annoncent pas dans `permissions`.
    ATTENDANCE: attendance,
  };
}
