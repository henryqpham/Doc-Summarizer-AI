// ─────────────────────────────────────────────────────────────────────────
//  Document text normalization, applied server-side before the text goes
//  into the model prompt. Two jobs, both born from testing real input
//  shapes (22 Jul 2026):
//
//  1. EMBEDDED EMAIL CHAINS. Outlook exports often quote the previous
//     email below a "From:/Sent:/To:/Subject:" header partway through the
//     document. Everything below that header is a PRIOR edition. The
//     model was observed lifting stale dates out of it ("slated for
//     7/25") even when the region carried an explicit "nothing below is
//     current" marker (leaked twice in the 22 Jul order test), so the
//     stale half is now REMOVED entirely, replaced by a one-line note.
//     Prior-week context has a sanctioned channel: the last-week-report
//     attachment.
//
//  2. FLATTENED SUB-BULLETS. Word-to-text extraction collapses "o" sub-
//     bullets and inline RISK:/OPPORTUNITY: tags into run-on lines that
//     carry 8 to 10 facts each. Measured effect: the model captured only
//     1-4 of 16 sentinel facts from such a document while capturing ~90%
//     from cleanly formatted ones. Re-breaking the line into one-fact
//     units closes most of that gap.
//
//  Documents without these shapes pass through byte-identical (verified
//  against four clean fixtures). Deterministic, zero dependencies.
// ─────────────────────────────────────────────────────────────────────────

/** Normalize one document's extracted text. */
export function preprocessDocText(text) {
  const lines = String(text).split(/\r?\n/);

  // Locate an embedded chain header. Flattened exports put From:/Sent:/
  // To:/Subject: on ONE line; unflattened ones spread them over a few.
  let splitIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const onOneLine = /\bFrom:\s*\S.*\bSent:.*\b(To|Subject):/i.test(lines[i]);
    const spread =
      /^\s*From:\s*\S/.test(lines[i]) &&
      /\b(Sent|Subject):/i.test(lines.slice(i + 1, i + 4).join(" "));
    if (onOneLine || spread) {
      splitIdx = i;
      break;
    }
  }

  // A header at the very top is the document's own wrapper (a normal
  // forwarded email), not a quoted chain. Only a header AFTER real
  // content marks a prior edition.
  const firstContent = lines.findIndex((l) => l.trim().length > 0);
  const hasEmbedded = splitIdx > firstContent && splitIdx > 0;

  if (!hasEmbedded) return rebreak(lines.join("\n"));

  const current = lines.slice(0, splitIdx).join("\n");
  return (
    rebreak(current).trimEnd() +
    "\n\n[An older email quoted below this point, a prior edition of this" +
    " report, was removed before summarization. It contained no current" +
    " information.]"
  );
}

/**
 * Order documents so the densest (fewest, longest lines: the run-on
 * schedule-report shape) come FIRST. Measured 22 Jul: the same dense
 * document scored 1/16 sentinel facts when last and 15/16 when first,
 * while cleanly formatted documents held ~90% from any position. Sort is
 * stable, so equally dense documents keep their upload order.
 */
export function orderDocumentsDense(documents) {
  const density = (t) => {
    const ls = String(t).split(/\r?\n/).filter((l) => l.trim().length > 0);
    return ls.length ? String(t).length / ls.length : 0;
  };
  return documents
    .map((d, i) => ({ d, i, dens: density(d.text) }))
    .sort((a, b) => b.dens - a.dens || a.i - b.i)
    .map((x) => x.d);
}

// Re-break flattened bullet markers and inline tags into one-fact lines.
// Conservative on purpose: only " o " / " • " before a capital or digit
// (the flattened-bullet signature) and RISK:/OPPORTUNITY: after a sentence
// end. Ordinary prose never matches.
function rebreak(s) {
  return s
    .replace(/\s+[o•]\s+(?=[A-Z(0-9"'])/g, "\n- ")
    .replace(/([.;)\]])\s+(RISK|OPPORTUNITY)\s*:/g, "$1\n$2:");
}

/** Convenience: normalize a {filename, text} document array. */
export function preprocessDocuments(documents) {
  return documents.map((d) => ({ ...d, text: preprocessDocText(d.text) }));
}
