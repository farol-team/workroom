// The journal mirror: the room's record rendered as files (#220).

/// One row of the room's journal, as the listing serves it (#220).
export interface JournalRow {
  seq: number; kind: string; prev_hash: string; entry_hash: string;
  created_at: string; payload: unknown;
}

/// The sentence spike #45 requires, word for word — the mirror's README.
export const MIRROR_README =
  "This is a snapshot of the room; edits here do not survive — write to the channel instead.\n";

/// One journal row as a file in the mirror (#220): front matter carrying the
/// chain facts, then the payload — a title-and-detail entry as markdown, and
/// anything else as itself. The name sorts the way the room happened.
export function mirrorEntryOf(row: JournalRow): { path: string; body: string; base64?: boolean } {
  const front = [
    "---",
    `seq: ${row.seq}`,
    `kind: ${row.kind}`,
    `at: ${row.created_at}`,
    `entry_hash: ${row.entry_hash}`,
    `prev_hash: ${row.prev_hash}`,
    "---",
  ].join("\n");
  const p = row.payload as Record<string, unknown> | null;
  const title = typeof p?.title === "string" ? p.title : null;
  const detail = typeof p?.detail === "string" ? p.detail : null;
  const rendered = title
    ? `# ${title}${detail ? `\n\n${detail}` : ""}`
    : "```json\n" + JSON.stringify(row.payload ?? null, null, 2) + "\n```";
  return {
    path: `journal/${String(row.seq).padStart(5, "0")}-${row.kind}.md`,
    body: `${front}\n\n${rendered}\n`,
  };
}
