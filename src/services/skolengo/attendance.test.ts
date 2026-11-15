import {
  AttendanceItemState,
  AttendanceItemType,
  type Skolengo,
} from "skolengojs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getAttendanceItems } from "./data";

const client = () =>
  ({
    accessToken: "token",
    userId: "student",
    permissions: [],
    school: { id: "school", emsCode: "ems" },
    refreshAccessToken: vi.fn(async () => false),
  }) as unknown as Skolengo;

const pageOf = (ids: string[], total: number) =>
  new Response(
    JSON.stringify({
      data: ids.map(id => ({
        type: "absenceFile",
        id,
        relationships: {
          currentState: {
            data: { type: "absenceFileState", id: `state-${id}` },
          },
        },
      })),
      included: ids.flatMap(id => [
        {
          type: "absenceFileState",
          id: `state-${id}`,
          attributes: {
            creationDateTime: "2026-11-09T07:00:00Z",
            absenceStartDateTime: "2026-11-09T08:00:00Z",
            absenceEndDateTime: "2026-11-09T10:00:00Z",
            absenceType: id === "dernier" ? "CLATENESS" : "ABSENCE",
            absenceFileStatus: id === "dernier" ? "LOCKED" : "OPEN",
          },
          relationships: {
            absenceReason: {
              data: { type: "absenceReason", id: `reason-${id}` },
            },
          },
        },
        {
          type: "absenceReason",
          id: `reason-${id}`,
          attributes: { longLabel: "Maladie" },
        },
      ]),
      meta: { page: { total } },
    }),
    { status: 200, headers: { "Content-Type": "application/vnd.api+json" } }
  );

describe("getAttendanceItems", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lit toutes les pages et classe CLATENESS en retard justifié", async () => {
    const first = Array.from({ length: 20 }, (_, index) => `absence-${index}`);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = new URL(String(input));
        return url.searchParams.get("page[offset]") === "0"
          ? pageOf(first, 21)
          : pageOf(["dernier"], 21);
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    const items = await getAttendanceItems(client());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]));
    const secondUrl = decodeURIComponent(String(fetchMock.mock.calls[1]?.[0]));
    expect(firstUrl).toContain("page[limit]=20");
    expect(firstUrl).toContain("page[offset]=0");
    expect(firstUrl).toContain("include=currentState");
    expect(secondUrl).toContain("page[offset]=20");
    expect(items).toHaveLength(21);
    expect(items.find(item => item.id === "dernier")).toMatchObject({
      type: AttendanceItemType.LATENESS,
      state: AttendanceItemState.LOCKED,
      reason: "Maladie",
      startDate: new Date("2026-11-09T08:00:00Z"),
      endDate: new Date("2026-11-09T10:00:00Z"),
    });
    expect(items.find(item => item.id === "absence-0")).toMatchObject({
      type: AttendanceItemType.ABSENCE,
      state: AttendanceItemState.OPEN,
    });
  });

  it("lit les dates sur le fichier quand l'état ne les porte pas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  type: "absenceFile",
                  id: "absence-1",
                  attributes: {
                    creationDateTime: "2026-11-09T07:00:00Z",
                    absenceStartDateTime: "2026-11-09T08:00:00Z",
                    absenceEndDateTime: "2026-11-09T10:00:00Z",
                    absenceType: "ABSENCE",
                    absenceFileStatus: "LOCKED",
                  },
                  relationships: {
                    currentState: {
                      data: { type: "absenceFileState", id: "state-1" },
                    },
                  },
                },
              ],
              included: [
                { type: "absenceFileState", id: "state-1", attributes: {} },
              ],
              meta: { page: { total: 1 } },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/vnd.api+json" },
            }
          )
      )
    );

    const [item] = await getAttendanceItems(client());

    expect(item).toMatchObject({
      id: "absence-1",
      type: AttendanceItemType.ABSENCE,
      state: AttendanceItemState.LOCKED,
      startDate: new Date("2026-11-09T08:00:00Z"),
      endDate: new Date("2026-11-09T10:00:00Z"),
    });
  });

  it("réessaie avec l'identifiant du jeton quand le profil est refusé", async () => {
    const payload = Buffer.from(
      JSON.stringify({ sub: "student-sub" })
    ).toString("base64");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return url.searchParams.get("filter[student.id]") === "student"
        ? new Response(JSON.stringify({ errors: [{ code: "FORBIDDEN" }] }), {
            status: 403,
          })
        : pageOf(["absence-1"], 1);
    });
    vi.stubGlobal("fetch", fetchMock);
    const skolengo = client();
    (skolengo as unknown as { accessToken: string }).accessToken =
      `entete.${payload}.signature`;

    const items = await getAttendanceItems(skolengo);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url = decodeURIComponent(String(fetchMock.mock.calls[1]?.[0]));
    expect(url).toContain("filter[student.id]=student-sub");
    expect(items.map(({ id }) => id)).toEqual(["absence-1"]);
  });

  it("ne réessaie pas sans filtre et signale le refus", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ code: "FORBIDDEN" }] }), {
          status: 403,
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAttendanceItems(client())).rejects.toThrow("403");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("s'arrête si le serveur renvoie toujours la même page", async () => {
    const ids = Array.from({ length: 20 }, (_, index) => `absence-${index}`);
    const fetchMock = vi.fn(async () => pageOf(ids, 40));
    vi.stubGlobal("fetch", fetchMock);

    const items = await getAttendanceItems(client());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(items).toHaveLength(20);
  });
});
