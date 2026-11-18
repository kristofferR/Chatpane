//! A message's quick reactions in its native menu on Linux: side by side in
//! one row of the GTK menu, the way Messages shows them on a Mac.

use gtk::prelude::*;
use muda::ContextMenu as _;

use crate::menu::ContextMenuRow;

/// Emoji are drawn this much larger than the menu's text.
const EMOJI_SCALE: f64 = 1.5;

/// A reaction is a check item, so that assistive technology can tell which
/// one is the user's own, but it draws no check mark: a highlight shows it
/// instead, unless the pointer is on it.
const REACTION_CSS: &[u8] = b"menuitem check { min-width: 0; min-height: 0; margin: 0; \
    padding: 0; border: none; background: none; box-shadow: none; -gtk-icon-source: none; } \
    menuitem.current-reaction:not(:hover) { background-color: alpha(currentColor, 0.16); \
    border-radius: 6px; }";

/// Append `reactions` to `menu` as one row of emoji. A GTK menu is a grid:
/// the items placed here share a row, and every other item spans its own.
pub(crate) fn append_reactions(
    menu: &muda::Menu,
    reactions: &[ContextMenuRow],
) -> muda::Result<()> {
    let gtk_menu = menu.gtk_context_menu();
    // Every item so far has a row to itself.
    let row = gtk_menu.children().len() as i32;
    let style = gtk::CssProvider::new();
    let _ = style.load_from_data(REACTION_CSS);
    for (column, reaction) in reactions.iter().enumerate() {
        menu.append(&muda::CheckMenuItem::with_id(
            &reaction.id,
            &reaction.text,
            true,
            reaction.checked,
            None,
        ))?;
        let Some(item) = gtk_menu.children().pop() else {
            continue;
        };
        let column = column as i32;
        for (side, cell) in [
            ("left-attach", column),
            ("right-attach", column + 1),
            ("top-attach", row),
            ("bottom-attach", row + 1),
        ] {
            gtk_menu.child_set_property(&item, side, &cell);
        }
        let label = item
            .downcast_ref::<gtk::Bin>()
            .and_then(|item| item.child())
            .and_then(|child| child.downcast::<gtk::Label>().ok());
        if let Some(label) = label {
            let attributes = gtk::pango::AttrList::new();
            attributes.insert(gtk::pango::AttrFloat::new_scale(EMOJI_SCALE));
            label.set_attributes(Some(&attributes));
            label.set_xalign(0.5);
        }
        let context = item.style_context();
        context.add_provider(&style, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        if reaction.checked {
            context.add_class("current-reaction");
        }
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
    menu.show_context_menu_for_gtk_window(window.gtk_window()?.as_ref(), position.map(Into::into));
    Ok(())
}
