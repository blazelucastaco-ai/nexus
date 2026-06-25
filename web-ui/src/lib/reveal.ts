// Word-locked reveal math for the Stage — pure + unit-tested (see tests/stage-reveal).
//
// The diagram should draw itself AS NEXUS speaks: each node lands exactly on the word
// that names it. We get there from two inputs — the visual's ordered piece labels and
// ElevenLabs' per-character audio alignment — by finding, for each piece, the audio
// time its label is first spoken. The Stage then reveals piece i once playback passes
// that time. No timer, no drift: it follows the actual audio.

export type Align = { text: string; times: number[] };

/** The visual's ordered piece labels. Mirrors the widgets' own ordering (sort by
 *  `order`, fallback to index) so piece i here is the same piece i the widget reveals. */
export function pieceLabels(spec: Record<string, unknown>): string[] {
  for (const k of ['nodes', 'steps', 'items', 'events', 'stats', 'rows', 'data']) {
    const arr = spec[k];
    if (Array.isArray(arr)) {
      return arr
        .map((it, i) => {
          const o = (it ?? {}) as Record<string, unknown>;
          const order = Number.isFinite(Number(o.order)) ? Number(o.order) : i;
          const label = String(o.label ?? o.title ?? o.name ?? o.id ?? o.text ?? '');
          return { label, order, i };
        })
        .sort((a, b) => a.order - b.order || a.i - b.i)
        .map((x) => x.label);
    }
  }
  return [];
}

/** For each piece, the audio time (s) its label is first spoken — so each node lands
 *  exactly on its word. Labels are searched in order (they're narrated in order); a
 *  label not spoken verbatim falls back to its proportional slot in the clip. */
export function computeRevealTimes(labels: string[], align: Align): number[] {
  const lower = align.text.toLowerCase();
  const lastT = align.times.length ? (align.times[align.times.length - 1] ?? 0) : 0;
  const total = Math.max(1, labels.length);
  let from = 0;
  return labels.map((label, i) => {
    const key = label.trim().toLowerCase();
    if (key) {
      let idx = lower.indexOf(key, from);
      if (idx < 0) idx = lower.indexOf(key);
      if (idx >= 0 && idx < align.times.length) {
        from = idx + key.length;
        return align.times[idx] ?? 0;
      }
    }
    return (i / total) * lastT; // not spoken verbatim → approximate by position
  });
}

/** How many pieces have been reached by playback time `ct` (seconds). The Stage
 *  reveals `count - 1` (and keeps the first piece pinned as the anchor). */
export function revealedCount(revealTimes: number[], ct: number): number {
  let count = 0;
  for (let i = 0; i < revealTimes.length; i++) {
    if ((revealTimes[i] ?? Number.POSITIVE_INFINITY) <= ct) count++;
  }
  return count;
}
