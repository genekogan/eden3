import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OperatorRequestGate } from "../app/operator/operator-request-gate";

const clientSource = readFileSync(
  fileURLToPath(new URL("../app/operator/operator-client.tsx", import.meta.url)),
  "utf8",
);

function hasOperatorRequestGate(source: string): boolean {
  return (
    source.includes("const request = requestGate.current.begin(days);") &&
    source.match(/requestGate\.current\.isCurrent\(request\)/g)?.length === 2 &&
    source.includes("requestGate.current.retire();")
  );
}

describe("OperatorRequestGate", () => {
  it("admits only the newest request when different usage windows overlap", () => {
    const gate = new OperatorRequestGate();
    const sevenDays = gate.begin(7);
    const ninetyDays = gate.begin(90);

    expect(gate.isCurrent(ninetyDays)).toBe(true);
    expect(gate.isCurrent(sevenDays)).toBe(false);
  });

  it("rejects an older same-window refresh and every request after retirement", () => {
    const gate = new OperatorRequestGate();
    const first = gate.begin(30);
    const refresh = gate.begin(30);

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(refresh)).toBe(true);

    gate.retire();
    expect(gate.isCurrent(refresh)).toBe(false);
  });

  it("guards both success and failure publication paths in the cockpit", () => {
    expect(hasOperatorRequestGate(clientSource)).toBe(true);
    for (const mutation of [
      "const request = requestGate.current.begin(days);",
      "requestGate.current.isCurrent(request)",
      "requestGate.current.retire();",
    ]) {
      expect(hasOperatorRequestGate(clientSource.replace(mutation, ""))).toBe(false);
    }
  });
});
