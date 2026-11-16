/* ------------------------- Keep unsent messages ------------------------- */
// Settings → Account → Keep unsent messages (Ref #370), off by default. When
// someone unsends a message while Chatpane runs, the page copies it just
// before Messenger clears it (lib/unsent-messages.ts) and shows the copy
// under Messenger's "unsent a message" notice, marked as kept by Chatpane.
// The native side keeps the copies encrypted on this computer and deletes
// them after the chosen number of days (unsent_messages.rs). Nothing is
// uploaded anywhere. With the setting off, every hook below lets Messenger
// run as it ships.
import { language, t } from "../../i18n";
import { diag } from "../bridge";
import { pageRequire } from "../lib/facebook-loader";
import { wrapFactoryExports } from "../lib/page-notifications";
import { accountId } from "../lib/threads";
import {
  type CaptureHooks,
  encryptedChatHooks,
  parseCopies,
  type ReadOptions,
  RevokePairs,
  type UnsentAttachment,
  UnsentCopies,
  type UnsentCopy,
  wrapMessageProcedure,
  wrapUnsentNoticeFactory,
} from "../lib/unsent-messages";

/** Native to page: the kept copies changed; ask again. */
const CHANGED_EVENT = "chatpane:unsent-messages-changed";
/** Native to page: Delete All succeeded; discard pending captures too. */
const RESET_EVENT = "chatpane:unsent-messages-reset";
/** Messenger's message-writing stored procedures that can mark a row unsent. */
const MESSAGE_PROCEDURES = new Set(["LSUpsertMessage", "LSDeleteThenInsertMessage"]);

type Factory = (...args: unknown[]) => unknown;
type Define = (...args: unknown[]) => unknown;

const copies = new UnsentCopies();
const pairs = new RevokePairs(keep);
let account: string | null = null;
/** The newest native answer applied; older ones arriving late are dropped. */
let revision = 0;
/** Reset invalidates native answers that were already in flight. */
let generation = 0;

function enabled() {
  return account !== null && window.__CHATPANE_SETTINGS__?.recover_unsent_messages === true;
}

function readOptions(): ReadOptions {
  const load = pageRequire();
  const options: ReadOptions = { account };
  try {
    const i64 = load?.("I64") as { to_string?: (value: unknown) => unknown } | undefined;
    const toText = i64?.to_string;
    if (typeof toText === "function") options.i64ToText = (value) => toText.call(i64, value);
  } catch (_) {}
  try {
    // Encrypted chats keep text vaulted at rest; the page holds the key.
    const vault = load?.("MAWVault") as { unvault?: (value: string) => unknown } | undefined;
    const unvault = vault?.unvault;
    if (typeof unvault === "function") options.unvault = (value) => unvault.call(vault, value);
  } catch (_) {}
  return options;
}

/** Ask native code for this account's copies, or keep one. */
async function request(change?: UnsentCopy) {
  const owner = account;
  const requestedGeneration = generation;
  if (!owner || typeof chatpaneUnsentMessages !== "function") return;
  try {
    const data = await chatpaneUnsentMessages(
      change ? { account: owner, op: "add", message: change } : { account: owner, op: "list" },
    );
    // An answer that failed natively keeps what the page shows.
    const answer = data as { error?: unknown; revision?: unknown } | null;
    if (owner !== account || requestedGeneration !== generation || answer?.error === true) return;
    const answered = Number(answer?.revision);
    if (!(answered >= revision)) return;
    revision = answered;
    if (enabled()) copies.replace(parseCopies(data));
    else copies.clear();
  } catch (_) {
    diag("unsent.sync", "request failed");
  }
}

function keep(copy: UnsentCopy) {
  if (!enabled()) return;
  copies.add(copy);
  void request(copy);
}

const ATTACHMENT_LABELS = {
  image: () => t("page.unsent.photo"),
  video: () => t("page.unsent.video"),
  audio: () => t("page.unsent.audio"),
  file: () => t("page.unsent.file"),
  link: () => t("page.unsent.link"),
  sticker: () => t("page.unsent.sticker"),
  other: () => t("page.unsent.attachment"),
} as const;

function duration(ms: number) {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function attachmentLabel(attachment: UnsentAttachment) {
  const kind = ATTACHMENT_LABELS[attachment.kind]();
  const name = attachment.name ?? (attachment.durationMs ? duration(attachment.durationMs) : null);
  return name ? t("page.unsent.attachment_named", { kind, name }) : kind;
}

/** The copy under the notice: a label saying Chatpane kept it, then the
 * message as it was. Text is set as React children, never as markup. */
function renderCopy(
  react: { createElement(type: unknown, props?: object | null, ...children: unknown[]): unknown },
  copy: UnsentCopy,
) {
  const h = react.createElement;
  return h(
    "div",
    { className: "chatpane-unsent-copy", role: "note", "data-chatpane-unsent-copy": "" },
    h("div", { className: "chatpane-unsent-label", ...language() }, t("page.unsent.kept")),
    copy.text ? h("div", { className: "chatpane-unsent-text", dir: "auto" }, copy.text) : null,
    ...copy.attachments.map((attachment, index) =>
      h(
        "div",
        { key: index, className: "chatpane-unsent-attachment", dir: "auto" },
        attachmentLabel(attachment),
      ),
    ),
  );
}

function reportError(error: unknown) {
  diag("unsent.capture", error instanceof Error ? error.name : "failed");
}

/** Wrap the Facebook modules that unsend messages and show the notice. */
export function interceptUnsentMessageModules(define: Define): Define {
  const hooks: CaptureHooks = { enabled, options: readOptions, keep, onError: reportError };
  const encrypted = encryptedChatHooks(hooks, pairs);
  const patches: Record<string, (exports: Record<string, unknown>) => boolean> = {
    MAWBridgeDeleteMessagesHandler: encrypted.patchDelete,
    MAWBridgeNewMsgHandler: encrypted.patchNew,
    MAWUpdateMsg: encrypted.patchUpdate,
  };
  return new Proxy(define, {
    apply(target, thisArg, args: unknown[]) {
      const name = args[0];
      const factory = args[2];
      if (typeof name === "string" && typeof factory === "function") {
        if (MESSAGE_PROCEDURES.has(name)) {
          // A procedure module's exports are the procedure itself.
          args[2] = wrapFactoryExports(factory as Factory, (module) => {
            if (typeof module.exports !== "function") return false;
            module.exports = wrapMessageProcedure(module.exports as Factory, hooks);
            return true;
          });
        } else if (patches[name]) {
          args[2] = wrapFactoryExports(factory as Factory, patches[name]);
        } else if (name === "MWV2ChatUnsentMessage.react") {
          args[2] = wrapUnsentNoticeFactory(factory as Factory, copies, {
            render: renderCopy,
            onError: (error) =>
              diag("unsent.render", error instanceof Error ? error.name : "render failed"),
          });
        }
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}

export function initUnsentMessages() {
  if (!window.__TAURI_INTERNALS__) return;
  account = accountId(document.cookie);
  if (!account) return;
  let wasEnabled = enabled();
  // Off and Delete All forget displayed copies and captures waiting for a pair.
  const forget = () => {
    generation++;
    copies.clear();
    pairs.clear();
  };
  window.addEventListener(CHANGED_EVENT, () => void (enabled() ? request() : forget()));
  window.addEventListener(RESET_EVENT, forget);
  window.addEventListener("chatpane:settings", () => {
    if (enabled() === wasEnabled) return;
    wasEnabled = enabled();
    if (wasEnabled) void request();
    else forget();
  });
  if (wasEnabled) void request();
}
