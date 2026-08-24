import { execFileSync } from "node:child_process";

/**
 * What a task committed, so a recap says what the work was and not only how much of it there was.
 *
 * A recap that reads `task_771fe0be, 10 call(s), 5 files` names a unit of work without saying
 * what it was for, which is most of the reason an agent still goes back and reads the tree. The
 * missing half is intent, and PatchMesh deliberately does not record it: the prompt text is
 * dropped before the first disk write and only the host's opaque `prompt_id` survives.
 *
 * Two sources of intent were considered and rejected before this one:
 *
 * - **`TodoWrite` content.** An agent's own statement of what it is doing, already flowing
 *   through the hook. Measured on this repository's ledger: **zero** `TodoWrite` calls in 628.
 *   A label source that fires on none of the observed traffic is not a source.
 * - **Parsing `git commit` out of the recorded shell command.** The text is there, but the
 *   journal flattens newlines, so a heredoc subject runs into its body with nothing marking the
 *   boundary. Recovering the subject would mean guessing where it ends, which is the requested-
 *   path inference this project bans elsewhere for the same reason.
 *
 * So the commit is read rather than parsed. `git log` gives the exact subject the developer
 * wrote, with no reconstruction, and the repository is already open. Nothing is recorded: this
 * is derived at read time, so it needs no new event type and the closed event set stays closed.
 *
 * Attribution is by committer time falling inside the task's observed window - the same basis
 * as turn-scoped effects, and it asserts only what was observed: this commit landed while this
 * task was the work in flight. It is not a claim that the task *is* the commit. A task may land
 * none or several, and one commit may carry work from more than one task, so the renderer says
 * "committed" rather than naming the commit as the task's purpose.
 */

/** A commit as the repository records it, not as a shell command spelled it. */
export interface TaskCommit {
  readonly at: string;
  readonly subject: string;
}

/** Unit separator between fields of one log record; a commit subject cannot contain it. */
const FIELD = String.fromCharCode(31);

/**
 * Read commits landed since a cutoff.
 *
 * Fails open to nothing. This is an enrichment on top of an answer that is already correct
 * without it; no git, no repository, or a detached checkout must cost the recap its labels and
 * never the recap itself.
 */
export function readCommitsSince(worktreeRoot: string, since: Date): readonly TaskCommit[] {
  let output: string;
  try {
    output = execFileSync(
      "git",
      ["log", `--since=${since.toISOString()}`, `--format=%cI${FIELD}%s`, "--no-merges"],
      { cwd: worktreeRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return [];
  }

  const commits: TaskCommit[] = [];
  for (const line of output.split("\n")) {
    const separator = line.indexOf(FIELD);
    if (separator === -1) continue;
    const at = line.slice(0, separator);
    const subject = line.slice(separator + 1).trim();
    if (at === "" || subject === "") continue;
    commits.push({ at, subject });
  }
  return commits;
}

/**
 * Which of these commits landed while a task was running.
 *
 * Inclusive at both ends: a commit is frequently the last thing a turn does, landing on the
 * same second the task's final call is recorded, and excluding the boundary would drop exactly
 * the commits most worth showing.
 */
export function commitsWithin(
  commits: readonly TaskCommit[],
  startedAt: string,
  endedAt: string,
): readonly string[] {
  const from = new Date(startedAt).getTime();
  const to = new Date(endedAt).getTime();
  return commits
    .filter((commit) => {
      // `%cI` carries a real UTC offset while task windows are stamped `Z`, so these are
      // compared as instants. String comparison would sort them by the text of the timezone.
      const at = new Date(commit.at).getTime();
      return !Number.isNaN(at) && at >= from && at <= to;
    })
    .map((commit) => commit.subject);
}

/**
 * A window a reader can hold in their head, from the minutes a caller passed.
 *
 * Every read tool takes `withinMinutes` and each defaults to a different number -- recap looks
 * back a day, overlaps and recall four hours. An agent that asks all three about "recently"
 * therefore gets three different recentlies, and nothing in any answer said so. Stating the
 * window is what makes "nothing found" mean something: it is the difference between "quiet"
 * and "you asked about the last four minutes".
 */
export function describeWindow(withinMinutes: number): string {
  if (withinMinutes < 90) return `${Math.round(withinMinutes)}m`;
  const hours = withinMinutes / 60;
  if (hours < 36) return `${Number(hours.toFixed(hours < 10 ? 1 : 0))}h`;
  return `${Number((hours / 24).toFixed(1))}d`;
}
