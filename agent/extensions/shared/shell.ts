export const RESULT_LIMIT_BYTES = 50 * 1024;
export const TAIL_LIMIT_BYTES = 64 * 1024;

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function appendTail(current: string, data: Buffer, limitBytes = TAIL_LIMIT_BYTES): string {
	let next = current + data.toString("utf8");
	const bytes = Buffer.byteLength(next, "utf8");
	if (bytes <= limitBytes) return next;

	let cut = bytes - limitBytes;
	let index = 0;
	while (index < next.length && cut > 0) {
		cut -= Buffer.byteLength(next[index], "utf8");
		index++;
	}
	next = next.slice(index);
	return next;
}

export function truncateTail(text: string, maxBytes = RESULT_LIMIT_BYTES): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };

	let bytes = 0;
	let index = text.length;
	while (index > 0 && bytes < maxBytes) {
		index--;
		bytes += Buffer.byteLength(text[index], "utf8");
	}
	return { text: text.slice(index), truncated: true };
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

export function timestampForFile(date = new Date()): string {
	return date.toISOString().replace(/[:.]/g, "-");
}
