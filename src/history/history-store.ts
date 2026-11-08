import { HistoryEvent } from "src/history/history-events";

/**
 * A line of a history file that couldn't be parsed (e.g. cut off by a crash, or a sync conflict).
 */
export interface CorruptHistoryLine {
    file: string;
    lineNo: number;
}

export interface HistoryReadResult {
    // All events, sorted by time
    events: HistoryEvent[];
    corruptLines: CorruptHistoryLine[];
}

export interface IHistoryStore {
    // Human readable description of where the history is stored
    readonly location: string;

    append(event: HistoryEvent): Promise<void>;
    readAll(): Promise<HistoryReadResult>;
}

/**
 * The subset of Obsidian's DataAdapter used by the AdapterHistoryStore.
 */
export interface HistoryFileAdapter {
    exists(normalizedPath: string): Promise<boolean>;
    mkdir(normalizedPath: string): Promise<void>;
    write(normalizedPath: string, data: string): Promise<void>;
    append(normalizedPath: string, data: string): Promise<void>;
    read(normalizedPath: string): Promise<string>;
    list(normalizedPath: string): Promise<{ files: string[]; folders: string[] }>;
}

const HISTORY_FILE_REGEX = /(^|\/)events-\d{4}-\d{2}-[0-9a-z]+\.jsonl$/;

/**
 * Parses the content of a history file (one JSON event per line).
 *
 * @param {string} text - The file content.
 * @param {string} file - The file name, used for reporting corrupt lines.
 */
export function parseHistoryFile(
    text: string,
    file: string,
): { events: HistoryEvent[]; corruptLines: CorruptHistoryLine[] } {
    const events: HistoryEvent[] = [];
    const corruptLines: CorruptHistoryLine[] = [];

    const lines: string[] = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line: string = lines[i].trim();
        if (line.length === 0) continue;

        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            // A single damaged line must not make the whole history unreadable. Damaged lines are reported to the
            // user on the statistics page instead.
            corruptLines.push({ file, lineNo: i + 1 });
            continue;
        }

        if (isHistoryEvent(parsed)) {
            events.push(parsed);
        } else {
            corruptLines.push({ file, lineNo: i + 1 });
        }
    }
    return { events, corruptLines };
}

function isHistoryEvent(value: unknown): value is HistoryEvent {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
        typeof record.v === "number" &&
        typeof record.id === "string" &&
        typeof record.ts === "number" &&
        typeof record.type === "string" &&
        typeof record.device === "string"
    );
}

function sortEventsByTime(events: HistoryEvent[]): HistoryEvent[] {
    return events.sort((a, b) => a.ts - b.ts);
}

/**
 * Stores the history as JSON lines files within a folder (by default the plugin's folder).
 *
 * Every device writes to its own file per month, e.g. "events-2026-11-x7k2p9q1.jsonl". Files are only ever appended
 * to, and never written by two devices, so syncing the vault (Obsidian Sync, iCloud, git, ...) can't cause conflicts.
 */
export class AdapterHistoryStore implements IHistoryStore {
    public readonly location: string;
    private adapter: HistoryFileAdapter;
    private deviceId: string;
    private writeQueue: Promise<void> = Promise.resolve();
    private knownFiles: Set<string> = new Set();

    constructor(adapter: HistoryFileAdapter, folder: string, deviceId: string) {
        if (folder.length === 0) throw new Error("AdapterHistoryStore: empty folder path");
        if (!/^[0-9a-z]+$/.test(deviceId)) {
            throw new Error(`AdapterHistoryStore: invalid device id "${deviceId}"`);
        }
        this.adapter = adapter;
        this.location = folder;
        this.deviceId = deviceId;
    }

    filePathFor(event: HistoryEvent): string {
        const date: Date = new Date(event.ts);
        const month: string = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        return `${this.location}/events-${month}-${this.deviceId}.jsonl`;
    }

    append(event: HistoryEvent): Promise<void> {
        const line: string = JSON.stringify(event) + "\n";
        const path: string = this.filePathFor(event);

        // Appends are serialized, so that lines can never interleave and the file order matches the event order
        const operation: Promise<void> = this.writeQueue.then(async () => {
            if (this.knownFiles.has(path) || (await this.adapter.exists(path))) {
                await this.adapter.append(path, line);
            } else {
                if (!(await this.adapter.exists(this.location))) {
                    await this.adapter.mkdir(this.location);
                }
                await this.adapter.write(path, line);
            }
            this.knownFiles.add(path);
        });

        // The caller gets the error of a failed append. The queue itself continues with the next append.
        this.writeQueue = operation.then(
            (): void => undefined,
            (): void => undefined,
        );
        return operation;
    }

    async readAll(): Promise<HistoryReadResult> {
        await this.writeQueue;

        const events: HistoryEvent[] = [];
        const corruptLines: CorruptHistoryLine[] = [];
        if (!(await this.adapter.exists(this.location))) {
            return { events, corruptLines };
        }

        const listed = await this.adapter.list(this.location);
        for (const file of listed.files) {
            if (!HISTORY_FILE_REGEX.test(file)) continue;
            const parsed = parseHistoryFile(await this.adapter.read(file), file);
            events.push(...parsed.events);
            corruptLines.push(...parsed.corruptLines);
        }
        return { events: sortEventsByTime(events), corruptLines };
    }
}

/**
 * Keeps the history in memory only. Used for unit tests.
 */
export class InMemoryHistoryStore implements IHistoryStore {
    public readonly location: string = "memory";
    public events: HistoryEvent[] = [];

    append(event: HistoryEvent): Promise<void> {
        this.events.push(event);
        return Promise.resolve();
    }

    readAll(): Promise<HistoryReadResult> {
        return Promise.resolve({ events: sortEventsByTime([...this.events]), corruptLines: [] });
    }
}
