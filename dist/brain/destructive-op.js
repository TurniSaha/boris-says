/**
 * src/brain/destructive-op.ts — item 7: deterministic detection of a DATA-DESTRUCTIVE op
 * NAMED in a typed prompt (DROP TABLE, DELETE FROM, TRUNCATE, a destructive prod migration).
 *
 * PURE, DETERMINISTIC, TRANSCRIPT-BLIND (mirrors prompt-intent.ts / judge-reflex.ts): a
 * verdict over the prompt text alone — no LLM, no clock, no I/O. Used ONLY to carve a hole in
 * the SUP-3 clean-branch suppression: a clean branch is NOT enough of an "undo" for an
 * irreversible data destruction, so risk_awareness must still fire.
 *
 * PRECISION WALL (must NOT fire on innocent prose):
 *   - "drop me a note", "drop by", "a dropdown menu", "drop shadow" → NOT a data op.
 *   - "delete the comment in the code", "delete this line", "delete the file" → NOT a DB op
 *     (deleting code/files is not the irreversible-persistent-data case SUP-3 guards).
 *   - Only DROP <object>, DELETE FROM, TRUNCATE, or an explicit destructive PROD migration
 *     (drop/delete/truncate + a prod/production data target) trip it.
 */
/**
 * SQL DDL/DML destruction, anchored to the SQL grammar so prose can't trip it:
 *   - DROP <TABLE|DATABASE|SCHEMA|INDEX|COLUMN|VIEW> …  (DROP must be followed by a DB object)
 *   - DELETE FROM …                                     (bare "delete X" is NOT this)
 *   - TRUNCATE [TABLE] …
 * Case-insensitive; the SQL keywords are the signal, not the English verbs.
 */
const SQL_DESTRUCTIVE_RES = [
    /\bdrop\s+(table|database|schema|index|column|view|materialized\s+view)\b/i,
    /\bdelete\s+from\b/i,
    /\btruncate\s+(table\s+)?\w/i,
];
/**
 * A destructive PROD migration phrased in prose: a destroy verb (drop/delete/truncate/wipe/
 * purge/destroy) applied to persistent data ON prod/production. Requires BOTH a destroy verb
 * AND a prod-data target in the SAME prompt so "delete the comment" / "drop me a note" never
 * match. Word-boundary anchored.
 */
const DESTROY_VERB_RE = /\b(drop|delete|truncate|wipe|purge|destroy|nuke)\b/i;
const PROD_DATA_TARGET_RE = /\b(prod|production)\b/i;
const PERSISTENT_DATA_RE = /\b(table|tables|database|databases|\w*_?db|schema|rows?|records?|users?\s+table|migration)\b/i;
/**
 * True iff the prompt NAMES a data-destructive operation (SQL DDL/DML destruction, or a
 * destructive prod-data migration). Deterministic; innocent prose never trips it.
 */
export function namesDestructiveDataOp(prompt) {
    const text = String(prompt);
    if (SQL_DESTRUCTIVE_RES.some((re) => re.test(text)))
        return true;
    // Prose prod-migration case: a destroy verb + prod + a persistent-data noun, all present.
    if (DESTROY_VERB_RE.test(text) && PROD_DATA_TARGET_RE.test(text) && PERSISTENT_DATA_RE.test(text)) {
        return true;
    }
    return false;
}
