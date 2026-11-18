//! The app icon on the Windows taskbar (Settings → Appearance → App icon).
//!
//! The taskbar doesn't draw a window's own icon. It draws the icon of the
//! shortcut that carries the window's AppUserModelID (the taskbar pin, or the
//! Start menu entry), and only falls back to the window's big icon when no
//! shortcut does, as with the portable build. So:
//!
//! - the process takes the ID the installer stamps on Chatpane's shortcuts,
//!   however it was started, unless a taskbar pin says otherwise
//!   (`set_app_id`);
//! - the chosen icon is written into the shortcuts that start this
//!   executable, on the Desktop, in the Start menu and on the taskbar. A
//!   shortcut someone gave another icon keeps it;
//! - the taskbar is made to read them again, and each window gets the big
//!   icon.
//!
//! The taskbar reads a shortcut's icon only at certain moments, found by
//! trial on Windows 11 25H2 (`refresh_pins`, `refresh_taskbar_buttons`).
//! These made no difference there: `SHCNE_ASSOCCHANGED`, the window's
//! `RelaunchIconResource`, `ITaskbarList::DeleteTab` and `AddTab`, and
//! shorter waits. If the taskbar misses a change, the shortcuts are still
//! right: it shows the icon the next time Chatpane starts, or for a pin at
//! the next sign-in.
//!
//! An update recreates the installer's shortcuts with the installed icon, and
//! the next start writes the chosen one back.

/// The icons Settings offers besides the installed one, as .ico files.
#[cfg(target_os = "windows")]
const ICONS: [(&str, &[u8]); 3] = [
    (
        "color-dark",
        include_bytes!("../../icons/app-icon/color-dark.ico"),
    ),
    (
        "mono-light",
        include_bytes!("../../icons/app-icon/mono-light.ico"),
    ),
    (
        "mono-dark",
        include_bytes!("../../icons/app-icon/mono-dark.ico"),
    ),
];

/// `System.AppUserModel.ID`: `{9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}`, pid 5.
#[cfg(target_os = "windows")]
const PKEY_APP_ID: windows::Win32::Foundation::PROPERTYKEY =
    windows::Win32::Foundation::PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };

/// Give the process the AppUserModelID its taskbar buttons group by. Call
/// before the first window exists.
///
/// That is the ID the installer stamps on Chatpane's shortcuts, so a start
/// from the login entry, a link or the executable itself belongs to them
/// too. A taskbar pin decides otherwise, because a window with another ID
/// than its pin gets a second button: a pin from before the rename still
/// carries Carrier's ID, and one made without the installer's shortcuts (the
/// portable build) carries none, which only matches a process without an ID
/// of its own.
#[cfg(target_os = "windows")]
pub(crate) fn set_app_id(app: &tauri::AppHandle) {
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    // SAFETY: inside `with_com`.
    let id = match with_com(|| unsafe { pinned_app_id(app) }) {
        Some(None) => return,
        Some(Some(id)) => id,
        // Not the running identifier: that is Carrier's while its data
        // couldn't be moved, and the installer stamps Chatpane's.
        None => crate::identity::IDENTIFIER.to_owned(),
    };
    let id = windows::core::HSTRING::from(id);
    // SAFETY: a NUL-terminated string that outlives the call.
    if let Err(error) = unsafe { SetCurrentProcessExplicitAppUserModelID(&id) } {
        log::warn!("could not set the AppUserModelID: {error}");
    }
}

/// The AppUserModelID of Chatpane's taskbar pin: None when it isn't pinned,
/// `Some(None)` for a pin without an ID. Needs COM on this thread.
#[cfg(target_os = "windows")]
unsafe fn pinned_app_id(app: &tauri::AppHandle) -> Option<Option<String>> {
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::core::Interface;

    let exe = std::env::current_exe().ok()?;
    let exe = exe.to_string_lossy();
    shortcut_folders(app)
        .into_iter()
        .filter(|(_, pins)| *pins)
        .flat_map(|(folder, _)| shortcuts_in(&folder))
        .find_map(|pin| {
            // SAFETY: the caller initialized COM on this thread.
            let (link, target) = unsafe { open_shortcut(&pin) }.ok()?;
            if !same_path(&target, &exe) {
                return None;
            }
            // SAFETY: as above.
            let id = unsafe { link.cast::<IPropertyStore>().ok()?.GetValue(&PKEY_APP_ID) }.ok()?;
            Some(Some(id.to_string()).filter(|id| !id.is_empty()))
        })
}

/// Run `work` with COM set up on this thread.
#[cfg(target_os = "windows")]
fn with_com<T>(work: impl FnOnce() -> T) -> T {
    use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize};

    // SAFETY: the standard COM lifecycle. A thread that already has COM
    // keeps it, and every successful call is paired with its uninitialize.
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let result = work();
        if initialized {
            CoUninitialize();
        }
        result
    }
}

/// Where an icon's .ico file goes. Shortcuts point at it, so it stays put.
#[cfg(target_os = "windows")]
fn icon_path(app: &tauri::AppHandle, icon: &str) -> Option<std::path::PathBuf> {
    use tauri::Manager;

    app.path()
        .app_local_data_dir()
        .inspect_err(|error| log::warn!("no folder for the app icon files: {error}"))
        .ok()
        .map(|directory| directory.join(format!("app-icon-{icon}.ico")))
}

/// The .ico file for an icon Settings offers, written if it's missing or an
/// update changed it. `Ok(None)` is the installed icon, which needs no file.
#[cfg(target_os = "windows")]
fn icon_file(app: &tauri::AppHandle, icon: &str) -> Result<Option<std::path::PathBuf>, ()> {
    let Some((name, ico)) = ICONS.iter().find(|(name, _)| *name == icon) else {
        return Ok(None);
    };
    let path = icon_path(app, name).ok_or(())?;
    if !matches!(std::fs::read(&path), Ok(existing) if existing == *ico) {
        let written = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(&path, ico));
        if let Err(error) = written {
            log::warn!("could not write {}: {error}", path.display());
            return Err(());
        }
    }
    Ok(Some(path))
}

/// Show the chosen icon on the taskbar, the Start menu and the Desktop.
#[cfg(target_os = "windows")]
pub(crate) fn show(app: &tauri::AppHandle, icon: &str) {
    use std::sync::Mutex;

    // What was last asked for. Most settings changes don't touch the icon,
    // and looking through the shortcuts is only worth it when it changed.
    static SHOWN: Mutex<Option<String>> = Mutex::new(None);
    static WORK: Mutex<()> = Mutex::new(());

    if SHOWN.lock().unwrap().as_deref() == Some(icon) {
        return;
    }
    // Before the icon counts as shown, so a failed write is tried again.
    let Ok(file) = icon_file(app, icon) else {
        return;
    };
    *SHOWN.lock().unwrap() = Some(icon.to_owned());
    let (app, icon) = (app.clone(), icon.to_owned());
    let spawned = std::thread::Builder::new()
        .name("chatpane-shortcut-icons".into())
        .spawn(move || {
            let _serialized = WORK.lock().unwrap_or_else(|e| e.into_inner());
            // A newer choice is waiting its turn; it writes the shortcuts.
            if SHOWN.lock().unwrap().as_deref() != Some(icon.as_str()) {
                return;
            }
            with_com(|| {
                // SAFETY: inside `with_com`.
                let shortcuts = unsafe { update_shortcuts(&app, file.as_deref()) };
                // A pin stands for Chatpane's windows on the taskbar, and
                // only the pin's own icon shows there.
                if shortcuts.pinned {
                    refresh_pins(&shortcuts.changed_pins);
                } else if shortcuts.changed {
                    // SAFETY: inside `with_com`.
                    unsafe { refresh_taskbar_buttons(&app) };
                }
            });
        });
    if let Err(error) = spawned {
        log::warn!("failed to start the shortcut icon worker: {error}");
        // Not shown after all: the next call tries again.
        SHOWN.lock().unwrap().take();
    }
}

/// The folders Chatpane's shortcuts live in, and whether they hold taskbar
/// pins: the Desktop, the Start menu and the pins (ones made without a
/// Desktop shortcut sit in subfolders of ImplicitAppShortcuts).
#[cfg(target_os = "windows")]
fn shortcut_folders(app: &tauri::AppHandle) -> Vec<(std::path::PathBuf, bool)> {
    use tauri::Manager;

    let mut folders = Vec::new();
    folders.extend(
        app.path()
            .desktop_dir()
            .ok()
            .map(|desktop| (desktop, false)),
    );
    if let Ok(roaming) = app.path().data_dir() {
        folders.push((
            roaming.join(r"Microsoft\Windows\Start Menu\Programs"),
            false,
        ));
        let pinned = roaming.join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned");
        folders.push((pinned.join("TaskBar"), true));
        if let Ok(implicit) = std::fs::read_dir(pinned.join("ImplicitAppShortcuts")) {
            folders.extend(implicit.flatten().map(|entry| (entry.path(), true)));
        }
    }
    folders
}

/// The shortcut files in a folder.
#[cfg(target_os = "windows")]
fn shortcuts_in(folder: &std::path::Path) -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"))
        })
        .collect()
}

/// Open a shortcut file, and say what it starts. Needs COM on this thread.
#[cfg(target_os = "windows")]
unsafe fn open_shortcut(
    shortcut: &std::path::Path,
) -> windows::core::Result<(windows::Win32::UI::Shell::IShellLinkW, String)> {
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, CoCreateInstance, IPersistFile, STGM_READWRITE,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    use windows::core::{HSTRING, Interface};

    // SAFETY: plain shell COM on the caller's COM-initialized thread, with a
    // buffer that outlives the call.
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.cast::<IPersistFile>()?
            .Load(&HSTRING::from(shortcut), STGM_READWRITE)?;
        let mut target = [0u16; 1024];
        link.GetPath(&mut target, std::ptr::null_mut(), 0)?;
        Ok((link, wide_text(&target)))
    }
}

/// The text in a NUL-terminated UTF-16 buffer.
#[cfg(target_os = "windows")]
fn wide_text(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|&unit| unit == 0);
    String::from_utf16_lossy(&buffer[..end.unwrap_or(buffer.len())])
}

/// What [`update_shortcuts`] found and did.
#[cfg(target_os = "windows")]
#[derive(Default)]
struct Shortcuts {
    /// A shortcut got another icon.
    changed: bool,
    /// Chatpane is pinned to the taskbar.
    pinned: bool,
    /// The pins that got another icon.
    changed_pins: Vec<std::path::PathBuf>,
}

/// Point Chatpane's shortcuts at `icon`, or at the executable's own icon for
/// None. Needs COM on this thread.
#[cfg(target_os = "windows")]
unsafe fn update_shortcuts(app: &tauri::AppHandle, icon: Option<&std::path::Path>) -> Shortcuts {
    let mut found = Shortcuts::default();
    let Ok(exe) = std::env::current_exe() else {
        return found;
    };
    let exe = exe.to_string_lossy();
    let wanted = icon.map(|icon| icon.to_string_lossy());
    let ours: Vec<String> = ICONS
        .iter()
        .filter_map(|(name, _)| icon_path(app, name))
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    for (folder, pins) in shortcut_folders(app) {
        for shortcut in shortcuts_in(&folder) {
            // SAFETY: the caller initialized COM on this thread.
            match unsafe { update_shortcut(&shortcut, &exe, wanted.as_deref(), &ours) } {
                // Starts something else.
                Ok(None) => {}
                Ok(Some(changed)) => {
                    found.changed |= changed;
                    found.pinned |= pins;
                    if changed && pins {
                        found.changed_pins.push(shortcut);
                    }
                }
                // Locked or unreadable: leave it.
                Err(error) => log::debug!("skipped {}: {error}", shortcut.display()),
            }
        }
    }
    found
}

/// None for a shortcut that doesn't start this executable, otherwise whether
/// its icon was changed.
#[cfg(target_os = "windows")]
unsafe fn update_shortcut(
    shortcut: &std::path::Path,
    exe: &str,
    wanted: Option<&str>,
    ours: &[String],
) -> windows::core::Result<Option<bool>> {
    use windows::Win32::System::Com::IPersistFile;
    use windows::Win32::UI::Shell::SHCNE_UPDATEITEM;
    use windows::core::{HSTRING, Interface};

    // SAFETY: plain shell COM on the caller's COM-initialized thread, with a
    // buffer that outlives the call.
    unsafe {
        let (link, target) = open_shortcut(shortcut)?;
        if !same_path(&target, exe) {
            return Ok(None);
        }
        let mut current = [0u16; 1024];
        let mut index = 0;
        link.GetIconLocation(&mut current, &mut index)?;
        let Some(location) = new_icon_location(&wide_text(&current), exe, wanted, ours) else {
            return Ok(Some(false));
        };
        link.SetIconLocation(&HSTRING::from(location), 0)?;
        link.cast::<IPersistFile>()?
            .Save(&HSTRING::from(shortcut), true)?;
        // Explorer redraws the shortcut where it shows it.
        notify(SHCNE_UPDATEITEM, shortcut);
        Ok(Some(true))
    }
}

/// Tell Explorer about a shortcut, and return once it has the message.
#[cfg(target_os = "windows")]
fn notify(event: windows::Win32::UI::Shell::SHCNE_ID, shortcut: &std::path::Path) {
    use windows::Win32::UI::Shell::{SHCNF_FLUSH, SHCNF_PATHW, SHChangeNotify};

    let path = windows::core::HSTRING::from(shortcut);
    let path = Some(path.as_ptr().cast());
    // SAFETY: a NUL-terminated path that outlives the call. The second path
    // is only read for a rename.
    unsafe { SHChangeNotify(event, SHCNF_PATHW | SHCNF_FLUSH, path, path) };
}

#[cfg(any(target_os = "windows", test))]
fn same_path(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// The icon location one of Chatpane's shortcuts should get, or None to
/// leave it alone.
///
/// A shortcut follows the choice only while its icon is still one of
/// Chatpane's: one someone picked by hand stays. The installer's shortcuts
/// have no icon location, which shows the executable's icon. Going back to
/// that one names the executable, because Explorer is slow to notice a
/// shortcut losing its icon location.
#[cfg(any(target_os = "windows", test))]
fn new_icon_location<'a>(
    current: &str,
    exe: &'a str,
    wanted: Option<&'a str>,
    ours: &[String],
) -> Option<&'a str> {
    let installed = current.is_empty() || same_path(current, exe);
    if !installed && !ours.iter().any(|icon| same_path(current, icon)) {
        return None;
    }
    match wanted {
        Some(wanted) if same_path(current, wanted) => None,
        None if installed => None,
        wanted => Some(wanted.unwrap_or(exe)),
    }
}

/// Make the taskbar draw Chatpane's pins with their new icon. A pin keeps
/// the icon it has through a rewrite of its shortcut. It reads the shortcut
/// again when it hears the shortcut was renamed (to the name it has) and
/// then, a moment later, changed.
#[cfg(target_os = "windows")]
fn refresh_pins(pins: &[std::path::PathBuf]) {
    use windows::Win32::UI::Shell::{SHCNE_RENAMEITEM, SHCNE_UPDATEITEM};

    if pins.is_empty() {
        return;
    }
    for pin in pins {
        notify(SHCNE_RENAMEITEM, pin);
    }
    std::thread::sleep(std::time::Duration::from_secs(2));
    for pin in pins {
        let touched = std::fs::File::options()
            .write(true)
            .open(pin)
            .and_then(|file| file.set_modified(std::time::SystemTime::now()));
        match touched {
            Ok(()) => notify(SHCNE_UPDATEITEM, pin),
            Err(error) => log::warn!("could not refresh {}: {error}", pin.display()),
        }
    }
}

/// Make the taskbar draw the windows' buttons with the Start menu shortcut's
/// new icon. It reads that icon when a group of buttons forms, so the windows
/// leave their group and come back. Until they are back they show their own
/// big icon, which is the chosen one. Needs COM on this thread, and blocks
/// while the windows are away.
#[cfg(target_os = "windows")]
unsafe fn refresh_taskbar_buttons(app: &tauri::AppHandle) {
    use tauri::Manager;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::UI::Shell::PropertiesSystem::{
        IPropertyStore, SHGetPropertyStoreForWindow,
    };

    // Only run without a pin, so the process has the installer's ID.
    let id = crate::identity::IDENTIFIER;
    // SAFETY: shell COM on the caller's COM-initialized thread. A window
    // closed meanwhile just fails its calls.
    unsafe {
        let stores: Vec<IPropertyStore> = app
            .webview_windows()
            .values()
            .filter_map(|window| window.hwnd().ok())
            .filter_map(|hwnd| SHGetPropertyStoreForWindow(HWND(hwnd.0)).ok())
            .collect();
        let away = PROPVARIANT::from(format!("{id}.refresh").as_str());
        for store in &stores {
            let _ = store.SetValue(&PKEY_APP_ID, &away);
        }
        // Explorer takes a few seconds to take in the rewritten shortcut:
        // one in 25 was still not in after 3. Back sooner, the group forms
        // again with the icon it had.
        std::thread::sleep(std::time::Duration::from_secs(5));
        let back = PROPVARIANT::from(id);
        for store in &stores {
            if let Err(error) = store.SetValue(&PKEY_APP_ID, &back) {
                log::warn!("a window could not rejoin its taskbar group: {error}");
            }
        }
    }
}

/// Give a window the chosen icon as its big icon, which the taskbar draws
/// when no shortcut stands for the window. The installed icon clears it, so
/// the executable's own shows.
#[cfg(target_os = "windows")]
pub(crate) fn set_big_icon(window: &tauri::WebviewWindow, icon: &str) {
    use tauri::Manager;
    use windows_sys::Win32::UI::WindowsAndMessaging::{ICON_BIG, SendMessageW, WM_SETICON};

    let Ok(file) = icon_file(window.app_handle(), icon) else {
        return;
    };
    // The main thread owns the window, and a caller may hold the settings
    // lock, so don't block on SendMessage from here.
    let target = window.clone();
    let queued = window.run_on_main_thread(move || {
        let Ok(hwnd) = target.hwnd() else {
            return;
        };
        let icon = match &file {
            None => std::ptr::null_mut(),
            Some(file) => match load_big_icon(hwnd.0, file) {
                Some(icon) => icon,
                None => return,
            },
        };
        // SAFETY: on the thread that owns the window. The icon is kept for
        // the life of the process, and a null one clears the big icon.
        unsafe { SendMessageW(hwnd.0, WM_SETICON, ICON_BIG as usize, icon as isize) };
    });
    if let Err(error) = queued {
        log::warn!("could not set the big icon of {}: {error}", window.label());
    }
}

/// An .ico file's frame for the big icon size on the window's display.
/// Main thread only (see [`set_big_icon`]).
#[cfg(target_os = "windows")]
fn load_big_icon(
    hwnd: windows_sys::Win32::Foundation::HWND,
    file: &std::path::Path,
) -> Option<windows_sys::Win32::UI::WindowsAndMessaging::HICON> {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        HICON, IMAGE_ICON, LR_LOADFROMFILE, LoadImageW, SM_CXICON,
    };

    thread_local! {
        // By file and size. Windows share them, and there are only a few, so
        // they are never destroyed.
        static LOADED: RefCell<HashMap<(std::path::PathBuf, i32), HICON>> = RefCell::default();
    }

    // SAFETY: plain queries; a stale handle just reads as 0 DPI.
    let size = unsafe {
        let dpi = match GetDpiForWindow(hwnd) {
            0 => 96,
            dpi => dpi,
        };
        GetSystemMetricsForDpi(SM_CXICON, dpi)
    };
    let key = (file.to_path_buf(), size);
    if let Some(icon) = LOADED.with_borrow(|loaded| loaded.get(&key).copied()) {
        return Some(icon);
    }
    let path: Vec<u16> = file.as_os_str().encode_wide().chain([0]).collect();
    // SAFETY: a NUL-terminated path that outlives the call.
    let icon = unsafe {
        LoadImageW(
            std::ptr::null_mut(),
            path.as_ptr(),
            IMAGE_ICON,
            size,
            size,
            LR_LOADFROMFILE,
        )
    };
    if icon.is_null() {
        log::warn!("could not load {}", file.display());
        return None;
    }
    LOADED.with_borrow_mut(|loaded| loaded.insert(key, icon));
    Some(icon)
}

#[cfg(test)]
mod tests {
    use super::new_icon_location;

    const EXE: &str = r"C:\Users\me\AppData\Local\Chatpane\chatpane.exe";
    const DARK: &str = r"C:\Users\me\AppData\Local\app.chatpane.Chatpane\app-icon-color-dark.ico";
    const MONO: &str = r"C:\Users\me\AppData\Local\app.chatpane.Chatpane\app-icon-mono-light.ico";

    fn location<'a>(current: &str, wanted: Option<&'a str>) -> Option<&'a str> {
        new_icon_location(current, EXE, wanted, &[DARK.into(), MONO.into()])
    }

    #[test]
    fn chatpanes_shortcuts_follow_the_chosen_icon() {
        // From the installed icon, in either way a shortcut can say it.
        assert_eq!(location("", Some(DARK)), Some(DARK));
        assert_eq!(location(&EXE.to_uppercase(), Some(DARK)), Some(DARK));
        // Between chosen icons, and back to the installed one.
        assert_eq!(location(DARK, Some(MONO)), Some(MONO));
        assert_eq!(location(DARK, None), Some(EXE));
        // Already right.
        assert_eq!(location(&DARK.to_lowercase(), Some(DARK)), None);
        assert_eq!(location("", None), None);
        assert_eq!(location(EXE, None), None);
    }

    #[test]
    fn a_hand_picked_icon_is_left_alone() {
        assert_eq!(location(r"C:\Icons\mine.ico", Some(DARK)), None);
        assert_eq!(location(r"C:\Icons\mine.ico", None), None);
    }
}
