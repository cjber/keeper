import { type Context, worktreeDirs } from "./scanners";
import { expandHome, run } from "./system";
import { count } from "./types";

/** The main checkout of every repo keeper can see, whether listed directly or known through one of its worktrees. */
export async function primaryCheckouts(context: Context): Promise<string[]> {
  const expand = expandHome(context.paths.home);
  const listed = context.config.repoRoots.flatMap((root) => worktreeDirs(expand(root)));
  const owners = await Promise.all(
    context.paths.worktrees.flatMap(worktreeDirs).map(async (path) => {
      const common = await run(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
      return common.stdout.endsWith("/.git") ? [common.stdout.slice(0, -"/.git".length)] : [];
    }),
  );
  return [...new Set([...listed, ...owners.flat()])];
}

/**
 * Returns a checkout to its default branch and fast-forwards it. It never resets, rebases or stashes, and leaves
 * everything alone when tracked files changed or the branch holds commits nothing else has. Returns what it did.
 */
export async function freshen(repo: string): Promise<string | undefined> {
  const git = (...args: string[]) => run(["git", "-C", repo, ...args]);
  const [gitDir, commonDir] = await Promise.all([
    git("rev-parse", "--absolute-git-dir"),
    git("rev-parse", "--path-format=absolute", "--git-common-dir"),
  ]);
  if (gitDir.code !== 0 || gitDir.stdout !== commonDir.stdout) return undefined;
  if ((await git("fetch", "--quiet", "--prune", "origin")).code !== 0) return `${repo}: fetch failed`;
  const remote = (await git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")).stdout;
  if (!remote) return undefined;
  const mainline = remote.replace(/^origin\//, "");
  const current = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout;
  // Untracked files survive a checkout, and git refuses one that would overwrite them.
  if ((await git("status", "--porcelain", "-uno")).stdout) return undefined;
  if (current !== mainline) {
    const upstream = await git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
    const base = upstream.code === 0 ? upstream.stdout : remote;
    if ((await git("rev-list", "--count", `${base}..HEAD`)).stdout !== "0") return undefined;
    if ((await git("checkout", "--quiet", mainline)).code !== 0) return `${repo}: could not return to ${mainline}`;
  }
  const behind = (await git("rev-list", "--count", `HEAD..${remote}`)).stdout;
  if (behind === "0" || !behind) return current === mainline ? undefined : `${repo}: returned to ${mainline}`;
  const merged = await git("merge", "--quiet", "--ff-only", remote);
  return merged.code === 0
    ? `${repo}: fast-forwarded ${count(Number(behind), "commit")}`
    : `${repo}: fast-forward refused`;
}
