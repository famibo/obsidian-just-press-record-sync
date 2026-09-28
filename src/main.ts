import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	moment,
	normalizePath,
} from "obsidian";
import { promises as fs } from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { execFile } from "child_process";
import { createHash } from "crypto";
import { extractJprTranscriptFromFile } from "./jpr";

type LinkMode = "none" | "file-url" | "embed-copy";

interface JprSettings {
	jprFolder: string; // absolute path to the Just Press Record iCloud folder
	vaultFolder: string; // vault folder for Just Press Record notes
	templatePath: string; // vault path of the template
	linkMode: LinkMode;
	audioFolder: string; // vault folder for copied M4A files (embed-copy mode)
	lookbackDays: number; // how many days (incl. today) to scan
	runOnStartup: boolean;
}

const DEFAULT_SETTINGS: JprSettings = {
	jprFolder: "",
	vaultFolder: "Just Press Record notes",
	templatePath: "Templates/Just Press Record note.md",
	linkMode: "embed-copy",
	audioFolder: "Just Press Record notes/Audio",
	lookbackDays: 1,
	runOnStartup: true,
};

// Everything between these markers is owned by the plugin and regenerated on
// each run. Anything you write outside them is never touched.
const START = "<!-- jpr:start -->";
const END = "<!-- jpr:end -->";

interface Recording {
	file: string;
	fullPath: string;
	text: string;
}

export default class JustPressRecordSyncPlugin extends Plugin {
	settings!: JprSettings;
	private running = false;
	private pendingDownloads = 0;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new JprSettingTab(this.app, this));

		this.addCommand({
			id: "import-today",
			name: "Import today's recordings",
			callback: () => this.run(1),
		});
		this.addCommand({
			id: "import-recent",
			name: "Import recordings from recent days",
			callback: () => this.run(this.settings.lookbackDays),
		});
		this.addRibbonIcon("mic", "Import Just Press Record voice recordings", () =>
			this.run(this.settings.lookbackDays)
		);

		if (this.settings.runOnStartup) {
			this.app.workspace.onLayoutReady(() =>
				this.run(this.settings.lookbackDays)
			);
		}
	}

	async run(days: number) {
		if (this.running) return;
		if (!this.settings.jprFolder) {
			new Notice("Set the Just Press Record iCloud folder in the plugin settings first.");
			return;
		}
		this.running = true;
		this.pendingDownloads = 0;
		try {
			let updated = 0;
			for (let i = 0; i < days; i++) {
				const date = moment().subtract(i, "days").format("YYYY-MM-DD");
				if (await this.processDay(date)) updated++;
			}
			const msg = updated
				? `Just Press Record Sync: updated ${updated} note(s).`
				: "Just Press Record Sync: nothing new.";
			const pending = this.pendingDownloads
				? ` ${this.pendingDownloads} recording(s) still downloading from iCloud, run again shortly.`
				: "";
			new Notice(msg + pending);
		} catch (e) {
			console.error(e);
			new Notice(`Just Press Record import failed: ${e instanceof Error ? e.message : e}`);
		} finally {
			this.running = false;
		}
	}

	/** Returns true if a note was created or changed. */
	private async processDay(date: string): Promise<boolean> {
		const recordings = await this.collectRecordings(date);
		if (recordings.length === 0) return false;

		const notePath = normalizePath(`${this.settings.vaultFolder}/${date}.md`);
		const existing = this.app.vault.getAbstractFileByPath(notePath);
		const existingContent = existing instanceof TFile ? await this.app.vault.cachedRead(existing) : undefined;

		const block = await this.buildBlock(date, recordings, existingContent);

		if (existing instanceof TFile) {
			let changed = false;
			await this.app.vault.process(existing, (content) => {
				const next = replaceBlock(content, block);
				changed = next !== content;
				return next;
			});
			return changed;
		}

		await this.ensureFolder(this.settings.vaultFolder);
		const template = await this.loadTemplate();
		await this.app.vault.create(notePath, renderTemplate(template, date, block));
		return true;
	}

	private async collectRecordings(date: string): Promise<Recording[]> {
		const dayDir = path.join(this.settings.jprFolder, date);
		let entries: string[];
		try {
			entries = await fs.readdir(dayDir);
		} catch {
			return []; // no folder for that day
		}

		const out: Recording[] = [];

		for (const name of entries.sort()) {
			const full = path.join(dayDir, name);

			// iCloud placeholder for a file not yet downloaded: ".foo.m4a.icloud"
			if (/^\..+\.m4a\.icloud$/i.test(name)) {
				requestDownload(full);
				this.pendingDownloads++;
				continue;
			}
			if (!name.toLowerCase().endsWith(".m4a")) continue;

			const text = (await extractJprTranscriptFromFile(full))?.trim();
			if (!text) continue;

			// Strip any leading punctuation and whitespace
			const body = text.replace(/^[\s.,:;!?-]+/, "");
			out.push({ file: name, fullPath: full, text: body });
		}
		return out;
	}

	/**
	 * Builds the day's managed block. Each transcription is individually tagged
	 * with a content hash; if its current text in the note no longer matches
	 * that hash, the user has edited it, so it's kept untouched instead of
	 * being regenerated.
	 */
	private async buildBlock(date: string, recs: Recording[], existingContent: string | undefined): Promise<string> {
		const existingRecs = existingContent ? parseRecBlocks(existingContent) : new Map<string, RecBlock>();
		const consumed = new Set<string>();
		const entries: { file: string; body: string; hash: string }[] = [];

		for (const r of recs) {
			consumed.add(r.file);
			const existing = existingRecs.get(r.file);
			const edited = existing !== undefined && hashOf(existing.body) !== existing.hash;

			let body: string;
			let hash: string;
			if (edited) {
				body = existing.body;
				hash = existing.hash;
			} else {
				const link = await this.linkFor(date, r);
				body = link ? `${r.text}\n\n${link}` : r.text;
				hash = hashOf(body);
			}
			entries.push({ file: r.file, body, hash });
		}

		// Keep edited transcriptions even if their source recording is no
		// longer found (e.g. moved or renamed) rather than silently dropping
		// the edit.
		for (const [file, rec] of existingRecs) {
			if (consumed.has(file) || hashOf(rec.body) === rec.hash) continue;
			entries.push({ file, body: rec.body, hash: rec.hash });
		}

		entries.sort((a, b) => a.file.localeCompare(b.file));

		const parts = entries.map(
			(e) => `<!-- jpr:rec file="${escapeAttr(e.file)}" hash="${e.hash}" -->\n${e.body}\n<!-- jpr:rec-end -->`
		);
		return `${START}\n${parts.join("\n\n")}\n${END}`;
	}

	private async linkFor(date: string, r: Recording): Promise<string> {
		switch (this.settings.linkMode) {
			case "file-url":
				// Clickable link to the original file (desktop only).
				return `[🎙 ${r.file}](${pathToFileURL(r.fullPath).href})`;

			case "embed-copy": {
				// Copy the audio into the vault and embed it: gives an inline
				// player and also works on iPhone.
				const target = normalizePath(`${this.settings.audioFolder}/${date} ${r.file}`);
				if (!this.app.vault.getAbstractFileByPath(target)) {
					await this.ensureFolder(this.settings.audioFolder);
					const buf = await fs.readFile(r.fullPath);
					const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
					await this.app.vault.createBinary(target, ab);
				}
				return `![[${target}]]`;
			}

			default:
				return "";
		}
	}

	private async loadTemplate(): Promise<string> {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.templatePath));
		if (f instanceof TFile) return this.app.vault.cachedRead(f);
		return "# {{title}}\n\n{{transcriptions}}\n";
	}

	private async ensureFolder(folder: string) {
		const p = normalizePath(folder);
		if (!this.app.vault.getAbstractFileByPath(p)) {
			await this.app.vault.createFolder(p);
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/** Supports {{title}}, {{date}}, {{date:FORMAT}}, {{time}}, {{time:FORMAT}}, {{transcriptions}}. */
function renderTemplate(tpl: string, date: string, block: string): string {
	const d = moment(date, "YYYY-MM-DD");
	const out = tpl
		.replace(/{{\s*title\s*}}/g, () => date)
		.replace(/{{\s*date(?::([^}]+))?\s*}}/g, (_m, fmt?: string) => d.format(fmt?.trim() || "YYYY-MM-DD"))
		.replace(/{{\s*time(?::([^}]+))?\s*}}/g, (_m, fmt?: string) => moment().format(fmt?.trim() || "HH:mm"));

	if (/{{\s*transcriptions\s*}}/.test(out)) {
		return out.replace(/{{\s*transcriptions\s*}}/, () => block);
	}
	return `${out.trimEnd()}\n\n${block}\n`;
}

interface RecBlock {
	hash: string;
	body: string;
}

function hashOf(s: string): string {
	return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function escapeAttr(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function unescapeAttr(s: string): string {
	return s.replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
}

const REC_RE = /<!-- jpr:rec file="([^"]*)" hash="([0-9a-f]+)" -->\n([\s\S]*?)\n<!-- jpr:rec-end -->/g;

/** Parses the individually tagged transcription blocks out of a note's content. */
function parseRecBlocks(content: string): Map<string, RecBlock> {
	const map = new Map<string, RecBlock>();
	for (const m of content.matchAll(REC_RE)) {
		map.set(unescapeAttr(m[1]!), { hash: m[2]!, body: m[3]! });
	}
	return map;
}

/** Replace the managed block, or append it if the note doesn't have one yet. */
function replaceBlock(content: string, block: string): string {
	const s = content.indexOf(START);
	const e = content.indexOf(END);
	if (s !== -1 && e > s) {
		return content.slice(0, s) + block + content.slice(e + END.length);
	}
	return `${content.trimEnd()}\n\n${block}\n`;
}

/** Ask macOS to download an evicted iCloud file (fire and forget). */
function requestDownload(placeholderPath: string) {
	const dir = path.dirname(placeholderPath);
	const realName = path.basename(placeholderPath).slice(1, -".icloud".length);
	execFile("brctl", ["download", path.join(dir, realName)], () => {});
}

class JprSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: JustPressRecordSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl)
			.setName("Just Press Record iCloud folder")
			.setDesc("Absolute path to the iCloud folder containing the YYYY-MM-DD subfolders.")
			.addText((t) =>
				t.setPlaceholder("/Users/you/Library/Mobile Documents/…/Documents")
					.setValue(s.jprFolder)
					.onChange(async (v) => { s.jprFolder = v.trim(); await save(); })
			);

		new Setting(containerEl)
			.setName("Just Press Record vault folder")
			.addText((t) => t.setValue(s.vaultFolder).onChange(async (v) => { s.vaultFolder = v.trim(); await save(); }));

		new Setting(containerEl)
			.setName("Template file")
			.setDesc("Vault path. Placeholders: {{title}}, {{date}}, {{date:FORMAT}}, {{time}}, {{transcriptions}}.")
			.addText((t) => t.setValue(s.templatePath).onChange(async (v) => { s.templatePath = v.trim(); await save(); }));

		new Setting(containerEl)
			.setName("Audio links")
			.addDropdown((d) =>
				d.addOptions({
					none: "No links",
					"file-url": "Link to original file (desktop only)",
					"embed-copy": "Copy into vault and embed player",
				})
					.setValue(s.linkMode)
					.onChange(async (v) => { s.linkMode = v as LinkMode; await save(); })
			);

		new Setting(containerEl)
			.setName("Audio folder")
			.setDesc("Where copied recordings go (embed mode only).")
			.addText((t) => t.setValue(s.audioFolder).onChange(async (v) => { s.audioFolder = v.trim(); await save(); }));

		new Setting(containerEl)
			.setName("Days to scan")
			.setDesc("Number of days back, including today.")
			.addText((t) =>
				t.setValue(String(s.lookbackDays)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (n > 0) { s.lookbackDays = n; await save(); }
				})
			);

		new Setting(containerEl)
			.setName("Run on startup")
			.addToggle((t) => t.setValue(s.runOnStartup).onChange(async (v) => { s.runOnStartup = v; await save(); }));
	}
}
