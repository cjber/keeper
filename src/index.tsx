#!/usr/bin/env bun
import { runCli } from "./cli";

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
