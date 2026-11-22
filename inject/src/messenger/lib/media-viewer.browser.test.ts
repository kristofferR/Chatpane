import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// GitHub runners provide stable Chrome via CHROME_BIN alongside a Chromium
// snapshot. Prefer the configured browser over that development snapshot.
const chromium =
  (Bun.env.CHROME_BIN && Bun.which(Bun.env.CHROME_BIN)) ||
  Bun.which("google-chrome") ||
  Bun.which("chromium");

// Real DOM/CSS fixtures when Chromium is installed. Pure classification tests
// still run on hosts without a browser. No Messenger session or network needed.
test.skipIf(!chromium).each([480, 1000, 1600])(
  "media viewer DOM and CSS fixtures at %ipx",
  async (width) => {
    const directory = await mkdtemp(join(tmpdir(), "chatpane-viewer-test-"));
    try {
      const entry = fileURLToPath(new URL("../features/viewer-controls.ts", import.meta.url));
      const bundle = await build({
        stdin: {
          contents: `import { initTitleBar } from "../features/title-bar";
            import { initViewerControls } from ${JSON.stringify(entry)};
            initTitleBar(); initViewerControls();`,
          resolveDir: import.meta.dir,
        },
        bundle: true,
        write: false,
      });
      const css = await readFile(
        new URL("../../../../src-tauri/inject/messenger.css", import.meta.url),
        "utf8",
      );
      const html = `<!doctype html><html><head><style>${css}</style><style>
        html,body{margin:0;height:100%} .viewer{position:fixed;inset:0}
        .page{position:relative;height:100vh}
        .media{position:absolute;top:20%;left:20%;width:60%;height:60%}
        .actions{position:absolute;top:-16px;right:20px;display:flex}
        a,button{display:inline-block;width:40px;height:40px}
        [hidden],.off{display:none!important}
        </style></head><body><div role="banner" style="position:fixed;top:-16px;left:0"><button>Close</button></div>
        <main id="fixtures"></main><pre id="result">RUNNING</pre><script>
        // --virtual-time-budget advances timers, but not animation frames.
        window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 16);
        window.__CHATPANE_TITLE_BAR__ = ${JSON.stringify(titleBar(0))};
        // On a Mac the viewer is reported to the native side.
        window.chatpaneMediaViewer = () => undefined;
        ${bundle.outputFiles[0]!.text}
        const titleBar = ${titleBar.toString()};
        (${runFixtures.toString()})();</script></body></html>`;
      const file = join(directory, "index.html");
      await writeFile(file, html);
      const process = Bun.spawn(
        [
          chromium!,
          "--headless",
          "--disable-gpu",
          "--no-sandbox",
          "--no-first-run",
          `--user-data-dir=${join(directory, "profile")}`,
          `--window-size=${width},900`,
          "--virtual-time-budget=15000",
          "--dump-dom",
          pathToFileURL(file).href,
        ],
        { stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL" },
      );
      const [output, errors, exit] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      expect(exit, errors).toBe(0);
      expect(output.match(/<pre id="result">([^<]+)/)?.[1]).toBe("PASS");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

/** The strip's state as the native side sends it: none, or Windows' with its controls. */
function titleBar(inset: number) {
  return {
    inset,
    controls: inset ? ("windows" as const) : null,
    minimize: true,
    maximize: true,
    maximized: false,
  };
}

async function runFixtures() {
  const host = document.getElementById("fixtures")!;
  const result = document.getElementById("result")!;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  const marked = (element: Element) => element.hasAttribute("data-chatpane-media-viewer");
  const header = () =>
    getComputedStyle(document.documentElement).getPropertyValue("--header-height").trim();
  const assert = (name: string, condition: boolean) => {
    if (!condition) throw new Error(name);
  };
  const make = (extra = "", video = false) => {
    const dialog = document.createElement("div");
    dialog.className = "viewer";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", "Synthetic fixture");
    dialog.innerHTML = `${video ? '<video class="media" controls></video>' : '<img class="media">'}
      <div class="actions"><a download href="#">Save</a><button>Share</button></div>${extra}`;
    host.append(dialog);
    return dialog;
  };
  try {
    for (const [name, width, height] of [
      ["emoji", 0.4, 0.4],
      ["sticker", 0.5, 0.5],
      ["GIF", 0.6, 0.6],
      ["reaction", 0.5, 0.15],
      ["people", 0.5, 0.8],
      ["info", 0.3, 1],
    ] as const) {
      const dialog = make();
      dialog.style.cssText = `position:fixed;inset:auto;right:0;bottom:0;width:${innerWidth * width}px;height:${innerHeight * height}px`;
      await settle();
      assert(name, !marked(dialog) && header() === "0px");
      dialog.remove();
    }
    const main = make('<div role="navigation"></div>');
    const nested = make();
    main.append(nested);
    await settle();
    assert("viewer inside main Messenger dialog", marked(nested) && !marked(main));
    main.remove();
    for (const [name, width, height, accepted] of [
      ["tall screenshot", 0.02, 0.6, true],
      ["wide panorama", 0.6, 0.02, true],
      ["thumbnail", 0.1, 0.1, false],
    ] as const) {
      const viewer = make();
      const media = viewer.querySelector<HTMLElement>(".media")!;
      media.style.width = `${width * 100}%`;
      media.style.height = `${height * 100}%`;
      await settle();
      assert(name, marked(viewer) === accepted && header() === (accepted ? "56px" : "0px"));
      viewer.remove();
    }
    let dialog = make();
    await settle();
    assert("image viewer", marked(dialog) && header() === "56px");
    assert("safe control inset", dialog.querySelector("a")!.getBoundingClientRect().top >= 7.9);
    const picker = make();
    picker.style.cssText = "position:fixed;width:30vw;height:30vh;inset:auto;bottom:0;right:0";
    dialog.prepend(picker);
    await settle();
    assert(
      "nested picker",
      !marked(picker) && !picker.querySelector("[data-chatpane-media-actions]") && marked(dialog),
    );
    picker.remove();
    for (const [attribute, value] of [
      ["hidden", ""],
      ["aria-hidden", "true"],
      ["inert", ""],
      ["class", "viewer off"],
      ["role", "region"],
    ]) {
      dialog.setAttribute(attribute!, value!);
      await settle();
      assert(
        `hide via ${attribute}`,
        !marked(dialog) &&
          header() === "0px" &&
          !dialog.querySelector("[data-chatpane-media-actions]"),
      );
      dialog.removeAttribute(attribute!);
      dialog.className = "viewer";
      dialog.setAttribute("role", "dialog");
      await settle();
      assert(`restore after ${attribute}`, marked(dialog));
    }
    const old = dialog;
    old.remove();
    dialog = make("", true);
    dialog.querySelector("a")!.remove();
    await settle();
    assert(
      "replacement video with native controls",
      marked(dialog) && !marked(old) && !old.querySelector("[data-chatpane-media-actions]"),
    );
    dialog.remove();
    await settle();
    assert(
      "closed viewer",
      header() === "0px" &&
        getComputedStyle(document.querySelector('[role="banner"]')!).display === "none",
    );
    for (const extra of ['<div contenteditable="true"></div>', ""]) {
      dialog = make(extra);
      if (!extra) dialog.setAttribute("data-chatpane-shortcuts-overlay", "");
      await settle();
      assert("composer/Chatpane surface", !marked(dialog));
      dialog.remove();
    }
    const ancestor = document.createElement("section");
    host.append(ancestor);
    dialog = make();
    ancestor.append(dialog);
    ancestor.setAttribute("aria-hidden", "true");
    await settle();
    assert("hidden ancestor", !marked(dialog));
    ancestor.removeAttribute("aria-hidden");
    await settle();
    assert("visible ancestor", marked(dialog));
    ancestor.remove();
    for (const theme of ["__fb-light-mode", "__fb-dark-mode"]) {
      document.documentElement.className = theme;
      dialog = make();
      await settle();
      assert(theme, marked(dialog) && header() === "56px");
      dialog.remove();
      await settle();
    }
    // Encrypted chats: the viewer is a layer with no role, beside the surface
    // Messenger hides meanwhile. The layer stays, empty, once the viewer closes.
    const app = document.createElement("div");
    app.innerHTML =
      '<div style="position:fixed;inset:0"><div role="main" style="height:100%"></div></div><div></div>';
    host.append(app);
    const base = app.firstElementChild as HTMLElement;
    const layer = app.lastElementChild as HTMLElement;
    layer.innerHTML = `<div class="page"><img class="media"><div class="actions">
      <a download href="#">Save</a><button>Share</button><button>Close</button></div></div>`;
    await settle();
    assert("layer beside a visible surface", !marked(layer));
    base.setAttribute("aria-hidden", "true");
    await settle();
    assert("encrypted viewer layer", marked(layer) && header() === "0px");
    // Windows: Chatpane's own window controls have the top right corner.
    window.__chatpaneTitleBar!(titleBar(32));
    await settle();
    assert(
      "layer controls below the window controls",
      [...layer.querySelectorAll(".actions > *")].every(
        (control) => control.getBoundingClientRect().top >= 39.9,
      ),
    );
    window.__chatpaneTitleBar!(titleBar(0));
    // Forward opens as a dialog in the viewer's layer, which hides the viewer beside it.
    const forward = document.createElement("div");
    forward.setAttribute("role", "dialog");
    forward.style.cssText = "position:fixed;top:30%;left:30%;width:40%;height:40%";
    layer.firstElementChild!.setAttribute("aria-hidden", "true");
    layer.append(forward);
    await settle();
    assert("viewer under its own dialog", marked(layer) && !marked(forward));
    forward.remove();
    base.removeAttribute("aria-hidden");
    layer.replaceChildren();
    await settle();
    assert("closed viewer layer", !marked(layer));
    // Unencrypted chats: the viewer is a page of its own, a dialog in the flow
    // in place of the surface.
    base.hidden = true;
    dialog = make();
    dialog.style.cssText = "position:relative;inset:auto;height:100vh";
    await settle();
    assert("viewer page", marked(dialog) && header() === "56px");
    base.hidden = false;
    await settle();
    assert("dialog in the flow beside a visible surface", !marked(dialog));
    app.remove();
    dialog.remove();
    result.textContent = "PASS";
  } catch (error) {
    result.textContent = String(error);
  }
}
