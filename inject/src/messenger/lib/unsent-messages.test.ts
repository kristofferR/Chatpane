import { afterEach, describe, expect, test } from "bun:test";
import {
  type CaptureHooks,
  copyFromRow,
  encryptedChatHooks,
  PAIR_WINDOW_MS,
  parseCopies,
  RevokePairs,
  UnsentCopies,
  type UnsentCopy,
  wrapMessageProcedure,
  wrapUnsentNoticeFactory,
} from "./unsent-messages";

// Messenger's I64 values are opaque objects; model them as tagged boxes.
const i64 = (value: string) => ({ i64: value });
const i64ToText = (value: unknown) => (value as { i64?: string } | null)?.i64;
const MARKER = "1234567890##0987654321";
const vaulted = (secret: string) => `${MARKER}AQ${btoa(secret)}${MARKER}`;
const unvault = (value: string) =>
  value.startsWith(MARKER) ? atob(value.slice(MARKER.length + 2, -MARKER.length)) : value;
const options = { account: "1", i64ToText, unvault };

function row(overrides: Record<string, unknown> = {}) {
  return {
    threadKey: i64("42"),
    timestampMs: i64("1700000000000"),
    primarySortKey: i64("1700000000851"),
    messageId: "mid.$abc",
    senderId: i64("7"),
    text: "see you at 6",
    isUnsent: false,
    ...overrides,
  };
}

const page = globalThis as { window?: unknown };
afterEach(() => {
  delete page.window;
});

describe("copyFromRow", () => {
  test("copies someone else's text and attachments", () => {
    const copy = copyFromRow(
      row(),
      [
        { attachmentType: i64("2"), hasMedia: true },
        { playableUrlMimeType: "audio/mpeg", playableDurationMs: i64("12400") },
        { filename: "plan.pdf", previewUrlMimeType: "application/pdf" },
        { hasXma: true, attachmentType: i64("7"), titleText: "A link" },
      ],
      "notice-row",
      options,
    );
    expect(copy).toEqual({
      id: "notice-row",
      thread: "42",
      sender: "7",
      sentMs: 1700000000000,
      text: "see you at 6",
      attachments: [
        { kind: "image", name: null, durationMs: null },
        { kind: "audio", name: null, durationMs: 12400 },
        { kind: "file", name: "plan.pdf", durationMs: null },
        { kind: "link", name: "A link", durationMs: null },
      ],
    });
  });

  test("decrypts an encrypted chat's vaulted text", () => {
    expect(copyFromRow(row({ text: vaulted("secret") }), [], "x", options)?.text).toBe("secret");
  });

  test("skips the account's own messages, notices, unsent rows and empty ones", () => {
    expect(copyFromRow(row({ senderId: i64("1") }), [], "x", options)).toBeNull();
    expect(copyFromRow(row({ isAdminMessage: true }), [], "x", options)).toBeNull();
    expect(copyFromRow(row({ isUnsent: true }), [], "x", options)).toBeNull();
    // Text this page can't decrypt is never kept as text.
    expect(copyFromRow(row({ text: vaulted("x") }), [], "x", { account: "1" })).toBeNull();
    // Regular chats' unsent notice attachment says nothing about the message.
    const notice = { hasXma: true, attachmentType: i64("7"), descriptionText: "Ada unsent" };
    expect(copyFromRow(row({ text: null }), [notice], "x", options)).toBeNull();
  });

  test("keeps a sticker", () => {
    const copy = copyFromRow(row({ text: null, stickerId: i64("369") }), [], "x", options);
    expect(copy?.attachments).toEqual([{ kind: "sticker", name: null, durationMs: null }]);
  });
});

test("parseCopies drops malformed copies and unknown kinds", () => {
  const copies = parseCopies({
    enabled: true,
    messages: [
      { id: "a", thread: "1", sender: "2", sentMs: 3, text: "hi", attachments: [{ kind: "x" }] },
      { id: "b", thread: 1, sender: "2", sentMs: 3 },
    ],
  });
  expect(copies).toEqual([
    {
      id: "a",
      thread: "1",
      sender: "2",
      sentMs: 3,
      text: "hi",
      attachments: [{ kind: "other", name: null, durationMs: null }],
    },
  ]);
  expect(parseCopies(null)).toEqual([]);
});

test("UnsentCopies notifies on change and returns stable snapshots", () => {
  const copies = new UnsentCopies();
  let calls = 0;
  const unsubscribe = copies.subscribe(() => calls++);
  const copy = { id: "a" } as UnsentCopy;
  copies.add(copy);
  expect(copies.get("a")).toBe(copy);
  copies.clear();
  copies.clear();
  unsubscribe();
  copies.add(copy);
  expect(calls).toBe(2);
});

describe("RevokePairs", () => {
  const copy = { id: "original" } as UnsentCopy;

  test("pairs a deleted row with the Revoked message in either order", () => {
    const pairs = new RevokePairs();
    const key = RevokePairs.key("123@msgr", 1700000000)!;
    expect(pairs.deletedRow(key, copy)).toBeNull();
    expect(pairs.revokedMessage(key, "notice")).toEqual({ id: "notice" } as UnsentCopy);
    expect(pairs.revokedMessage(key, "again")).toBeNull();

    const other = RevokePairs.key("123@msgr", 1700000001)!;
    expect(pairs.revokedMessage(other, "notice2")).toBeNull();
    expect(pairs.deletedRow(other, copy)).toEqual({ id: "notice2" } as UnsentCopy);
  });

  test("two rows from one chat and second are kept by neither notice", () => {
    const pairs = new RevokePairs();
    const key = RevokePairs.key("123@msgr", 1700000000)!;
    expect(pairs.deletedRow(key, copy)).toBeNull();
    expect(pairs.deletedRow(key, { id: "other" } as UnsentCopy)).toBeNull();
    expect(pairs.revokedMessage(key, "notice1")).toBeNull();
    expect(pairs.revokedMessage(key, "notice2")).toBeNull();
  });

  test("turning the setting off forgets captures waiting for their pair", () => {
    const pairs = new RevokePairs();
    const key = RevokePairs.key("123@msgr", 1700000000851)!;
    pairs.deletedRow(key, copy);
    pairs.clear();
    expect(pairs.revokedMessage(key, "notice")).toBeNull();
  });

  test("a delete with no Revoked message (Remove for you) expires", () => {
    let now = 0;
    const pairs = new RevokePairs(() => now);
    const key = RevokePairs.key("123@msgr", 5)!;
    pairs.deletedRow(key, copy);
    now = PAIR_WINDOW_MS;
    expect(pairs.revokedMessage(key, "notice")).toBeNull();
  });

  test("keys a thread and a sort key", () => {
    expect(RevokePairs.key("t", "1700000000123")).toBe(RevokePairs.key("t", 1700000000123));
    expect(RevokePairs.key("t", 1700000000123)).not.toBe(RevokePairs.key("t", 1700000000124));
    expect(RevokePairs.key("", 1)).toBeNull();
    expect(RevokePairs.key("t", "soon")).toBeNull();
  });
});

function hooks(enabled = true) {
  const kept: UnsentCopy[] = [];
  const errors: unknown[] = [];
  const capture: CaptureHooks = {
    enabled: () => enabled,
    options: () => options,
    keep: (copy) => kept.push(copy),
    onError: (error) => errors.push(error),
  };
  return { capture, kept, errors };
}

describe("wrapMessageProcedure", () => {
  // The stored-procedure runtime: tables queried by number, rows as items.
  function context(existing: Record<string, unknown> | null, attachments: unknown[] = []) {
    const queries: unknown[] = [];
    return {
      queries,
      db: {
        table: (id: number) => ({
          fetch: (query: unknown) => {
            queries.push([id, query]);
            return id === 12
              ? {
                  next: () =>
                    Promise.resolve(
                      existing ? { done: false, value: { item: existing } } : { done: true },
                    ),
                }
              : attachments.map((item) => ({ item }));
          },
        }),
      },
      forEach: (items: { item: unknown }[], each: (entry: { item: unknown }) => void) => {
        for (const entry of items) each(entry);
        return Promise.resolve();
      },
    };
  }
  function call(procedure: (...args: unknown[]) => unknown, unsent: boolean, ctx: unknown) {
    const args: unknown[] = new Array(82).fill(undefined);
    args[8] = "mid.$abc";
    args[9] = "otid";
    args[17] = unsent;
    return procedure(...args, ctx);
  }

  test("copies the row before the procedure overwrites it", async () => {
    const { capture, kept } = hooks();
    const order: string[] = [];
    const original = Object.assign(
      (..._args: unknown[]) => {
        order.push(`write after ${kept.length} kept`);
        return "result";
      },
      { __sproc_name__: "LSMailboxUpsertMessageStoredProcedure", __tables__: ["messages"] },
    );
    const wrapped = wrapMessageProcedure(original, capture) as typeof original;
    expect(wrapped.__sproc_name__).toBe(original.__sproc_name__);
    expect(wrapped.__tables__).toBe(original.__tables__);
    const ctx = context(row(), [{ attachmentType: i64("2") }]);
    expect(await call(wrapped, true, ctx)).toBe("result");
    expect(order).toEqual(["write after 1 kept"]);
    expect(kept[0]?.id).toBe("mid.$abc");
    expect(kept[0]?.attachments[0]?.kind).toBe("image");
    expect(ctx.queries[0]).toEqual([12, [[["otid"]], "optimistic"]]);
  });

  test("leaves other writes, a disabled setting and read failures to Messenger", async () => {
    const { capture, kept, errors } = hooks();
    const original = () => "result";
    const wrapped = wrapMessageProcedure(original, capture);
    const ctx = context(row());
    expect(call(wrapped, false, ctx)).toBe("result");
    expect(ctx.queries).toEqual([]);
    expect(call(wrapMessageProcedure(original, hooks(false).capture), true, ctx)).toBe("result");
    expect(ctx.queries).toEqual([]);
    // An already-unsent row has nothing left to keep.
    expect(await call(wrapped, true, context(row({ isUnsent: true })))).toBe("result");
    const broken = { db: { table: () => ({ fetch: () => ({}) }) }, forEach: () => {} };
    expect(call(wrapped, true, broken)).toBe("result");
    expect(kept).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe("encryptedChatHooks", () => {
  // Messenger's query helpers over a fake transaction.
  function install(rows: Record<string, unknown>[], attachments: Record<string, unknown>[]) {
    const ReQL = {
      fromTableAscending: (table: unknown) => ({
        getKeyRange: (...keys: unknown[]) => ({ table, keys }),
      }),
      firstAsync: async ({ keys }: { keys: unknown[] }) =>
        rows.find((candidate) => candidate.messageId === keys[0]),
      toArrayAsync: async ({ keys }: { keys: unknown[] }) =>
        attachments.filter((candidate) => candidate.messageId === keys[1]),
    };
    page.window = { require: (name: string) => (name === "ReQL" ? ReQL : undefined) };
    return { messages: { index: () => "messageId" }, attachments: "attachments" };
  }

  test("keeps a deleted row when its Revoked message follows", async () => {
    const transaction = install(
      [row({ messageId: "123@msgr.9" })],
      [{ messageId: "123@msgr.9", attachmentType: i64("2") }],
    );
    const { capture, kept } = hooks();
    const encrypted = encryptedChatHooks(capture);
    const calls: string[] = [];
    const handlers: Record<string, unknown> = {
      call: async () => calls.push("delete"),
    };
    expect(encrypted.patchDelete(handlers)).toBe(true);
    const newMsg: Record<string, unknown> = {
      call: async () => calls.push("new"),
      bulkCall: async () => calls.push("bulk"),
      callWithoutWaitingForAnything: async () => calls.push("unwaited"),
    };
    expect(encrypted.patchNew(newMsg)).toBe(true);

    await (handlers.call as (...args: unknown[]) => Promise<unknown>)(transaction, {
      threadJid: "42@msgr",
      // The delete names the unsend time; the Revoked message, the row's sort key.
      messages: [{ msgId: "123@msgr.9", ts: 1700000024 }],
    });
    expect(kept).toEqual([]);
    await (newMsg.call as (...args: unknown[]) => Promise<unknown>)(transaction, {
      type_: "Revoked",
      chatJid: "42@msgr",
      ts: 1700000000,
      sortOrderMs: 1700000000851,
      msgId: "456@msgr.1",
      isAuthorMe: false,
    });
    expect(calls).toEqual(["delete", "new"]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: "456@msgr.1", text: "see you at 6" });
    expect(kept[0]?.attachments[0]?.kind).toBe("image");
  });

  test("ignores Remove for you, own unsends and a disabled setting", async () => {
    const transaction = install([row({ messageId: "a" })], []);
    const { capture, kept } = hooks();
    const encrypted = encryptedChatHooks(capture);
    const handlers: Record<string, unknown> = { call: async () => "deleted" };
    encrypted.patchDelete(handlers);
    const newMsg: Record<string, unknown> = { call: async () => "added" };
    encrypted.patchNew(newMsg);
    const remove = handlers.call as (...args: unknown[]) => Promise<unknown>;
    const add = newMsg.call as (...args: unknown[]) => Promise<unknown>;

    expect(await remove(transaction, { threadJid: "t", messages: [{ msgId: "a", ts: 1 }] })).toBe(
      "deleted",
    );
    // A Revoked message of the account's own, and one for another time.
    await add(transaction, {
      type_: "Revoked",
      chatJid: "t",
      ts: 1700000000,
      sortOrderMs: 1700000000851,
      msgId: "n",
      isAuthorMe: true,
    });
    await add(transaction, {
      type_: "Revoked",
      chatJid: "t",
      ts: 1700000000,
      sortOrderMs: 1700000000852,
      msgId: "n",
    });
    expect(kept).toEqual([]);

    const off = hooks(false);
    const quiet: Record<string, unknown> = { call: async () => "deleted" };
    encryptedChatHooks(off.capture).patchDelete(quiet);
    delete page.window;
    expect(await (quiet.call as () => Promise<unknown>)()).toBe("deleted");
    expect(off.errors).toEqual([]);
  });

  test("keeps the row a Revoked update replaces in place", async () => {
    const transaction = install([], []);
    const { capture, kept } = hooks();
    const update: Record<string, unknown> = { call: async () => "updated" };
    expect(encryptedChatHooks(capture).patchUpdate(update)).toBe(true);
    const existing = row({ messageId: "e1" });
    const call = update.call as (...args: unknown[]) => Promise<unknown>;
    expect(await call(transaction, { type_: "Revoked", isAuthorMe: false }, existing)).toBe(
      "updated",
    );
    await call(transaction, { type_: "Text" }, row({ messageId: "e2" }));
    expect(kept.map((copy) => copy.id)).toEqual(["e1"]);
  });
});

describe("wrapUnsentNoticeFactory", () => {
  const react = {
    Fragment: "Fragment",
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props,
      children,
    }),
    useSyncExternalStore: <T>(_subscribe: unknown, snapshot: () => T) => snapshot(),
  };

  function notice(copies: UnsentCopies) {
    page.window = { require: (name: string) => (name === "react" ? react : undefined) };
    const Original = () => "notice";
    const factory = (...args: unknown[]) => {
      (args[6] as Record<string, unknown>).MWV2ChatUnsentMessage = Original;
    };
    const exports: Record<string, unknown> = {};
    wrapUnsentNoticeFactory(factory, copies, {
      render: (_react, copy) => `copy of ${copy.id}`,
      onError: () => {},
    })(null, null, null, null, null, {}, exports, null);
    return { Notice: exports.MWV2ChatUnsentMessage as (props: unknown) => unknown, Original };
  }

  test("shows the kept copy under someone else's notice", () => {
    const copies = new UnsentCopies();
    copies.add({ id: "m1" } as UnsentCopy);
    const { Notice, Original } = notice(copies);
    const props = { message: { messageId: "m1" }, outgoing: false };
    expect(Notice(props)).toEqual({
      type: "Fragment",
      props: null,
      children: [{ type: Original, props, children: [] }, "copy of m1"],
    });
    // Without a copy, or for the account's own unsend, Messenger's notice alone.
    expect(Notice({ message: { messageId: "m2" } })).toMatchObject({ type: Original });
    expect(Notice({ ...props, outgoing: true })).toMatchObject({ type: Original });
  });
});
