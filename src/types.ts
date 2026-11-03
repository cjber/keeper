export const schemaVersion = 6;

export const categories = [
  "worktree",
  "aur",
  "pacman-cache",
  "orphans",
  "agent",
  "build",
  "transcripts",
  "tmp",
  "package-cache",
  "docker",
  "snapshots",
  "logs",
  "apps",
  "large",
  "downloads",
  "screenshots",
  "duplicates",
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
export type Action =
  | "trash"
  | "paccache"
  | "remove-packages"
  | "uv-prune"
  | "pnpm-prune"
  | "npm-clean"
  | "bun-clean"
  | "docker-image-prune"
  | "docker-builder-prune"
  | "renice"
  | "truncate"
  | "report";

export interface Finding {
  /** Hash of category, target and state, so an id stops matching once the thing it judged changes. */
  id: string;
  category: Category;
  risk: Risk;
  action: Action;
  title: string;
  paths: string[];
  packages: string[];
  /** Uncompressed size. Removing it can free far less on a compressing filesystem such as btrfs. */
  bytes: number;
  reason: string;
  /** Any entry here makes the finding ineligible for a plan. */
  blockers: string[];
  /**
   * Personal files and apps are only planned by explicit id. A bulk `keeper plan` with a risk ceiling never takes
   * them, because a person deciding "medium risk is fine" has not seen which game data or app it would remove.
   */
  explicit?: true;
  /** Git common dir, so purge can prune the worktree's metadata and undo can still restore it first. */
  gitDir?: string;
  /** Branch and commit of a worktree, so purge deletes the local branch only if it has not moved. */
  branch?: string;
  head?: string;
  /** Files and directories the paths hold. On a tmpfs with a quota this, not bytes, is often what runs out. */
  inodes?: number;
  /** Percent of one core the finding's processes used during the sample. Absent for everything that is not `load`. */
  cpu?: number;
  /** Pids the finding judged, so `renice` can target the command without a second scan. */
  pids?: number[];
}

export interface Scan {
  schemaVersion: number;
  scannedAt: string;
  /** When each category's findings were scanned. A cached category is older than scannedAt. */
  categoryScannedAt: Partial<Record<Category, string>>;
  findings: Finding[];
  warnings: string[];
}

export interface Plan {
  schemaVersion: number;
  id: string;
  createdAt: string;
  findingIds: string[];
  /** The categories its findings came from, so apply rescans only those. Older plans lack it and rescan all. */
  categories?: Category[];
  bytes: number;
  /** The window the plan was approved under, so apply judges findings the same way. */
  staleDays: number;
  /** The app window this plan was approved under. Older plans lack it and fall back to the current default. */
  appStaleDays?: number;
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

/** Eligible for a plan with no ids. Personal files and apps are deliberately left out of that sweep. */
export function bulkEligible(finding: Finding): boolean {
  return eligible(finding) && finding.explicit !== true;
}

/** "1 file", "2 files": a count with its noun in the right number. */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

/**
 * Drops findings whose every path sits inside another trashed finding, such as a worktree's own build output when
 * the worktree is chosen too. Moving the parent takes them, so counting both would report the space twice.
 */
export function outermost(findings: readonly Finding[]): Finding[] {
  const roots = findings
    .filter((f) => f.action === "trash")
    .flatMap((f) => f.paths.map((path) => ({ path, id: f.id })));
  const inside = (f: Finding) =>
    f.action === "trash" &&
    f.paths.every((path) => roots.some((root) => root.id !== f.id && path.startsWith(`${root.path}/`)));
  return findings.filter((f) => !inside(f));
}
