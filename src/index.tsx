#!/usr/bin/env bun
import { runCli } from "./cli";

const code = await runCli(process.argv.slice(2));
if (code !== undefined) process.exit(code);

const [{ createCliRenderer }, { createRoot }, { liveActions, Wizard }] = await Promise.all([
  import("@opentui/core"),
  import("@opentui/react"),
  import("./wizard"),
]);
const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<Wizard actions={liveActions} />);
