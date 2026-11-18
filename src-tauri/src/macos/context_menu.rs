//! A message's quick reactions in its native menu on macOS: a palette, the
//! row of emoji Messages puts at the top of a message's menu.

use block2::RcBlock;
use muda::ContextMenu as _;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObjectProtocol as _};
use objc2::sel;
use objc2_app_kit::{
    NSFont, NSFontAttributeName, NSImage, NSMenu, NSMenuPresentationStyle, NSStringDrawing as _,
};
use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSString};

use crate::i18n::t;
use crate::menu::{ContextMenuRow, menu_label};

/// AppKit scales a palette's images to its own item size, so this only has to
/// be large enough to stay sharp.
const EMOJI_FONT_SIZE: f64 = 20.0;

/// Append `reactions` to `menu` as one row of emoji. Main thread only.
pub(crate) fn append_reactions(
    menu: &muda::Menu,
    reactions: &[ContextMenuRow],
) -> muda::Result<()> {
    let submenu = muda::Submenu::new(menu_label(t("shared.context.react")), true);
    for reaction in reactions {
        submenu.append(&muda::CheckMenuItem::with_id(
            &reaction.id,
            &reaction.text,
            true,
            reaction.checked,
            None,
        ))?;
    }
    menu.append(&submenu)?;
    // SAFETY: muda keeps this NSMenu alive as long as `menu`, and menus are
    // only built on the main thread.
    let ns_menu = unsafe { &*menu.ns_menu().cast::<NSMenu>() };
    // The submenu just appended is the menu's last item.
    if let Some(reactions) = ns_menu
        .itemAtIndex(ns_menu.numberOfItems() - 1)
        .and_then(|item| item.submenu())
    {
        show_as_palette(&reactions);
    }
    Ok(())
}

/// Pop `menu` up at `position` in the window, or at the pointer. Returns when
/// the menu closes.
pub(crate) fn popup(
    window: &tauri::WebviewWindow,
    menu: &muda::Menu,
    position: Option<tauri::LogicalPosition<f64>>,
) -> tauri::Result<()> {
    let view = window.ns_view()?;
    // SAFETY: the window's own content view, on the main thread.
    unsafe { menu.show_context_menu_for_nsview(view.cast(), position.map(Into::into)) };
    Ok(())
}

/// Show a submenu's rows side by side inside the menu that holds it, each as
/// its emoji; a checked row is highlighted. A palette draws images, never
/// titles. It needs macOS 14: earlier systems keep the submenu.
fn show_as_palette(reactions: &NSMenu) {
    if !reactions.respondsToSelector(sel!(setPresentationStyle:)) {
        return;
    }
    reactions.setPresentationStyle(NSMenuPresentationStyle::Palette);
    for index in 0..reactions.numberOfItems() {
        if let Some(item) = reactions.itemAtIndex(index) {
            item.setImage(Some(&emoji_image(item.title())));
        }
    }
}

fn emoji_image(emoji: Retained<NSString>) -> Retained<NSImage> {
    let font = NSFont::systemFontOfSize(EMOJI_FONT_SIZE);
    let font: &AnyObject = &font;
    // SAFETY: an AppKit constant.
    let attributes = NSDictionary::from_slices(&[unsafe { NSFontAttributeName }], &[font]);
    // SAFETY: the attributes hold a font under the font key.
    let size = unsafe { emoji.sizeWithAttributes(Some(&attributes)) };
    // AppKit calls this whenever it draws the image, on the drawing thread.
    let draw = RcBlock::new(move |_: NSRect| {
        // SAFETY: as above.
        unsafe { emoji.drawAtPoint_withAttributes(NSPoint::ZERO, Some(&attributes)) };
        Bool::YES
    });
    NSImage::imageWithSize_flipped_drawingHandler(size, false, &draw)
}
