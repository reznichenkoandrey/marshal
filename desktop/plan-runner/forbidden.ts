// What a plan step may never ask for (#278): the runner does not push, pull,
// merge, rebase, deploy, release or delete. The same detector decides which
// questions only the owner may answer.

const L = "\\p{L}\\p{N}_";
// \b is ASCII-only and misses Cyrillic, so word edges are \p{L} lookarounds.
const word = (body: string): RegExp => new RegExp(`(?<![${L}])(?:${body})(?![${L}])`, "iu");

const FORBIDDEN: readonly { label: string; pattern: RegExp }[] = [
  { label: "push", pattern: word("push(?:e[sd]|ing)?|(?:за|від|ви)?пуш\\p{L}*") },
  { label: "pull", pattern: word("pull(?:s|ed|ing)?|(?:с|за)?пул(?:и|ити|ь|імо|іть|ить|ю)?") },
  { label: "merge", pattern: word("merg(?:e[sd]?|ing)|(?:з|за|в)?мердж\\p{L}*|(?:з|за|в)?мерж\\p{L}*") },
  { label: "rebase", pattern: word("rebas(?:e[sd]?|ing)|ребейз\\p{L}*") },
  { label: "deploy", pattern: word("deploy(?:s|ed|ing|ment)?|(?:за|ви)?депло\\p{L}*") },
  { label: "release", pattern: word("releas(?:e[sd]?|ing)|publish(?:e[sd]|ing)?|(?:за)?реліз\\p{L}*") },
  { label: "reset --hard", pattern: /reset\s+--hard/iu },
  { label: "git clean", pattern: /git\s+clean/iu },
  { label: "rm -r", pattern: /(?<![\p{L}\p{N}_])rm\s+-[a-z]*r/iu },
  { label: "force", pattern: /--force|(?<![\p{L}\p{N}_-])-f(?![\p{L}\p{N}_])/iu },
  {
    label: "delete branch",
    pattern: new RegExp(
      `branch\\s+-d(?![${L}])|(?:delet|remov)(?:e[sd]?|ing)\\s+(?:the\\s+|a\\s+)?(?:branch|worktree)|` +
        `(?<![${L}])(?:ви|по)дал\\p{L}*\\s+(?:гілк|бранч|worktree)\\p{L}*|(?<![${L}])(?:ви|з)нес\\p{L}*\\s+(?:гілк|бранч)\\p{L}*`,
      "iu"
    )
  }
];

/** The first forbidden operation the text asks for, or null. */
export function findForbidden(text: string): string | null {
  for (const { label, pattern } of FORBIDDEN) if (pattern.test(text)) return label;
  return null;
}
