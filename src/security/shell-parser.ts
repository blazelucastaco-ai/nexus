// Shell-command parser — extracts every command head from a shell command
// string, even when commands are chained with `;`, `&&`, `||`, `|`, `|&`, or
// `&`, or nested inside `$(...)` / backtick substitutions.
//
// Used by the argv-blocklist defense in tools/executor.ts. Previously the
// blocklist only checked the first token of the command, so `echo ok; shutdown`
// passed the check (argv[0] = "echo") and then the whole string ran through
// zsh -c, executing the blocklisted command. This parser returns ALL heads so
// the blocklist can be enforced segment-by-segment.
//
// NOT a full shell grammar — it's a security heuristic. It should err on the
// side of extracting MORE heads than the real shell would run; false positives
// in head extraction just mean we check them against the blocklist unnecessarily.

/**
 * Extract every plausible command head from a shell command string.
 * Handles chained commands and command substitutions. Ignores environment
 * variable assignments (`FOO=bar cmd args` → head is `cmd`).
 */
export function extractCommandHeads(command: string): string[] {
  if (!command || typeof command !== 'string') return [];
  const heads: string[] = [];
  const seen = new Set<string>(); // dedupe but preserve insertion order

  const recurse = (s: string) => {
    // Strip $(...) and `...` substitutions, recursing into them so nested
    // commands also get their heads extracted.
    const withoutSubsts = s.replace(
      /\$\(([^()]*)\)|`([^`]*)`/g,
      (_, dollarInner, tickInner) => {
        recurse(dollarInner ?? tickInner ?? '');
        return ' ';
      },
    );

    // Split on shell chain operators. Order matters: longer operators first
    // so `||` doesn't get split as two `|` and `&&` doesn't split as two `&`.
    const segments = withoutSubsts.split(/\|\||&&|;|\|&|\||&/);

    for (const seg of segments) {
      // Skip env-var assignments (FOO=bar cmd): match zero-or-more assignments,
      // then capture the next non-space token.
      const m = seg.trim().match(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(\S+)/);
      if (!m || !m[1]) continue;
      const head = m[1];
      // Strip surrounding quotes (`'cmd'` or `"cmd"`)
      const unquoted = head.replace(/^['"]|['"]$/g, '');
      if (!unquoted) continue;
      if (!seen.has(unquoted)) {
        seen.add(unquoted);
        heads.push(unquoted);
      }
    }
  };

  recurse(command);
  return heads;
}

/**
 * True if any command head in the string matches one in `blocklist`.
 * Convenience wrapper used at the call site.
 */
export function anyHeadBlocked(command: string, blocklist: ReadonlySet<string>): {
  blocked: boolean;
  head?: string;
} {
  for (const head of extractCommandHeads(command)) {
    if (blocklist.has(head)) return { blocked: true, head };
  }
  return { blocked: false };
}
