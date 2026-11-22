import {
  isMediaViewer,
  MEDIA_VIEWER_ATTR,
  mediaViewerCandidates,
  ownsViewerElement,
  SURFACE,
} from "../lib/media-viewer";
import { viewerControlOffset } from "../lib/viewer-controls";
import { reportMediaViewer, windowControlsInset } from "./title-bar";

const DIALOG = '[role="dialog"]';
const BANNER = 'div[role="banner"]';
const CONTROL = 'a[href], button, [role="button"]';
const BANNER_ATTR = "data-chatpane-media-controls";
const ACTIONS_ATTR = "data-chatpane-media-actions";
const OFFSET = "--chatpane-media-controls-offset";

const visibleControls = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(CONTROL)]
    .map((control) => control.getBoundingClientRect())
    .filter(
      (rect) =>
        rect.width >= 16 &&
        rect.height >= 16 &&
        rect.bottom > 0 &&
        // Controls sit near the top; Chatpane's strip (and the offset clearing
        // it) can move them further down, so the band grows with it.
        rect.top < 96 + windowControlsInset() &&
        rect.right > 0 &&
        rect.left < window.innerWidth,
    );

const applyOffset = (element: HTMLElement, controlTops: number[], attr: string) => {
  const currentOffset = Number.parseFloat(element.style.getPropertyValue(OFFSET)) || 0;
  const offset = viewerControlOffset(controlTops, currentOffset, windowControlsInset());
  if (!offset) return false;
  if (!element.hasAttribute(attr)) element.setAttribute(attr, "");
  const value = `${offset}px`;
  if (element.style.getPropertyValue(OFFSET) !== value) {
    element.style.setProperty(OFFSET, value);
  }
  return true;
};

const actionGroupFor = (download: HTMLElement, viewer: HTMLElement) => {
  let candidate: HTMLElement = download;
  for (
    let parent = download.parentElement;
    parent && parent !== viewer;
    parent = parent.parentElement
  ) {
    const rect = parent.getBoundingClientRect();
    const controls = visibleControls(parent);
    if (controls.length >= 2 && rect.width <= 240 && rect.height <= 96) return parent;
    if (rect.width <= 240 && rect.height <= 96) candidate = parent;
  }
  return candidate;
};

export function initViewerControls() {
  let frame = 0;
  let viewers = new Set<HTMLElement>();
  let markedControls = new Set<HTMLElement>();
  let candidates = new Set<HTMLElement>();
  let surface: Element | null = null;

  const refresh = () => {
    frame = 0;
    surface = document.querySelector(SURFACE);
    const nextCandidates = mediaViewerCandidates(surface);
    for (const candidate of candidates) {
      if (!nextCandidates.has(candidate)) resizeObserver.unobserve(candidate);
    }
    for (const candidate of nextCandidates) {
      if (!candidates.has(candidate)) resizeObserver.observe(candidate);
    }
    candidates = nextCandidates;
    const nextViewers = new Set(
      [...candidates].filter((candidate) => isMediaViewer(candidate, surface)),
    );
    for (const viewer of viewers) {
      if (!nextViewers.has(viewer)) viewer.removeAttribute(MEDIA_VIEWER_ATTR);
    }
    for (const viewer of nextViewers) {
      if (!viewer.hasAttribute(MEDIA_VIEWER_ATTR)) viewer.setAttribute(MEDIA_VIEWER_ATTR, "");
    }
    viewers = nextViewers;
    reportMediaViewer(viewers.size > 0);
    const previouslyMarked = markedControls;
    markedControls = new Set();

    if (viewers.size) {
      for (const banner of document.querySelectorAll<HTMLElement>(BANNER)) {
        if (
          applyOffset(
            banner,
            visibleControls(banner).map((rect) => rect.top),
            BANNER_ATTR,
          )
        ) {
          markedControls.add(banner);
        }
      }

      // Facebook renders Download and Share (and, in an encrypted chat, Close)
      // in a compact action group inside the viewer rather than in the banner.
      // Find that group structurally from the locale-independent `download`
      // attribute and move it as one unit, preserving spacing and hover
      // transforms on its controls.
      for (const viewer of viewers) {
        for (const download of viewer.querySelectorAll<HTMLElement>("a[download]")) {
          if (!ownsViewerElement(viewer, download)) continue;
          const group = actionGroupFor(download, viewer);
          if (
            applyOffset(
              group,
              visibleControls(group).map((rect) => rect.top),
              ACTIONS_ATTR,
            )
          ) {
            markedControls.add(group);
          }
        }
      }
    }

    for (const element of previouslyMarked) {
      if (markedControls.has(element)) continue;
      element.removeAttribute(BANNER_ATTR);
      element.removeAttribute(ACTIONS_ATTR);
      element.style.removeProperty(OFFSET);
    }
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(refresh);
  };

  const resizeObserver = new ResizeObserver(schedule);
  // A surface, inside a dialog, banner or viewer layer, or around something
  // tracked. The surface counts as tracked: hiding it, or adding a layer beside
  // it, is how a viewer that is no dialog arrives and leaves.
  const affectsControls = (element: Element) =>
    element.matches(SURFACE) ||
    !!element.closest(`${DIALOG}, ${BANNER}`) ||
    [...candidates].some((candidate) => candidate.contains(element)) ||
    [...candidates, ...markedControls, surface].some((tracked) => element.contains(tracked));

  // Chat updates inside the surface cannot change a viewer's controls. Inspect
  // changed subtrees for new dialogs or a new surface, and retain tracked nodes
  // to catch removal or role loss.
  new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          (record.target instanceof Element && affectsControls(record.target)) ||
          (record.type === "childList" &&
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element &&
                (affectsControls(node) || node.querySelector(`${DIALOG}, ${BANNER}, ${SURFACE}`)),
            )),
      )
    )
      schedule();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "hidden",
      "aria-hidden",
      "inert",
      "role",
      "aria-modal",
      "class",
      "style",
      "download",
      "controls",
    ],
  });
  const mediaLoaded = (event: Event) => {
    if (event.target instanceof Element && affectsControls(event.target)) schedule();
  };
  document.addEventListener("load", mediaLoaded, true);
  document.addEventListener("loadedmetadata", mediaLoaded, true);
  window.addEventListener("resize", schedule, { passive: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) schedule();
  });
  schedule();
}
