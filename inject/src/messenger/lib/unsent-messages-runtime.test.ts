import { beforeAll, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type {
  initUnsentMessages,
  interceptUnsentMessageModules,
} from "../features/unsent-messages";

let source: string;
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import { initUnsentMessages, interceptUnsentMessageModules } from "../features/unsent-messages";
        Object.assign(globalThis, { initUnsentMessages, interceptUnsentMessageModules });`,
      resolveDir: import.meta.dir,
    },
    bundle: true,
    write: false,
  });
  source = bundle.outputFiles[0]!.text;
});

test.each([
  ["chatpane:unsent-messages-reset", 0],
  ["chatpane:unsent-messages-changed", 1],
] as const)("%s controls pending captures without disabling new ones", async (event, expected) => {
  const timers = new Set<() => void>();
  const adds: unknown[] = [];
  const window = Object.assign(new EventTarget(), {
    __TAURI_INTERNALS__: {},
    __CHATPANE_SETTINGS__: { recover_unsent_messages: true },
    require: () => ({
      fromTableAscending: () => ({ getKeyRange: () => null }),
      firstAsync: async () => ({
        messageId: "original",
        threadKey: "42",
        senderId: "7",
        timestampMs: "1700000000000",
        primarySortKey: "1700000000851",
        text: "kept text",
      }),
      toArrayAsync: async () => [],
    }),
  });
  const context = {
    window,
    document: { cookie: "c_user=1" },
    setTimeout: (run: () => void) => {
      timers.add(run);
      return run;
    },
    clearTimeout: (run: () => void) => timers.delete(run),
    chatpaneUnsentMessages: async (request: { op: string }) => {
      if (request.op === "add") adds.push(request);
      return { revision: 1, messages: [] };
    },
  };
  const runtime = runInNewContext(
    `${source}; ({ initUnsentMessages, interceptUnsentMessageModules })`,
    context,
  ) as {
    initUnsentMessages: typeof initUnsentMessages;
    interceptUnsentMessageModules: typeof interceptUnsentMessageModules;
  };
  runtime.initUnsentMessages();
  const define = runtime.interceptUnsentMessageModules((...args: unknown[]) =>
    (args[2] as () => unknown)(),
  );
  const handler = (name: string) =>
    define(name, [], () => ({ call: async () => {} })) as {
      call(...args: unknown[]): Promise<unknown>;
    };
  const remove = handler("MAWBridgeDeleteMessagesHandler");
  const notice = handler("MAWBridgeNewMsgHandler");
  const transaction = { messages: { index: () => null }, attachments: null };
  const pair = async () => {
    await remove.call(transaction, { threadJid: "42@msgr", messages: [{ msgId: "original" }] });
    await notice.call(transaction, {
      type_: "Revoked",
      chatJid: "42@msgr",
      sortOrderMs: 1700000000851,
      msgId: "notice",
    });
    expect(timers.size).toBe(1);
  };
  const expire = () => {
    for (const run of [...timers]) {
      timers.delete(run);
      run();
    }
  };
  await pair();
  window.dispatchEvent(new Event(event));
  expire();
  expect(adds).toHaveLength(expected);
  // Delete All leaves the setting on: later unsends can still be kept.
  await pair();
  expire();
  expect(adds).toHaveLength(expected + 1);
});

test("Delete All ignores a native list response already in flight", async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise<unknown>((done) => {
    resolve = done;
  });
  let shown: unknown;
  const window = Object.assign(new EventTarget(), {
    __TAURI_INTERNALS__: {},
    __CHATPANE_SETTINGS__: { recover_unsent_messages: true },
    require: () => ({
      createElement: () => null,
      useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => {
        shown = snapshot();
        return shown;
      },
    }),
  });
  const runtime = runInNewContext(
    `${source}; ({ initUnsentMessages, interceptUnsentMessageModules })`,
    {
      window,
      document: { cookie: "c_user=1" },
      chatpaneUnsentMessages: () => pending,
    },
  ) as {
    initUnsentMessages: typeof initUnsentMessages;
    interceptUnsentMessageModules: typeof interceptUnsentMessageModules;
  };
  runtime.initUnsentMessages();
  const define = runtime.interceptUnsentMessageModules((...args: unknown[]) =>
    (args[2] as () => unknown)(),
  );
  const notice = define("MWV2ChatUnsentMessage.react", [], () => ({
    MWV2ChatUnsentMessage: () => null,
  })) as { MWV2ChatUnsentMessage(props: unknown): unknown };
  window.dispatchEvent(new Event("chatpane:unsent-messages-reset"));
  resolve({
    revision: 1,
    messages: [
      { id: "notice", thread: "42", sender: "7", sentMs: 1, text: "deleted", attachments: [] },
    ],
  });
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  notice.MWV2ChatUnsentMessage({ message: { messageId: "notice" } });
  expect(shown).toBeUndefined();
});
