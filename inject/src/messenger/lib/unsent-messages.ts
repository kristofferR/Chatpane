/*
 * Keep unsent messages (Ref #370): copy a message someone unsends just before
 * Messenger clears it, so Chatpane can show it under the "unsent a message"
 * notice. Opt-in; the native side keeps the copies encrypted on this computer
 * (src-tauri/src/unsent_messages.rs). Everything here reads Messenger's own
 * local database at the moment of the unsend and never writes to it.
 *
 * Messenger unsends in three ways (read from its bundles and watched live):
 *  - Regular chats: the LSUpsertMessage or LSDeleteThenInsertMessage stored
 *    procedure overwrites the row with isUnsent (argument 17) and clears its
 *    text. The wrapper reads the row first, inside the same transaction.
 *  - Encrypted chats: the worker's "DeleteMessages" event removes the row,
 *    then a "NewMsg" of type Revoked adds the notice as a new row with its own
 *    id but the original's thread and sort key (its time in milliseconds).
 *    Neither event names the other, so a deleted row is held briefly and
 *    kept only when a Revoked message with the same thread and sort key
 *    follows ("Remove for you" deletes too, with no Revoked message). Either
 *    may come first.
 *  - Encrypted chats, rarely: "MsgUpdated" (MAWUpdateMsg) turns the existing
 *    row into the notice in place.
 */
import { i64Text, revealText } from "./conversation-export";
import { pageRequire } from "./facebook-loader";
import { sameArity, wrapFactoryExports } from "./page-notifications";

type Row = Record<string, unknown>;
type Factory = (...args: unknown[]) => unknown;
type I64ToText = (value: unknown) => unknown;
type Unvault = (value: string) => unknown;

export type UnsentAttachmentKind =
  | "image"
  | "video"
  | "audio"
  | "file"
  | "link"
  | "sticker"
  | "other";

export interface UnsentAttachment {
  kind: UnsentAttachmentKind;
  /** A file name or link title. */
  name?: string | null;
  durationMs?: number | null;
}

/** A kept copy, as the page sends it to native code and gets it back. */
export interface UnsentCopy {
  /** The id of the row Messenger shows as "unsent a message". */
  id: string;
  thread: string;
  sender: string;
  sentMs: number;
  text: string | null;
  attachments: UnsentAttachment[];
}

const KINDS = new Set<string>(["image", "video", "audio", "file", "link", "sticker", "other"]);
export const MAX_ATTACHMENTS = 20;
/** Messenger's attachment types (MessagingAttachmentType). */
const ATTACHMENT_TYPES: Record<number, UnsentAttachmentKind> = {
  1: "sticker",
  2: "image",
  3: "image",
  4: "video",
  5: "audio",
  6: "file",
  7: "link",
  8: "image",
  9: "video",
  10: "sticker",
  12: "audio",
  15: "sticker",
};
/** Messenger's messages and attachments tables, by stored-procedure number. */
const MESSAGES_TABLE = 12;
const ATTACHMENTS_TABLE = 16;
/** The unsent-message type of an encrypted bridge message (MAWMsg.unsent). */
const REVOKED = "Revoked";
/** How long a deleted encrypted row, or a Revoked message, waits for its pair. */
export const PAIR_WINDOW_MS = 30_000;

const isRow = (value: unknown): value is Row => !!value && typeof value === "object";

export interface ReadOptions {
  /** The signed-in account: its own unsends aren't kept. */
  account: string | null;
  i64ToText?: I64ToText;
  unvault?: Unvault;
}

function attachmentOf(row: Row, options: ReadOptions): UnsentAttachment | null {
  const plain = (value: unknown) => revealText(value, options.unvault).text;
  const mime = plain(row.playableUrlMimeType) ?? plain(row.previewUrlMimeType);
  const type = Number(i64Text(row.attachmentType, options.i64ToText));
  const filename = plain(row.filename);
  let kind: UnsentAttachmentKind = mime?.startsWith("image/")
    ? "image"
    : mime?.startsWith("video/")
      ? "video"
      : mime?.startsWith("audio/")
        ? "audio"
        : (ATTACHMENT_TYPES[type] ?? (row.hasXma === true ? "link" : filename ? "file" : "other"));
  const title = plain(row.titleText);
  if (kind === "link") {
    // Regular chats replace an unsent message's attachments with a notice
    // that has only a description; it says nothing about the message.
    if (!title && !plain(row.actionUrl)) return null;
  } else if (filename && kind === "other") {
    kind = "file";
  }
  const duration = Number(i64Text(row.playableDurationMs, options.i64ToText));
  return {
    kind,
    name: (kind === "link" ? title : filename) ?? null,
    durationMs:
      (kind === "audio" || kind === "video") && Number.isFinite(duration) && duration > 0
        ? duration
        : null,
  };
}

/**
 * A copy of a message row and its attachments, shown at the row `id`.
 * Null for Messenger's own notices, the account's own messages, rows
 * already unsent, and rows with nothing to show.
 */
export function copyFromRow(
  row: unknown,
  attachments: unknown[],
  id: string,
  options: ReadOptions,
): UnsentCopy | null {
  if (!isRow(row) || row.isAdminMessage === true || row.isUnsent === true) return null;
  const thread = i64Text(row.threadKey, options.i64ToText);
  const sender = i64Text(row.senderId, options.i64ToText);
  const sent = Number(i64Text(row.timestampMs, options.i64ToText));
  if (!thread || !sender || sender === options.account || !(sent > 0) || !id) return null;
  const text = revealText(row.text, options.unvault).text;
  const kept = attachments
    .filter(isRow)
    .map((attachment) => attachmentOf(attachment, options))
    .filter((attachment): attachment is UnsentAttachment => attachment !== null)
    .slice(0, MAX_ATTACHMENTS);
  const sticker = i64Text(row.stickerId, options.i64ToText);
  if (sticker && sticker !== "0" && !kept.some((attachment) => attachment.kind === "sticker")) {
    kept.push({ kind: "sticker", name: null, durationMs: null });
  }
  if (!text && kept.length === 0) return null;
  return { id, thread, sender, sentMs: sent, text, attachments: kept };
}

/** Copies from native code, keeping only well-formed ones. */
export function parseCopies(data: unknown): UnsentCopy[] {
  const list = isRow(data) && Array.isArray(data.messages) ? data.messages : [];
  const copies: UnsentCopy[] = [];
  for (const item of list) {
    if (!isRow(item) || typeof item.id !== "string" || typeof item.thread !== "string") continue;
    if (typeof item.sender !== "string" || typeof item.sentMs !== "number") continue;
    const attachments = (Array.isArray(item.attachments) ? item.attachments : [])
      .filter(isRow)
      .filter((attachment) => typeof attachment.kind === "string")
      .map((attachment) => ({
        kind: (KINDS.has(attachment.kind as string)
          ? attachment.kind
          : "other") as UnsentAttachmentKind,
        name: typeof attachment.name === "string" ? attachment.name : null,
        durationMs: typeof attachment.durationMs === "number" ? attachment.durationMs : null,
      }));
    copies.push({
      id: item.id,
      thread: item.thread,
      sender: item.sender,
      sentMs: item.sentMs,
      text: typeof item.text === "string" ? item.text : null,
      attachments,
    });
  }
  return copies;
}

/** The kept copies this page knows, by the id of their notice row. */
export class UnsentCopies {
  private copies = new Map<string, UnsentCopy>();
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get = (id: unknown): UnsentCopy | undefined =>
    typeof id === "string" ? this.copies.get(id) : undefined;

  replace(copies: UnsentCopy[]) {
    this.copies = new Map(copies.map((copy) => [copy.id, copy]));
    this.emit();
  }

  add(copy: UnsentCopy) {
    this.copies = new Map(this.copies).set(copy.id, copy);
    this.emit();
  }

  clear() {
    if (this.copies.size === 0) return;
    this.copies = new Map();
    this.emit();
  }

  private emit() {
    for (const listener of [...this.listeners]) listener();
  }
}

/** A side waiting for its pair; null when two arrived for one key. */
type Waiting<T> = Map<string, { value: T | null; until: number }>;

/**
 * Pairs an encrypted chat's deleted row with the Revoked message that
 * replaces it. Each side waits up to PAIR_WINDOW_MS for the other. Two rows
 * from one chat and second can't be told apart, so neither is kept rather
 * than one under the other's notice.
 */
export class RevokePairs {
  private readonly deleted: Waiting<UnsentCopy> = new Map();
  private readonly revoked: Waiting<string> = new Map();

  constructor(private readonly now: () => number = Date.now) {}

  /** A thread and a message's sort key (its time in milliseconds). */
  static key(jid: unknown, sortKey: unknown): string | null {
    const time = Number(sortKey);
    if (typeof jid !== "string" || !jid || !Number.isFinite(time) || time <= 0) return null;
    return `${jid}\n${time}`;
  }

  /** A row was deleted; the copy to keep if a Revoked message pairs with it. */
  deletedRow(key: string, copy: UnsentCopy): UnsentCopy | null {
    const id = this.take(this.revoked, key);
    if (id !== undefined) return id === null ? null : { ...copy, id };
    this.wait(this.deleted, key, copy);
    return null;
  }

  /** A Revoked message arrived as row `id`; the copy to keep if one waits. */
  revokedMessage(key: string, id: string): UnsentCopy | null {
    const copy = this.take(this.deleted, key);
    if (copy !== undefined) return copy === null ? null : { ...copy, id };
    this.wait(this.revoked, key, id);
    return null;
  }

  /** The other side waiting under `key`; an ambiguous one stays to the end. */
  private take<T>(map: Waiting<T>, key: string): T | null | undefined {
    const now = this.now();
    for (const side of [this.deleted, this.revoked]) {
      for (const [waiting, entry] of side) if (entry.until <= now) side.delete(waiting);
    }
    const entry = map.get(key);
    if (entry?.value) map.delete(key);
    return entry?.value;
  }

  private wait<T>(map: Waiting<T>, key: string, value: T) {
    map.set(key, { value: map.has(key) ? null : value, until: this.now() + PAIR_WINDOW_MS });
  }
}

/* ------------------------- Facebook module hooks ------------------------ */

export interface CaptureHooks {
  /** Whether the setting is on; off leaves Messenger's code untouched. */
  enabled(): boolean;
  /** How to read rows right now. */
  options(): ReadOptions;
  keep(copy: UnsentCopy): void;
  onError(error: unknown): void;
}

interface LSContext {
  db: { table(id: number): { fetch(query?: unknown): unknown } };
  forEach(iterable: unknown, each: (entry: { item?: unknown }) => unknown): PromiseLike<unknown>;
}

interface FetchStep {
  done?: boolean;
  value?: { item?: unknown };
}

function isContext(value: unknown): value is LSContext {
  const context = value as Partial<LSContext> | null;
  return (
    !!context && typeof context.forEach === "function" && typeof context.db?.table === "function"
  );
}

/**
 * Wrap a message-writing stored procedure (LSUpsertMessage,
 * LSDeleteThenInsertMessage): when it marks a row unsent, copy the row as
 * it is first. The read uses the procedure's own transaction, exactly as the
 * procedure looks the row up, so it sees the row just before the overwrite.
 */
export function wrapMessageProcedure(procedure: Factory, hooks: CaptureHooks): Factory {
  const wrapped = sameArity(function (this: unknown, ...args: unknown[]) {
    const run = () => Reflect.apply(procedure, this, args);
    const context = args[args.length - 1];
    if (args[17] !== true || !hooks.enabled() || !isContext(context)) return run();
    let read: PromiseLike<unknown>;
    try {
      const messages = context.db.table(MESSAGES_TABLE);
      const found = (
        messages.fetch([[[args[9]]], "optimistic"]) as { next(): PromiseLike<FetchStep> }
      ).next();
      read = found.then((step) => {
        const row = step.done ? null : step.value?.item;
        if (!isRow(row) || row.isUnsent === true || row.messageId !== args[8]) return;
        const attachments: unknown[] = [];
        return context
          .forEach(
            context.db
              .table(ATTACHMENTS_TABLE)
              .fetch([[[row.threadKey, row.timestampMs, row.messageId]], "fk_messages"]),
            (entry) => {
              attachments.push(entry?.item);
            },
          )
          .then(() => {
            try {
              const copy = copyFromRow(row, attachments, row.messageId as string, hooks.options());
              if (copy) hooks.keep(copy);
            } catch (error) {
              hooks.onError(error);
            }
          });
      });
    } catch (error) {
      hooks.onError(error);
      return run();
    }
    // A failed read must never stop Messenger's own write.
    return read.then(run, (error: unknown) => {
      hooks.onError(error);
      return run();
    });
  }, procedure);
  // The procedure runtime reads these off the function it calls.
  for (const key of ["__sproc_name__", "__tables__"] as const) {
    if (key in procedure) (wrapped as unknown as Row)[key] = (procedure as unknown as Row)[key];
  }
  return wrapped;
}

interface Queries {
  firstAsync(query: unknown): Promise<unknown>;
  toArrayAsync(query: unknown): Promise<unknown>;
  fromTableAscending(table: unknown): { getKeyRange(...keys: unknown[]): unknown };
}

interface Transaction {
  messages: { index(name: string): unknown };
  attachments: unknown;
}

async function readRow(transaction: Transaction, id: unknown): Promise<[Row, unknown[]] | null> {
  const queries = pageRequire()?.("ReQL") as Queries | undefined;
  if (typeof id !== "string" || typeof queries?.firstAsync !== "function") return null;
  const row = await queries.firstAsync(
    queries.fromTableAscending(transaction.messages.index("messageId")).getKeyRange(id),
  );
  if (!isRow(row)) return null;
  return [row, await readAttachments(transaction, row, queries)];
}

async function readAttachments(transaction: Transaction, row: Row, queries?: Queries) {
  const reql = queries ?? (pageRequire()?.("ReQL") as Queries | undefined);
  const found = await reql?.toArrayAsync(
    reql.fromTableAscending(transaction.attachments).getKeyRange(row.threadKey, row.messageId),
  );
  return Array.isArray(found) ? found : [];
}

/** Run `observe` before `method` without ever holding up or failing it. */
function before(
  exports: Record<string, unknown>,
  name: string,
  observe: (args: unknown[]) => Promise<void>,
  hooks: CaptureHooks,
) {
  const method = exports[name];
  if (typeof method !== "function") return false;
  exports[name] = sameArity(async function (this: unknown, ...args: unknown[]) {
    if (hooks.enabled()) {
      try {
        await observe(args);
      } catch (error) {
        hooks.onError(error);
      }
    }
    return Reflect.apply(method, this, args);
  }, method as Factory);
  return true;
}

/**
 * Hooks for Messenger's encrypted-chat handlers. Each `patch…` takes a
 * module's exports and reports whether it recognised them.
 */
export function encryptedChatHooks(hooks: CaptureHooks, pairs = new RevokePairs()) {
  const revoked = (message: unknown) => {
    if (!isRow(message) || message.type_ !== REVOKED || message.isAuthorMe === true) return;
    const key = RevokePairs.key(message.chatJid, message.sortOrderMs);
    if (!key || typeof message.msgId !== "string") return;
    const copy = pairs.revokedMessage(key, message.msgId);
    if (copy) hooks.keep(copy);
  };
  return {
    /** MAWBridgeDeleteMessagesHandler: hold each deleted row for its pair. */
    patchDelete(exports: Record<string, unknown>) {
      return before(
        exports,
        "call",
        async ([transaction, event]) => {
          if (!isRow(event) || !Array.isArray(event.messages)) return;
          if (typeof event.threadJid !== "string") return;
          for (const item of event.messages) {
            const found = isRow(item)
              ? await readRow(transaction as Transaction, item.msgId)
              : null;
            if (!found) continue;
            const [row, attachments] = found;
            const copy = copyFromRow(row, attachments, row.messageId as string, hooks.options());
            // The Revoked message carries the row's sort key as sortOrderMs.
            const sortKey = i64Text(row.primarySortKey, hooks.options().i64ToText);
            const key = copy && RevokePairs.key(event.threadJid, sortKey);
            const paired = key && pairs.deletedRow(key, copy);
            if (paired) hooks.keep(paired);
          }
        },
        hooks,
      );
    },
    /** MAWBridgeNewMsgHandler: a Revoked message names the notice's row. */
    patchNew(exports: Record<string, unknown>) {
      const single = async ([, message]: unknown[]) => revoked(message);
      const one = before(exports, "call", single, hooks);
      const unwaited = before(exports, "callWithoutWaitingForAnything", single, hooks);
      const bulk = before(
        exports,
        "bulkCall",
        async ([, messages]) => {
          if (Array.isArray(messages)) for (const message of messages) revoked(message);
        },
        hooks,
      );
      return one || unwaited || bulk;
    },
    /** MAWUpdateMsg: a Revoked update turns the existing row into the notice. */
    patchUpdate(exports: Record<string, unknown>) {
      return before(
        exports,
        "call",
        async ([transaction, message, existing]) => {
          if (!isRow(message) || message.type_ !== REVOKED || message.isAuthorMe === true) return;
          if (!isRow(existing) || typeof existing.messageId !== "string") return;
          const attachments = await readAttachments(transaction as Transaction, existing);
          const copy = copyFromRow(existing, attachments, existing.messageId, hooks.options());
          if (copy) hooks.keep(copy);
        },
        hooks,
      );
    },
  };
}

/* ----------------------------- Showing copies ---------------------------- */

interface ReactRuntime {
  createElement(type: unknown, props?: Row | null, ...children: unknown[]): unknown;
  useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, snapshot: () => T): T;
  Fragment: unknown;
}

export interface CopyViewHooks {
  /** The copy's own view (a React element), given React and the copy. */
  render(react: ReactRuntime, copy: UnsentCopy): unknown;
  onError(error: unknown): void;
}

/**
 * MWV2ChatUnsentMessage.react: under someone else's "unsent a message"
 * notice, the copy kept for that row. Without one, Messenger's notice
 * renders exactly as before.
 */
export function wrapUnsentNoticeFactory(
  factory: Factory,
  copies: UnsentCopies,
  view: CopyViewHooks,
): Factory {
  return wrapFactoryExports(factory, (exports) => {
    const Notice = exports.MWV2ChatUnsentMessage;
    if (typeof Notice !== "function") return false;
    function ChatpaneUnsentMessage(props: Row) {
      const react = pageRequire()?.("react") as ReactRuntime | undefined;
      const message = isRow(props?.message) ? props.message : null;
      const notice = react?.createElement(Notice, props);
      if (!react || typeof react.useSyncExternalStore !== "function") return notice ?? null;
      const copy = react.useSyncExternalStore(copies.subscribe, () =>
        copies.get(message?.messageId),
      );
      if (!copy || props.outgoing === true) return notice;
      let shown: unknown = null;
      try {
        shown = view.render(react, copy);
      } catch (error) {
        view.onError(error);
      }
      return react.createElement(react.Fragment, null, notice, shown);
    }
    exports.MWV2ChatUnsentMessage = ChatpaneUnsentMessage;
    return true;
  });
}
