import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeClaudeApiUsage } from "../../src/providers/claude.js";

const fixtureDir = join(import.meta.dirname, "..", "fixtures", "claude");

describe("Claude quota parsing", () => {
  it("normalizes OAuth usage windows and extra usage", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtureDir, "oauth.json"), "utf8"),
    ) as unknown;
    const result = normalizeClaudeApiUsage(raw, "Pro");

    expect(result?.plan).toBe("Pro");
    expect(result?.windows).toMatchObject([
      {
        id: "five_hour",
        kind: "session",
        percentUsed: 18,
        percentRemaining: 82,
        resetsAt: "2026-07-06T22:15:00Z",
      },
      {
        id: "seven_day",
        kind: "weekly",
        percentUsed: 36,
        percentRemaining: 64,
        resetsAt: "2026-07-10T16:00:00Z",
      },
      {
        id: "seven_day_opus",
        kind: "model",
        percentUsed: 7,
        percentRemaining: 93,
      },
      {
        id: "extra_usage",
        kind: "credits",
        percentUsed: 25,
        percentRemaining: 75,
        spentUsd: 5,
        limitUsd: 20,
      },
    ]);
  });

  it("prefers the scoped `limits` array and surfaces model-scoped windows like Fable", () => {
    const raw = JSON.parse(
      readFileSync(join(fixtureDir, "oauth-scoped-limits.json"), "utf8"),
    ) as unknown;
    const result = normalizeClaudeApiUsage(raw, "Max");

    expect(result?.plan).toBe("Max");
    expect(result?.windows).toMatchObject([
      {
        id: "five_hour",
        kind: "session",
        percentUsed: 22,
        percentRemaining: 78,
        resetsAt: "2026-07-06T22:15:00.317709+00:00",
      },
      {
        id: "seven_day",
        kind: "weekly",
        percentUsed: 41,
        percentRemaining: 59,
        resetsAt: "2026-07-10T16:00:00.317732+00:00",
      },
      {
        id: "model:fable",
        label: "Fable week",
        kind: "model",
        percentUsed: 63,
        percentRemaining: 37,
        resetsAt: "2026-07-11T09:30:00.318030+00:00",
      },
      {
        id: "extra_usage",
        kind: "credits",
        percentUsed: 25,
        percentRemaining: 75,
        spentUsd: 5,
        limitUsd: 20,
      },
    ]);
  });
});
