export const schemaVersion = 1;

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
] as const;
export type Category = (typeof categories)[number];

export const risks = ["low", "medium", "high"] as const;
export type Risk = (typeof risks)[number];

/** `report` findings carry evidence for a person and can never be planned. */
export type Action = "trash" | "paccache" | "remove-packages" | "uv-prune" | "report";

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
}

export interface Transaction {
  schemaVersion: number;
  id: string;
  appliedAt: string;
  entries: TrashEntry[];
  removedPackages: string[];
}

export function eligible(finding: Finding): boolean {
  return finding.action !== "report" && finding.blockers.length === 0;
}
