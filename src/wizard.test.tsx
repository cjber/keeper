// React only recognises act() when this is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { Finding } from "./types";
import { type Actions, Wizard } from "./wizard";

const finding = (id: string, risk: Finding["risk"], blockers: string[] = []): Finding => ({
  id,
  category: "aur",
  risk,
  action: "trash",
  title: `item ${id}`,
  paths: [`/tmp/${id}`],
  packages: [],
  bytes: 1024 ** 3,
  reason: `reason ${id}`,
  blockers,
});

async function open(findings: Finding[], cached?: Finding[], load: Promise<void> = Promise.resolve()) {
  const applied = mock<Actions["apply"]>(async () => "applied");
  const report = (items: Finding[]) => ({
    schemaVersion: 3,
    scannedAt: new Date(0).toISOString(),
    findings: items,
    warnings: [],
  });
  const actions: Actions = {
    cached: () => (cached ? report(cached) : undefined),
    load: async (done) => {
      done?.("aur", findings.length);
      await load;
      return report(findings);
    },
    apply: applied,
    schedule: async () => "scheduled",
  };
  let setup!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    setup = await testRender(<Wizard actions={actions} />, { width: 90, height: 28 });
  });
  const settle = async () => {
    await act(async () => {
      await Bun.sleep(10);
    });
    await setup.flush();
  };
  await settle();
  return { ...setup, applied, settle };
}

test("lists eligible findings first and shows blocked ones on b", async () => {
  const { captureCharFrame, mockInput, settle, renderer } = await open([
    finding("b", "medium", ["in use"]),
    finding("a", "low"),
  ]);
  expect(captureCharFrame()).toContain("1 eligible, 1 blocked");
  expect(captureCharFrame()).not.toContain("item b");
  await act(async () => {
    await mockInput.pressKey("b");
  });
  await settle();
  const frame = captureCharFrame();
  expect(frame.indexOf("item a")).toBeLessThan(frame.indexOf("item b"));
  expect(frame).toContain(" - ");
  renderer.destroy();
});

test("says why nothing is selectable instead of ignoring the key", async () => {
  const { captureCharFrame, mockInput, settle, renderer } = await open([finding("b", "low", ["in use"])]);
  expect(captureCharFrame()).toContain("Press b to see 1 blocked finding.");
  await act(async () => {
    await mockInput.pressKey("a");
  });
  await settle();
  expect(captureCharFrame()).toContain("No low-risk finding is eligible");
  await act(async () => {
    await mockInput.pressKey("b");
  });
  await settle();
  await act(async () => {
    await mockInput.pressKey(" ");
  });
  await settle();
  expect(captureCharFrame()).toContain("Blocked: in use");
  renderer.destroy();
});

test("shows the cached scan while rescanning but acts only on the fresh one", async () => {
  let finish!: () => void;
  const scanning = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const { captureCharFrame, mockInput, applied, settle, renderer } = await open(
    [finding("fresh", "low")],
    [finding("old", "low")],
    scanning,
  );
  expect(captureCharFrame()).toContain("item old");
  expect(captureCharFrame()).toContain("until the new one finishes");
  expect(captureCharFrame()).toContain("✓ aur 1");
  await act(async () => {
    await mockInput.pressKey("a");
    await mockInput.pressEnter();
  });
  await settle();
  expect(applied).not.toHaveBeenCalled();
  finish();
  await settle();
  expect(captureCharFrame()).toContain("item fresh");
  expect(captureCharFrame()).not.toContain("item old");
  expect(captureCharFrame()).not.toContain("✓ aur");
  renderer.destroy();
});

test("a all low risk then enter applies only what is eligible and low risk", async () => {
  const { mockInput, applied, settle, renderer } = await open([
    finding("low", "low"),
    finding("medium", "medium"),
    finding("blocked", "low", ["in use"]),
  ]);
  await act(async () => {
    await mockInput.pressKey("a");
  });
  await settle();
  await act(async () => {
    await mockInput.pressEnter();
  });
  await settle();
  expect(applied.mock.calls[0]?.[0].map((item) => item.id)).toEqual(["low"]);
  renderer.destroy();
});

test("a blocked finding cannot be selected", async () => {
  const { mockInput, applied, settle, renderer } = await open([finding("blocked", "low", ["in use"])]);
  await act(async () => {
    await mockInput.pressKey(" ");
    await mockInput.pressEnter();
  });
  await settle();
  expect(applied).not.toHaveBeenCalled();
  renderer.destroy();
});
