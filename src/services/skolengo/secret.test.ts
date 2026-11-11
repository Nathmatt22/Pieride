import { describe, expect, it } from "vitest";

import { parseSecret, type SkolengoSecret } from "./secret";

const SECRET: SkolengoSecret = {
  userId: "ESKO-P-1",
  refreshToken: "refresh",
  tokenEndpoint: "https://auth.exemple.fr/token",
  wellKnown: "https://auth.exemple.fr/.well-known/openid-configuration",
  emsCode: "gdest",
};

describe("parseSecret", () => {
  it("relit un secret complet", () => {
    expect(parseSecret(JSON.stringify(SECRET))).toEqual(SECRET);
  });

  it("refuse un secret illisible ou incomplet", () => {
    expect(parseSecret("pas du JSON")).toBeNull();
    expect(parseSecret("{}")).toBeNull();
    expect(
      parseSecret(JSON.stringify({ ...SECRET, refreshToken: "" }))
    ).toBeNull();
    expect(parseSecret(JSON.stringify({ ...SECRET, emsCode: 42 }))).toBeNull();
  });
});
