// Données Skolengo vers les modèles communs : emploi du temps, devoirs, notes, actualités et
// absences, d'après services/skolengo de Papillon (GPLv3). Les types sont ceux de skolengojs.
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

interface RawResource {
  id?: unknown;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
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
    data?: { relationships?: Record<string, unknown> };
    included?: unknown;
  };
  const included = Array.isArray(body?.included)
    ? body.included.filter(
        (item): item is RawResource => typeof item === "object" && item !== null
      )
    : [];
  const resources = new Map(
    included.flatMap(item =>
      typeof item.id === "string" ? [[item.id, item] as const] : []
    )
  );

  return refs(body?.data?.relationships?.contents).flatMap(({ id }) => {
    const content = resources.get(id);
    if (!content) {
      return [];
    }
    const title = text(content.attributes?.title);
    const description = text(content.attributes?.html);
    const link = text(content.attributes?.url);
    const attachments: Attachment[] = refs(
      content.relationships?.attachments
    ).flatMap(({ id: attachmentId }) => {
      const attachment = resources.get(attachmentId);
      const url = text(attachment?.attributes?.url);
      if (!attachment || !url) {
        return [];
      }
      return [
        {
          kind: "file",
          name:
            text(attachment.attributes?.name) ??
            text(attachment.attributes?.fileName) ??
            text(attachment.attributes?.alternativeText) ??
            "Pièce jointe",
          url,
          ref: JSON.stringify({ source: "lesson", id: lessonId, url }),
        },
      ];
    });
    if (link) {
      attachments.push({
        kind: "link",
        name: title ?? link,
        url: link,
      });
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
  const token = accessTokenOf(client);
  if (!token) {
    throw new ServiceUnavailable("Session Skolengo sans jeton");
  }
  const query = new URLSearchParams({
    include: "contents,contents.attachments",
    "filter[student.id]": client.userId,
  });
  const response = await fetch(
    `${SKOLENGO_API}/lessons/${encodeURIComponent(lessonId)}?${query}`,
    {
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
    throw new Error(`${response.status}: Skolengo`);
  }
  return toCourseContents(await response.json(), lessonId);
}

/** L'identifiant de la leçon dans celui d'un cours (`<leçon>@<début>`). */
const lessonIdOf = (courseId: string) => {
  const at = courseId.lastIndexOf("@");
  return at > 0 ? courseId.slice(0, at) : courseId;
};

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
      attendanceItems = await session.run(client =>
        client.GetAttendanceItems()
      );
      return [attendancePeriod(attendanceItems)];
    },
    getAttendanceForPeriod: async period => {
      attendanceItems ??= await session.run(client =>
        client.GetAttendanceItems()
      );
      return attendanceItems
        .filter(validAttendance)
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
