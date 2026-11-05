// React only recognises act() when this is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { Event, Sample } from "./history";
import type { Finding } from "./types";
import { type Actions, Wizard } from "./wizard";

const finding = (id: string, risk: Finding["risk"], blockers: string[] = []): Finding => ({
  id,
  state: id,
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

const section = (id: string, category: Finding["category"], bytes = 1024 ** 3): Finding => ({
  ...finding(id, "low"),
  category,
  bytes,
});

async function open(
  findings: Finding[],
  cached?: Finding[],
  load: Promise<void> = Promise.resolve(),
  history: { samples: Sample[]; events: Event[] } = { samples: [], events: [] },
) {
  const applied = mock<Actions["apply"]>(async () => "applied");
  const report = (items: Finding[]) => ({
    schemaVersion: 3,
    scannedAt: new Date(0).toISOString(),
    categoryScannedAt: {},
    findings: items,
    warnings: [],
    cached: [],
    live: [],
  });
  const loads = mock((reuse: boolean) => reuse);
  const actions: Actions = {
    cached: () => (cached ? report(cached) : undefined),
    load: async (reuse, done) => {
      loads(reuse);
      done?.("aur", findings.length, false);
      await load;
      return report(findings);
    },
    history: () => history,
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
  return { ...setup, applied, loads, settle };
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
  expect(captureCharFrame()).toContain("· showing ");
  expect(captureCharFrame()).toMatch(/Scanning \d+\/\d+/);
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
  expect(captureCharFrame()).not.toContain("Scanning");
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

test("opening reuses recent categories, and r rescans everything", async () => {
  const { mockInput, loads, settle, renderer } = await open([finding("a", "low")]);
  expect(loads.mock.calls).toEqual([[true]]);
  await act(async () => {
    await mockInput.pressKey("r");
  });
  await settle();
  expect(loads.mock.calls).toEqual([[true], [false]]);
  renderer.destroy();
});

test("g cycles to space, then free space over time, keeping the key line in place", async () => {
  const hour = 3_600_000;
  const now = Date.now();
  const samples = [3, 2, 1].map((back, index) => ({
    at: new Date(now - back * hour).toISOString(),
    free: (100 + index * 5) * 1024 ** 3,
    size: 500 * 1024 ** 3,
  }));
  const events: Event[] = [{ at: new Date(now - 1.5 * hour).toISOString(), event: "apply", bytes: 5 * 1024 ** 3 }];
  const { captureCharFrame, mockInput, settle, renderer } = await open(
    [finding("a", "low"), finding("b", "low", ["in use"])],
    undefined,
    Promise.resolve(),
    { samples, events },
  );
  // The first key line: the list's starts with moving, each graph's with g.
  const keyRow = (frame: string) => frame.split("\n").findIndex((line) => /^\s*(j\/k move|g )/.test(line));
  const listKeys = keyRow(captureCharFrame());
  await act(async () => {
    await mockInput.pressKey("g");
  });
  await settle();
  let frame = captureCharFrame();
  expect(frame).toContain("keeper · space · 1.0G ready now, 1.0G waiting");
  expect(frame).toMatch(/aur +1\.0G +1\.0G +█+░+/);
  expect(frame).toMatch(/in use, offered once it stops +1 +1\.0G/);
  expect(keyRow(frame)).toBe(listKeys);
  // Each view offers only the keys that work in it.
  expect(frame).toContain("g free space history · r rescan · q/esc quit");
  expect(frame).not.toContain("space select");
  await act(async () => {
    await mockInput.pressKey("g");
  });
  await settle();
  frame = captureCharFrame();
  expect(frame).toContain("keeper · free space · 110.0G of 500.0G, up 10.0G in 3 hours");
  expect(frame).toContain("▲");
  expect(frame).toContain("moved 5.0G to trash");
  expect(frame).toContain("g back to the list");
  expect(keyRow(frame)).toBe(listKeys);
  renderer.destroy();
});

test("the history view explains itself before there are two readings", async () => {
  const { captureCharFrame, mockInput, settle, renderer } = await open([finding("a", "low")]);
  await act(async () => {
    await mockInput.pressKey("g");
    await mockInput.pressKey("g");
  });
  await settle();
  expect(captureCharFrame()).toContain("No readings yet.");
  renderer.destroy();
});

test("groups findings by category and folds a long section", async () => {
  const downloads = Array.from({ length: 25 }, (_, index) => section(`dl${index}`, "downloads"));
  const { captureCharFrame, renderer } = await open([...downloads, section("keep", "aur")]);
  const frame = captureCharFrame();
  expect(frame).toContain("downloads");
  expect(frame).toContain("▸");
  expect(frame).toContain("aur");
  expect(frame).toContain("▾");
  // The short section shows its row, while the long one starts folded.
  expect(frame).toContain("item keep");
  expect(frame).not.toContain("item dl0");
  renderer.destroy();
});

test("right expands a folded section and left folds it again", async () => {
  const downloads = Array.from({ length: 25 }, (_, index) => section(`dl${index}`, "downloads"));
  const { captureCharFrame, mockInput, settle, renderer } = await open(downloads);
  expect(captureCharFrame()).not.toContain("item dl0");
  await act(async () => {
    await mockInput.pressKey("l");
  });
  await settle();
  expect(captureCharFrame()).toContain("item dl0");
  await act(async () => {
    await mockInput.pressKey("h");
  });
  await settle();
  expect(captureCharFrame()).not.toContain("item dl0");
  renderer.destroy();
});

test("space on a section header selects the whole section", async () => {
  const { captureCharFrame, mockInput, applied, settle, renderer } = await open([
    section("one", "aur"),
    section("two", "aur"),
  ]);
  // The cursor starts on the section header.
  await act(async () => {
    await mockInput.pressKey(" ");
  });
  await settle();
  expect(captureCharFrame()).toContain("[x]");
  await act(async () => {
    await mockInput.pressEnter();
  });
  await settle();
  expect(applied.mock.calls[0]?.[0].map((item) => item.id).sort()).toEqual(["one", "two"]);
  renderer.destroy();
});

test("a long list shows its position and pagedown moves a page", async () => {
  const many = [
    ...Array.from({ length: 15 }, (_, index) => section(`a${index}`, "aur")),
    ...Array.from({ length: 15 }, (_, index) => section(`d${index}`, "downloads")),
  ];
  const { captureCharFrame, mockInput, settle, renderer } = await open(many);
  expect(captureCharFrame()).toMatch(/1-\d+\/\d+/);
  await act(async () => {
    await mockInput.pressKey("\x1b[6~");
  });
  await settle();
  expect(captureCharFrame()).toMatch(/2-\d+\/\d+/);
  renderer.destroy();
});
