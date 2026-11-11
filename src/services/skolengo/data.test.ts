import {
  type Assignment,
  type Attachment as SkolengoAttachment,
  type AttendanceItem,
  AttendanceItemState,
  AttendanceItemType,
  type Lesson,
  type News as SkolengoNews,
} from "skolengojs";
import { describe, expect, it } from "vitest";

import {
  attendancePeriod,
  toAttendance,
  toCourse,
  toHomework,
  toNews,
} from "./data";

const lesson = (overrides: Partial<Lesson> = {}) =>
  ({
    id: "ESKO-L-1",
    startDateTime: new Date("2026-11-09T08:00:00Z"),
    endDateTime: new Date("2026-11-09T10:00:00Z"),
    room: "B12",
    canceled: false,
    subject: { id: "maths", label: "Mathématiques", color: "#2b2bc2" },
    teacher: [{ firstName: "Ada", lastName: "Lovelace" }],
    ...overrides,
  }) as Lesson;

describe("toCourse", () => {
  it("garde l'heure de début dans l'identifiant et joint les professeurs", () => {
    expect(toCourse(lesson())).toMatchObject({
      id: "ESKO-L-1@2026-11-09T08:00:00.000Z",
      subject: "Mathématiques",
      room: "B12",
      teacher: "Ada Lovelace",
      status: undefined,
    });
  });

  it("signale un cours annulé", () => {
    expect(toCourse(lesson({ canceled: true })).status).toBe("canceled");
  });
});

describe("toHomework", () => {
  it("rattache chaque pièce jointe au devoir", () => {
    const assignment = {
      id: "ESKO-H-1",
      done: false,
      html: "<p>Lire le chapitre 2.</p>",
      dueDateTime: new Date("2026-11-12T08:00:00Z"),
      subject: { id: "fr", label: "Français", color: "#fff" },
    } as Assignment;
    const attachment = {
      url: "https://api.skolengo.com/fichier",
      fileName: "chapitre-2.pdf",
    } as SkolengoAttachment;

    const homework = toHomework(assignment, [attachment]);

    expect(homework).toMatchObject({
      id: "ESKO-H-1",
      subject: "Français",
      done: false,
      dueAt: new Date("2026-11-12T08:00:00Z"),
    });
    expect(homework.attachments[0]).toMatchObject({
      kind: "file",
      name: "chapitre-2.pdf",
      url: "https://api.skolengo.com/fichier",
    });
    expect(JSON.parse(homework.attachments[0]?.ref ?? "")).toEqual({
      source: "homework",
      id: "ESKO-H-1",
    });
  });
});

describe("toNews", () => {
  it("garde l'illustration et le lien, et le statut de lecture local", () => {
    const item = {
      id: "ESKO-N-1",
      title: "Sortie au musée",
      publicationDateTime: new Date("2026-11-08T10:00:00Z"),
      content: "<p>Départ à 8 h.</p>",
      author: { id: "a", name: "Vie scolaire" },
      linkedWebSiteUrl: "https://exemple.fr/sortie",
      illustration: {
        url: "https://api.skolengo.com/image",
        fileName: "affiche.jpg",
      },
    } as unknown as SkolengoNews;

    const known = {
      id: "ESKO-N-1",
      kind: "information" as const,
      author: "Vie scolaire",
      date: new Date("2026-11-08T10:00:00Z"),
      content: "<p>Départ à 8 h.</p>",
      read: true,
      needsAcknowledgement: false,
      acknowledged: false,
      attachments: [],
    };

    expect(toNews(item, known)).toMatchObject({
      title: "Sortie au musée",
      author: "Vie scolaire",
      read: true,
    });
    expect(toNews(item).read).toBe(false);
    expect(toNews(item).attachments.map(({ kind }) => kind)).toEqual([
      "file",
      "link",
    ]);
  });
});

describe("absence et retard", () => {
  const item = (overrides: Partial<AttendanceItem>) =>
    ({
      id: "ESKO-A-1",
      creationDate: new Date("2026-11-09T08:00:00Z"),
      startDate: new Date("2026-11-09T08:00:00Z"),
      endDate: new Date("2026-11-09T10:00:00Z"),
      type: AttendanceItemType.ABSENCE,
      state: AttendanceItemState.LOCKED,
      reason: "Maladie",
      ...overrides,
    }) as AttendanceItem;

  it("compte la durée en minutes et reprend le motif", () => {
    expect(toAttendance(item({}))).toEqual({
      id: "ESKO-A-1",
      kind: "absence",
      from: new Date("2026-11-09T08:00:00Z"),
      to: new Date("2026-11-09T10:00:00Z"),
      durationMinutes: 120,
      reason: "Maladie",
      justified: true,
    });
  });

  it("distingue un retard d'une absence", () => {
    expect(
      toAttendance(
        item({
          type: AttendanceItemType.LATENESS,
          state: AttendanceItemState.OPEN,
          reason: "",
        })
      )
    ).toMatchObject({ kind: "delay", reason: undefined, justified: false });
  });

  it("couvre les absences reçues, ou l'année scolaire sans aucune", () => {
    const period = attendancePeriod([
      item({ startDate: new Date("2026-10-01T08:00:00Z") }),
      item({
        id: "ESKO-A-2",
        startDate: new Date("2026-11-20T08:00:00Z"),
        endDate: new Date("2026-11-20T09:00:00Z"),
      }),
    ]);
    expect(period.start).toEqual(new Date("2026-10-01T08:00:00Z"));
    expect(period.end).toEqual(new Date("2026-11-20T09:00:00Z"));

    const year = attendancePeriod([], new Date("2026-11-11T12:00:00Z"));
    expect(year.name).toBe("Année scolaire");
    expect(year.start.getFullYear()).toBe(2026);
    expect(year.end.getFullYear()).toBe(2027);
  });
});
