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

async function open(findings: Finding[]) {
  const applied = mock<Actions["apply"]>(async () => "applied");
  const actions: Actions = {
    load: async () => ({ schemaVersion: 3, scannedAt: "", findings, warnings: [] }),
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

test("lists findings, marks blocked ones and shows the keys", async () => {
  const { captureCharFrame, renderer } = await open([finding("a", "low"), finding("b", "medium", ["in use"])]);
  const frame = captureCharFrame();
  expect(frame).toContain("[ ]");
  expect(frame).toContain(" - ");
  expect(frame).toContain("q quit");
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
