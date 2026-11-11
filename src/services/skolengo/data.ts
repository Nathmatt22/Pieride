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
  type Subject as SkolengoSubject,
} from "skolengojs";

import { addDays } from "@/lib/week";

import { ServiceUnavailable } from "../shared/errors";
import type {
  Attachment,
  Attendance,
  Course,
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
 * dans l'API : elles sont toujours proposées, comme dans Papillon.
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
        const days = await client.GetTimetable(weekStart, to);
        return days
          .flatMap(day => day.lessons.map(toCourse))
          .filter(course => course.from >= weekStart && course.from < to);
      }),
  };

  const homework: CapabilityMethods["HOMEWORK"] = {
    getHomeworks: weekStart =>
      session.run(async client => {
        const to = addDays(weekStart, 7);
        const found = await client.GetAssignments(weekStart, to);
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
    ...(allowed.has(Permissions.READ_ABSENCE_FILES) && {
      ATTENDANCE: attendance,
    }),
  };
}
