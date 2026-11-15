import {
  type Assignment,
  type Attachment as SkolengoAttachment,
  type AttendanceItem,
  AttendanceItemState,
  AttendanceItemType,
  type Lesson,
  type News as SkolengoNews,
  Permissions,
} from "skolengojs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attendancePeriod,
  capabilities,
  getCourseContents,
  toAttendance,
  toCourse,
  toCourseContents,
  toHomework,
  toNews,
} from "./data";
import type { SkolengoSession } from "./session";

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

describe("toCourseContents", () => {
  it("reprend le HTML et rattache les pièces jointes de la leçon", () => {
    const payload = {
      data: {
        relationships: {
          contents: { data: [{ id: "content-1", type: "lessonContent" }] },
        },
      },
      included: [
        {
          id: "content-1",
          type: "lessonContent",
          attributes: {
            title: "Chapitre 3",
            html: "<p>Lire le chapitre 3.</p>",
          },
          relationships: {
            attachments: {
              data: [{ id: "file-1", type: "attachment" }],
            },
          },
        },
        {
          id: "file-1",
          type: "attachment",
          attributes: {
            name: "chapitre-3.pdf",
            url: "https://api.skolengo.com/fichier",
          },
        },
      ],
    };

    const [content] = toCourseContents(payload, "ESKO-L-1");

    expect(content).toMatchObject({
      title: "Chapitre 3",
      description: "<p>Lire le chapitre 3.</p>",
    });
    expect(content?.attachments[0]).toMatchObject({
      kind: "file",
      name: "chapitre-3.pdf",
      url: "https://api.skolengo.com/fichier",
    });
    expect(JSON.parse(content?.attachments[0]?.ref ?? "")).toEqual({
      source: "lesson",
      id: "ESKO-L-1",
      url: "https://api.skolengo.com/fichier",
    });
  });

  it("ignore une leçon sans contenu", () => {
    expect(
      toCourseContents({ data: { relationships: {} } }, "ESKO-L-1")
    ).toEqual([]);
  });

  it("lit les contenus déjà imbriqués et leurs pièces jointes", () => {
    const payload = {
      data: {
        contents: [
          {
            id: "content-1",
            title: "Chapitre 4",
            html: "<p>Exercices 1 à 4.</p>",
            attachments: [
              {
                id: "file-1",
                fileName: "exercices.pdf",
                url: "https://api.skolengo.com/fichier",
              },
            ],
          },
        ],
      },
    };

    const [content] = toCourseContents(payload, "ESKO-L-1");

    expect(content).toMatchObject({
      title: "Chapitre 4",
      description: "<p>Exercices 1 à 4.</p>",
    });
    expect(content?.attachments[0]).toMatchObject({
      kind: "file",
      name: "exercices.pdf",
    });
  });
});

describe("getCourseContents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("demande le détail de la leçon avec le jeton de la session", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: {
              relationships: {
                contents: { data: [{ id: "content-1" }] },
              },
            },
            included: [
              {
                id: "content-1",
                attributes: { title: "Chapitre 3" },
              },
            ],
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = {
      accessToken: "token",
      userId: "student",
      school: { id: "school", emsCode: "ems" },
      refreshAccessToken: vi.fn(async () => false),
    } as unknown as Parameters<typeof getCourseContents>[0];

    const contents = await getCourseContents(client, "ESKO-L-1");

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const url = decodeURIComponent(String(input));
    expect(url).toContain("/lessons/ESKO-L-1");
    expect(url).toContain("include=teachers,contents,contents.attachments");
    expect(url).toContain("filter[student.id]=student");
    expect(init).toMatchObject({
      headers: { Authorization: "Bearer token" },
    });
    expect(contents).toMatchObject([{ title: "Chapitre 3" }]);
  });
});

describe("capabilities TIMETABLE", () => {
  it("demande la semaine du lundi au dimanche", async () => {
    const getTimetable = vi.fn(async () => []);
    const session = {
      run: async <T>(
        request: (client: { GetTimetable: typeof getTimetable }) => Promise<T>
      ) => request({ GetTimetable: getTimetable }),
    } as unknown as SkolengoSession;
    const methods = capabilities(session, [Permissions.READ_LESSONS]);
    const monday = new Date(2026, 10, 16);

    await methods.TIMETABLE?.getWeeklyTimetable(monday);

    expect(getTimetable).toHaveBeenCalledWith(monday, new Date(2026, 10, 22));
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

  it("reste disponible sans droit annoncé et ignore les dates invalides", async () => {
    const valid = item({});
    const invalid = item({
      id: "ESKO-A-INVALIDE",
      startDate: new Date(""),
      endDate: new Date(""),
    });
    const session = {
      run: async <T>(
        request: (client: {
          GetAttendanceItems: () => Promise<AttendanceItem[]>;
        }) => Promise<T>
      ) => request({ GetAttendanceItems: async () => [valid, invalid] }),
    } as unknown as SkolengoSession;
    const methods = capabilities(session, []).ATTENDANCE;

    expect(methods).toBeDefined();
    const [period] = await methods!.getAttendancePeriods();
    expect(period).toBeDefined();
    expect(
      (await methods!.getAttendanceForPeriod(period!)).map(({ id }) => id)
    ).toEqual(["ESKO-A-1"]);
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
