import { createHash } from "crypto";

export interface RecBlock {
	hash: string;
	body: string;
}

export function hashOf(s: string): string {
	return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export function escapeAttr(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export function unescapeAttr(s: string): string {
	return s.replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
}

const REC_RE = /<!-- jpr:rec file="([^"]*)" hash="([0-9a-f]+)" -->\n([\s\S]*?)\n<!-- jpr:rec-end -->/g;

/** Parses the individually tagged transcription blocks out of a note's content. */
export function parseRecBlocks(content: string): Map<string, RecBlock> {
	const map = new Map<string, RecBlock>();
	for (const m of content.matchAll(REC_RE)) {
		map.set(unescapeAttr(m[1]!), { hash: m[2]!, body: m[3]! });
	}
	return map;
}
