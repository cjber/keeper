export const schemaVersion = 3;

export const categories = [
  "worktree",
  "aur",
  "pacman-cache",
  "orphans",
  "agent",
  "build",
  "transcripts",
  "uv-cache",
  "snapshots",
  "logs",
  "load",
  "memory",
] as const;
export type Category = (typeof categories)[number];

export const risks = ["low", "medium", "high"] as const;
export type Risk = (typeof risks)[number];

/**
 * `report` findings carry evidence for a person and can never be planned.
 * `renice` is the only action that changes no data, which is why it is medium risk rather than low: `auto` runs it never.
 */
export type Action = "trash" | "paccache" | "remove-packages" | "uv-prune" | "renice" | "truncate" | "report";

export interface Finding {
  /** Hash of category, target and state, so an id stops matching once the thing it judged changes. */
  id: string;
  category: Category;
  risk: Risk;
  action: Action;
  title: string;
  paths: string[];
  packages: string[];
  bytes: number;
  reason: string;
  /** Any entry here makes the finding ineligible for a plan. */
  blockers: string[];
  /** Git common dir, so purge can prune the worktree's metadata and undo can still restore it first. */
  gitDir?: string;
  /** Branch and commit of a worktree, so purge deletes the local branch only if it has not moved. */
  branch?: string;
  head?: string;
  /** Percent of one core the finding's processes used during the sample. Absent for everything that is not `load`. */
  cpu?: number;
  /** Pids the finding judged, so `renice` can target the command without a second scan. */
  pids?: number[];
}

export interface Scan {
  schemaVersion: number;
  scannedAt: string;
  findings: Finding[];
  warnings: string[];
}

export interface Plan {
  schemaVersion: number;
  id: string;
  createdAt: string;
  findingIds: string[];
  bytes: number;
  /** The window the plan was approved under, so apply judges findings the same way. */
  staleDays: number;
}

export interface TrashEntry {
  original: string;
  trashed: string;
  bytes: number;
  gitDir?: string;
  branch?: string;
  head?: string;
}

export interface Transaction {
  schemaVersion: number;
  id: string;
  appliedAt: string;
  entries: TrashEntry[];
  removedPackages: string[];
  /** Priority changes are the only mutation undo can reverse in place, so the old value is kept. */
  reniced: Reniced[];
}

export interface Reniced {
  pid: number;
  nice: number;
}

export function eligible(finding: Finding): boolean {
  return finding.action !== "report" && finding.blockers.length === 0;
}
