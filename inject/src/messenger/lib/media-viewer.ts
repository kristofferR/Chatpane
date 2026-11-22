import { type ImageRect, intersectImageClips } from "./emoji-images";

export const MEDIA_VIEWER_ATTR = "data-chatpane-media-viewer";
const DIALOG = '[role="dialog"]';
/** Messenger's own surface: the chat beside the chat list. */
export const SURFACE = '[role="main"]';
const HIDDEN = '[hidden], [aria-hidden="true"], [inert]';

export interface MediaViewerShape {
  rect: ImageRect;
  viewport: ImageRect;
  /** Over Messenger's surface, or shown in its place. */
  overlay: boolean;
  excluded: boolean;
  hasMedia: boolean;
  hasDownload: boolean;
  hasVideoControls: boolean;
}

/** A labelled dialog alone is also an emoji picker, people list, or chat. */
export function isMediaViewerShape(shape: MediaViewerShape): boolean {
  if (shape.excluded || !shape.overlay || !shape.hasMedia) return false;
  if (!shape.hasDownload && !shape.hasVideoControls) return false;
  return coversViewport(shape.rect, shape.viewport);
}

function coversViewport(rect: ImageRect, viewport: ImageRect): boolean {
  const visible = intersectImageClips(rect, viewport);
  const width = viewport.right - viewport.left;
  const height = viewport.bottom - viewport.top;
  return (
    width > 0 &&
    height > 0 &&
    visible.right - visible.left >= width * 0.75 &&
    visible.bottom - visible.top >= height * 0.7
  );
}

function isRendered(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return getComputedStyle(element).visibility === "visible" && rect.width > 0 && rect.height > 0;
}

function isVisible(element: Element): boolean {
  return !element.closest(HIDDEN) && isRendered(element);
}

/**
 * Where a media viewer can be. Messenger shows one as a dialog, or (encrypted
 * chats) as a layer with no role of its own, beside its surface, which it
 * hides meanwhile. The layer stays in the page, empty, once the viewer closes.
 */
export function mediaViewerCandidates(surface: Element | null): Set<HTMLElement> {
  const candidates = new Set(document.querySelectorAll<HTMLElement>(DIALOG));
  const hidden = surface?.closest(HIDDEN);
  for (const layer of hidden?.parentElement?.children ?? []) {
    if (layer !== hidden && layer instanceof HTMLElement) candidates.add(layer);
  }
  return candidates;
}

/** Whether a candidate holds this element itself, not through a dialog inside it. */
export function ownsViewerElement(viewer: HTMLElement, element: Element): boolean {
  return (element.closest(DIALOG) ?? viewer) === viewer;
}

export function isMediaViewer(candidate: HTMLElement, surface: Element | null): boolean {
  if (!isVisible(candidate)) return false;
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const rect = candidate.getBoundingClientRect();
  if (!coversViewport(rect, viewport)) return false;
  // In place of the surface: hidden, or never there on a viewer page of its own.
  let overlay = !(surface && isVisible(surface)) || candidate.getAttribute("aria-modal") === "true";
  let excluded = !!candidate.closest("[data-chatpane-shortcuts-overlay]");
  for (let ancestor: HTMLElement | null = candidate; ancestor; ancestor = ancestor.parentElement) {
    const position = getComputedStyle(ancestor).position;
    if (position === "fixed" || position === "absolute") overlay = true;
  }
  const owns = (element: Element) => ownsViewerElement(candidate, element);
  // What the candidate shows counts while it is rendered: the encrypted viewer
  // hides its photo from assistive technology, and all of itself while a
  // dialog of its own (Forward) is open in its layer.
  const shows = (element: Element) => owns(element) && isRendered(element);
  // The main Messenger surface contains media and download links too.
  excluded ||= [
    ...candidate.querySelectorAll('[role="navigation"], [contenteditable="true"]'),
  ].some(owns);
  if (excluded || !overlay) return false;
  const media = [
    ...candidate.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video"),
  ].filter((element) => {
    if (!shows(element)) return false;
    const bounds = element.getBoundingClientRect();
    const visible = intersectImageClips(intersectImageClips(bounds, rect), viewport);
    const width = (visible.right - visible.left) / Math.min(rect.width, viewport.right);
    const height = (visible.bottom - visible.top) / Math.min(rect.height, viewport.bottom);
    // Ignore avatars, emoji, and gallery thumbnails, but accept panoramas and
    // tall screenshots that span the viewer on only one axis.
    return (
      width > 0 &&
      height > 0 &&
      ((width >= 0.15 && height >= 0.15) || width >= 0.5 || height >= 0.5)
    );
  });
  return isMediaViewerShape({
    rect,
    viewport,
    overlay,
    excluded,
    hasMedia: media.length > 0,
    hasDownload: [...candidate.querySelectorAll("a[download]")].some(shows),
    hasVideoControls: media.some(
      (element) => element instanceof HTMLVideoElement && element.controls,
    ),
  });
}
