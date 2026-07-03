/**
 * src/jsonl/corpus-reader.ts — the cross-session mining corpus (SPEC §7.1).
 *
 * Globs ALL `<projectsDir>/<project>/*.jsonl` session files and returns the typed
 * prompts across every session, each tagged with its `sessionId` (the filename
 * basename minus `.jsonl`), its `project` dir name, and `ts`. This is the input to
 * the cross-session habit miner (pillar 3) — habits are person-level and global to
 * the one user (decision #6), so we mine the WHOLE local corpus.
 *
 * Defaults to `~/.claude/projects` but `projectsDir` is overridable for tests.
 *
 * BOUNDED (SPEC §7.1 step 4): a real machine has 400+ session files; reading all of
 * them into memory would not scale. We cap the number of files read to `maxFiles`,
 * choosing the MOST-RECENT files (by mtime) so a huge corpus does not blow memory.
 * Unreadable files are skipped, never fatal — and a missing projects dir yields [].
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseTypedPromptLine } from './line-parser.js';
/** SPEC §7.1 — bound the corpus so a huge history does not blow memory. */
export const DEFAULT_MAX_FILES = 200;
/** Default corpus root on a real machine. */
export function defaultProjectsDir() {
    return join(homedir(), '.claude', 'projects');
}
/**
 * Read typed prompts across the whole local corpus, bounded and watermark-filtered.
 * Never throws; unreadable files and a missing projects dir are skipped.
 */
export function readCorpusTypedPrompts(options = {}) {
    const projectsDir = options.projectsDir ?? defaultProjectsDir();
    const sinceWatermark = options.sinceWatermark ?? 0;
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const files = collectSessionFiles(projectsDir);
    if (files.length === 0)
        return [];
    // Most-recent files win when bounding (SPEC §7.1).
    const bounded = files.length > maxFiles
        ? [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxFiles)
        : files;
    const prompts = [];
    for (const file of bounded) {
        let raw;
        try {
            raw = readFileSync(file.path, 'utf8');
        }
        catch {
            continue; // skip unreadable file
        }
        if (raw.length === 0)
            continue;
        for (const line of raw.split('\n')) {
            if (line.length === 0)
                continue;
            const event = parseTypedPromptLine(line);
            if (event === null)
                continue;
            const ts = event.ts ?? 0;
            if (ts <= sinceWatermark && sinceWatermark > 0)
                continue;
            prompts.push({
                text: event.text,
                sessionId: file.sessionId,
                project: file.project,
                ts,
            });
        }
    }
    return prompts;
}
/** List every `<projectsDir>/<project>/*.jsonl` file. Never throws. */
function collectSessionFiles(projectsDir) {
    let projectEntries;
    try {
        projectEntries = readdirSync(projectsDir);
    }
    catch {
        return [];
    }
    const out = [];
    for (const project of projectEntries) {
        const projectPath = join(projectsDir, project);
        let entries;
        try {
            const st = statSync(projectPath);
            if (!st.isDirectory())
                continue;
            entries = readdirSync(projectPath);
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.endsWith('.jsonl'))
                continue;
            const path = join(projectPath, entry);
            let mtimeMs = 0;
            try {
                mtimeMs = statSync(path).mtimeMs;
            }
            catch {
                continue; // skip files we can't stat
            }
            out.push({
                path,
                project,
                sessionId: basename(entry, '.jsonl'),
                mtimeMs,
            });
        }
    }
    return out;
}
