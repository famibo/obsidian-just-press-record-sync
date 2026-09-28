import { App, TFile, moment } from "obsidian";
import {
	appHasDailyNotesPluginLoaded,
	createDailyNote,
	getAllDailyNotes,
	getDailyNote,
} from "obsidian-daily-notes-interface";
import { escapeAttr, parseRecBlocks, unescapeAttr } from "./recBlocks";

const MERGED_RE = /<!-- jpr:merged file="([^"]*)" -->/g;
const SOURCE_RE = /<!-- jpr:source file="([^"]*)" -->/;

// Matches the trailing audio-link paragraph this plugin appends to a
// transcription (file-url or embed-copy mode). Daily notes get text only.
const AUDIO_LINK_RE = /^(?:\[🎙 .*\]\(.*\)|!\[\[.*\]\])$/;

function mergedFiles(content: string): Set<string> {
	const set = new Set<string>();
	for (const m of content.matchAll(MERGED_RE)) set.add(unescapeAttr(m[1]!));
	return set;
}

function hasSourceLink(content: string, jprPath: string): boolean {
	const m = SOURCE_RE.exec(content);
	return m !== null && unescapeAttr(m[1]!) === jprPath;
}

function textOnly(body: string): string {
	const idx = body.lastIndexOf("\n\n");
	if (idx === -1) return body;
	return AUDIO_LINK_RE.test(body.slice(idx + 2).trim()) ? body.slice(0, idx) : body;
}

/**
 * Rewrites the body of a top-level heading section via `update`, creating the
 * heading (and section) if it doesn't exist yet.
 */
function updateHeadingSection(content: string, heading: string, update: (sectionBody: string) => string): string {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const headingRe = new RegExp(`^(#{1,6})[ \\t]+${escaped}[ \\t]*$`, "m");
	const match = headingRe.exec(content);

	if (!match) {
		const base = content.trimEnd();
		const sep = base === "" ? "" : "\n\n";
		const newBody = update("").trim();
		return newBody ? `${base}${sep}## ${heading}\n\n${newBody}\n` : `${base}${sep}## ${heading}\n`;
	}

	const level = match[1]!.length;
	const sectionStart = match.index + match[0].length;
	const rest = content.slice(sectionStart);
	// End of section = next heading of the same or a shallower level, or EOF.
	const nextHeadingRe = new RegExp(`^#{1,${level}}[ \\t]+\\S`, "m");
	const nextMatch = nextHeadingRe.exec(rest);
	const sectionEnd = nextMatch ? sectionStart + nextMatch.index : content.length;

	const sectionBody = content.slice(sectionStart, sectionEnd).trim();
	const newBody = update(sectionBody).trim();
	const before = content.slice(0, sectionStart).trimEnd();
	const after = content.slice(sectionEnd).trimStart();

	const middle = newBody ? `\n\n${newBody}\n` : "\n";
	return after ? `${before}${middle}\n${after}` : `${before}${middle}`;
}

/**
 * Merges every transcription from a Just Press Record day note into the
 * matching Obsidian daily note, under the given heading, as plain text (no
 * audio links). A link back to the source JPR note is placed right after the
 * heading. Both the link and already-merged transcriptions (tracked via a
 * per-entry marker) are only ever added once, so this is safe to run again
 * later as new recordings are added during the day.
 */
export async function mergeJprNoteIntoDailyNote(
	app: App,
	jprNote: TFile,
	heading: string
): Promise<{ added: number }> {
	if (!appHasDailyNotesPluginLoaded()) {
		throw new Error(
			'Enable the core "Daily notes" plugin or the "Periodic Notes" community plugin to use "Add to daily note".'
		);
	}

	const date = moment(jprNote.basename, "YYYY-MM-DD", true);
	if (!date.isValid()) {
		throw new Error(`"${jprNote.basename}" isn't a Just Press Record note (expected a YYYY-MM-DD filename).`);
	}

	const recs = parseRecBlocks(await app.vault.cachedRead(jprNote));
	if (recs.size === 0) return { added: 0 };

	const allDailyNotes = getAllDailyNotes();
	const dailyNote = getDailyNote(date, allDailyNotes) ?? (await createDailyNote(date));

	const dailyContent = await app.vault.cachedRead(dailyNote);
	const already = mergedFiles(dailyContent);
	const missing = [...recs.entries()]
		.filter(([file]) => !already.has(file))
		.sort(([a], [b]) => a.localeCompare(b));

	if (missing.length === 0 && hasSourceLink(dailyContent, jprNote.path)) {
		return { added: 0 };
	}

	const addition = missing
		.map(([file, rec]) => `<!-- jpr:merged file="${escapeAttr(file)}" -->\n${textOnly(rec.body)}\n<!-- jpr:merged-end -->`)
		.join("\n\n");

	await app.vault.process(dailyNote, (current) =>
		updateHeadingSection(current, heading, (sectionBody) => {
			let body = sectionBody;
			if (!hasSourceLink(body, jprNote.path)) {
				const sourceLink = app.fileManager.generateMarkdownLink(jprNote, dailyNote.path);
				const sourceBlock = `<!-- jpr:source file="${escapeAttr(jprNote.path)}" -->${sourceLink}<!-- jpr:source-end -->`;
				body = body ? `${sourceBlock}\n\n${body}` : sourceBlock;
			}
			return addition ? (body ? `${body}\n\n${addition}` : addition) : body;
		})
	);

	return { added: missing.length };
}
