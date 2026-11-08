#!/usr/bin/env bun
import { setPriority } from "node:os";
import { runCli } from "./cli";

// Cleanup is never urgent, yet agents run keeper while the machine is already loaded, and each scan starts
// dozens of du and git children that inherit this priority. Running at the lowest CPU and disk priority means
// keeper only takes time the user's apps leave idle.
setPriority(19);
Bun.spawnSync(["ionice", "-c3", "-p", String(process.pid)], { stdout: "ignore", stderr: "ignore" });

const code = await runCli(process.argv.slice(2));
if (code !== undefined) process.exit(code);

const [{ createCliRenderer }, { createRoot }, { liveActions, Wizard }, { loadConfig }, { defaultPaths }] =
  await Promise.all([
    import("@opentui/core"),
    import("@opentui/react"),
    import("./wizard"),
    import("./ops"),
    import("./system"),
  ]);
const { theme } = loadConfig(defaultPaths());
const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<Wizard actions={liveActions} theme={theme} />);
