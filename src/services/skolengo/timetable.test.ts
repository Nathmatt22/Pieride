import { getTimetableForPeriods } from "skolengojs";
import { afterEach, describe, expect, it, vi } from "vitest";

const emptyResponse = () =>
  new Response(JSON.stringify({ data: [], included: [] }), {
    status: 200,
    headers: { "Content-Type": "application/vnd.api+json" },
  });

describe("getTimetableForPeriods", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("envoie les dates locales de la semaine, sans décalage UTC", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => emptyResponse()
    );
    vi.stubGlobal("fetch", fetchMock);

    await getTimetableForPeriods(
      "student-id",
      "school-id",
      "ems-code",
      "token",
      new Date(2026, 10, 16),
      new Date(2026, 10, 22)
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const input = fetchMock.mock.calls[0]?.[0];
    const url = decodeURIComponent(
      input instanceof Request ? input.url : String(input)
    );
    expect(url).toContain("filter[date][GE]=2026-11-16");
    expect(url).toContain("filter[date][LE]=2026-11-22");
    expect(url).not.toContain("2026-11-15");
  });
});
