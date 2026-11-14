import { GetAttendanceItems } from "skolengojs";
import { afterEach, describe, expect, it, vi } from "vitest";

const emptyResponse = () =>
  new Response(JSON.stringify({ data: [], included: [] }), {
    status: 200,
    headers: { "Content-Type": "application/vnd.api+json" },
  });

describe("GetAttendanceItems", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("demande les absences et retards sans filtre invalide", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => emptyResponse()
    );
    vi.stubGlobal("fetch", fetchMock);

    await GetAttendanceItems("student-id", "school-id", "ems-code", "token");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const input = fetchMock.mock.calls[0]?.[0];
    const url = decodeURIComponent(
      input instanceof Request ? input.url : String(input)
    );
    expect(url).toContain("filter[student.id]=student-id");
    expect(url).toContain("include=currentState");
    expect(url).not.toContain("filter[currentState.absenceType]");
    expect(url).not.toContain("filter[absenceFile]");
    expect(url).not.toContain("CLATENESS");
  });
});
