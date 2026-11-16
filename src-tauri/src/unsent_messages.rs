//! Unsent messages (Ref #370). With Settings → Account → Keep unsent messages
//! on (off by default), the page copies a message someone unsends just
//! before Messenger clears it (inject/src/messenger/features/unsent-messages.ts)
//! and hands the copy here with a signed `chatpane:unsent-messages` request.
//! Pages ask for an account's copies the same way, and a new copy sends the
//! other Messenger windows `chatpane:unsent-messages-changed` to ask again.
//!
//! Copies are encrypted at rest with AES-256-GCM. The key lives in the OS
//! credential store (keystore.rs), never next to the file. Copies are
//! deleted after the retention period, by Settings' Delete button, when the
//! setting is turned off (which also deletes the key), and by Log Out.
//! Nothing is uploaded or synced.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use tauri::{Listener, Manager};

const EVENT: &str = "chatpane:unsent-messages";
const CHANGED_EVENT: &str = "chatpane:unsent-messages-changed";
/// The encrypted copies, in the data directory.
const STORE_FILE: &str = "unsent-messages.bin";
const TEMP_PREFIX: &str = ".unsent-messages-";
/// The key's name in the OS credential store.
const KEY_NAME: &str = "unsent-messages-key";
/// File format: MAGIC, a random nonce, then the sealed JSON. MAGIC is also
/// the sealed data's associated data.
const MAGIC: &[u8; 8] = b"CPUNSNT1";
const KEY_LEN: usize = 32;
/// Copies kept across all accounts; the oldest go first.
const MAX_MESSAGES: usize = 2_000;
const MAX_TEXT_CHARS: usize = 20_000;
const MAX_ATTACHMENTS: usize = 20;
const MAX_NAME_CHARS: usize = 255;
/// Retention choices in days (Settings). Mirrors `UNSENT_RETENTION_DAYS` in
/// inject/src/settings/index.ts.
pub(crate) const RETENTION_DAYS: [u32; 2] = [7, 30];
pub(crate) const DEFAULT_RETENTION_DAYS: u32 = 7;
/// How often old copies are deleted while Chatpane runs.
const PURGE_INTERVAL: Duration = Duration::from_secs(60 * 60);
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AttachmentKind {
    Image,
    Video,
    Audio,
    File,
    Link,
    Sticker,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attachment {
    kind: AttachmentKind,
    /// A file name or link title, when the message had one.
    #[serde(default)]
    name: Option<String>,
    /// A voice clip's or video's length.
    #[serde(default)]
    duration_ms: Option<u64>,
}

/// One kept copy, as the page sends it and as it is stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Kept {
    /// The id of the row Messenger shows as "unsent a message": the page
    /// shows the copy there.
    id: String,
    thread: String,
    sender: String,
    sent_ms: i64,
    /// When Chatpane kept it; retention counts from here. Set natively.
    #[serde(default)]
    kept_ms: i64,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Stored {
    account: String,
    #[serde(flatten)]
    kept: Kept,
}

fn valid_numeric_id(id: &str) -> bool {
    (1..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}

/// Messenger's message ids: "mid.$…" in regular chats and
/// "<digits>@<host>.<digits>" in encrypted ones.
fn valid_message_id(id: &str) -> bool {
    (1..=160).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".$@_:+=/-".contains(&b))
}

fn clean(text: &str, max_chars: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take(max_chars)
        .collect()
}

impl Kept {
    /// A copy from an untrusted page, cleaned and capped; None when invalid
    /// or empty.
    fn cleaned(mut self, kept_ms: i64) -> Option<Self> {
        if !valid_message_id(&self.id)
            || !valid_numeric_id(&self.thread)
            || !valid_numeric_id(&self.sender)
            || self.sent_ms <= 0
        {
            return None;
        }
        self.kept_ms = kept_ms;
        self.text = self
            .text
            .map(|text| clean(&text, MAX_TEXT_CHARS))
            .filter(|text| !text.trim().is_empty());
        self.attachments.truncate(MAX_ATTACHMENTS);
        for attachment in &mut self.attachments {
            attachment.name = attachment
                .name
                .as_deref()
                .map(|name| clean(name, MAX_NAME_CHARS).replace(['\n', '\t'], " "))
                .filter(|name| !name.trim().is_empty());
        }
        (self.text.is_some() || !self.attachments.is_empty()).then_some(self)
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn sealing_key(key: &[u8; KEY_LEN]) -> LessSafeKey {
    LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).expect("a 256-bit key"))
}

fn seal(key: &[u8; KEY_LEN], plain: &[u8]) -> Result<Vec<u8>, String> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| "no random nonce")?;
    let mut sealed = plain.to_vec();
    sealing_key(key)
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(MAGIC),
            &mut sealed,
        )
        .map_err(|_| "sealing failed")?;
    let mut file = Vec::with_capacity(MAGIC.len() + NONCE_LEN + sealed.len());
    file.extend_from_slice(MAGIC);
    file.extend_from_slice(&nonce);
    file.extend_from_slice(&sealed);
    Ok(file)
}

/// The plain bytes, or None when the file isn't ours or the key doesn't open it.
fn open(key: &[u8; KEY_LEN], file: &[u8]) -> Option<Vec<u8>> {
    let rest = file.strip_prefix(MAGIC)?;
    if rest.len() < NONCE_LEN {
        return None;
    }
    let (nonce, sealed) = rest.split_at(NONCE_LEN);
    let nonce = Nonce::try_assume_unique_for_key(nonce).ok()?;
    let mut sealed = sealed.to_vec();
    let plain = sealing_key(key)
        .open_in_place(nonce, Aad::from(MAGIC), &mut sealed)
        .ok()?;
    Some(plain.to_vec())
}

/// The key from the credential store, made and stored on first use.
fn load_or_create_key() -> Result<[u8; KEY_LEN], String> {
    if let Some(key) = crate::keystore::read(KEY_NAME)?
        && let Ok(key) = <[u8; KEY_LEN]>::try_from(key.as_slice())
    {
        return Ok(key);
    }
    let mut key = [0u8; KEY_LEN];
    SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "no random key")?;
    crate::keystore::write(KEY_NAME, &key)?;
    Ok(key)
}

fn remove(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("No data directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!("{TEMP_PREFIX}{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        crate::settings::replace_file(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result.map_err(|e| e.to_string())
}

/// The store and any temporary file a crash left mid-save (Log Out).
pub(crate) fn account_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = vec![dir.join(STORE_FILE)];
    if let Ok(entries) = std::fs::read_dir(dir) {
        files.extend(entries.flatten().map(|entry| entry.path()).filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(TEMP_PREFIX) && name.ends_with(".tmp"))
        }));
    }
    files
}

#[derive(Debug, Default)]
struct Copies {
    key: [u8; KEY_LEN],
    messages: Vec<Stored>,
}

impl Copies {
    fn from_file(key: [u8; KEY_LEN], file: Option<&[u8]>) -> Self {
        let messages = file
            .and_then(|file| {
                let plain = open(&key, file);
                if plain.is_none() {
                    log::warn!("kept unsent messages could not be opened; starting over");
                }
                plain
            })
            .and_then(|plain| serde_json::from_slice(&plain).ok())
            .unwrap_or_default();
        Self { key, messages }
    }

    /// Delete copies kept before `now - retention`; whether any went.
    fn purge(&mut self, now: i64, retention_days: u32) -> bool {
        let oldest = now - i64::from(retention_days) * DAY_MS;
        let before = self.messages.len();
        self.messages.retain(|stored| stored.kept.kept_ms >= oldest);
        self.messages.len() != before
    }

    /// Keep `kept` for `account`, replacing an earlier copy of the same row.
    fn add(&mut self, account: &str, kept: Kept) {
        self.messages
            .retain(|stored| !(stored.account == account && stored.kept.id == kept.id));
        self.messages.push(Stored {
            account: account.to_owned(),
            kept,
        });
        if self.messages.len() > MAX_MESSAGES {
            self.messages.sort_by_key(|stored| stored.kept.kept_ms);
            let excess = self.messages.len() - MAX_MESSAGES;
            self.messages.drain(..excess);
        }
    }

    fn list(&self, account: &str) -> Vec<&Kept> {
        self.messages
            .iter()
            .filter(|stored| stored.account == account)
            .map(|stored| &stored.kept)
            .collect()
    }

    fn save(&self, path: &Path) -> Result<(), String> {
        if self.messages.is_empty() {
            return remove(path);
        }
        let json = serde_json::to_vec(&self.messages).map_err(|e| e.to_string())?;
        write_atomically(path, &seal(&self.key, &json)?)
    }
}

struct Store {
    path: PathBuf,
    /// Opened on first use while the setting is on.
    copies: Option<Copies>,
    /// Rises with every change, so a page can drop an answer older than the
    /// one it has.
    revision: u64,
    /// The setting, as this store last applied it. Kept under the store's
    /// lock, so a request waiting on it can't keep a copy after turning off.
    enabled: bool,
    /// Whether pages may keep copies: only one Chatpane process may write the
    /// file, so not while Multi Instance runs several. Old copies still expire.
    accepting: bool,
}

impl Store {
    fn copies(&mut self) -> Result<&mut Copies, String> {
        // While pages can't keep copies, other Chatpane processes may share
        // the file, so every use reads it again rather than trusting a copy.
        if !self.accepting {
            self.copies = None;
        }
        if self.copies.is_none() {
            let key = load_or_create_key()?;
            // A snapshot a crash left mid-save holds copies this file may have
            // dropped since. (Another process may be mid-save while several run.)
            if self.accepting {
                for temp in account_files(self.path.parent().unwrap_or(Path::new(".")))
                    .iter()
                    .filter(|file| **file != self.path)
                {
                    remove(temp)?;
                }
            }
            let file = match std::fs::read(&self.path) {
                Ok(file) => Some(file),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                // Starting empty would overwrite the copies on the next save.
                Err(error) => return Err(error.to_string()),
            };
            self.copies = Some(Copies::from_file(key, file.as_deref()));
        }
        Ok(self.copies.as_mut().expect("opened above"))
    }

    /// Delete copies past the retention period; whether any went.
    fn purge(&mut self, retention_days: u32) -> Result<bool, String> {
        let path = self.path.clone();
        let copies = self.copies()?;
        let before = copies.messages.clone();
        if !copies.purge(now_ms(), retention_days) {
            return Ok(false);
        }
        if let Err(error) = copies.save(&path) {
            // Keep them in memory too, so the next purge tries again.
            copies.messages = before;
            return Err(error);
        }
        self.revision += 1;
        Ok(true)
    }

    fn add(&mut self, account: &str, kept: Kept) -> Result<(), String> {
        let path = self.path.clone();
        let copies = self.copies()?;
        copies.add(account, kept);
        copies.save(&path)?;
        self.revision += 1;
        Ok(())
    }

    /// Delete every copy and, with `forget_key`, the key too. Only the file
    /// must go: a key left in an unreachable keyring opens nothing without it,
    /// and turning the setting off must never depend on the keyring.
    fn clear(&mut self, forget_key: bool) -> Result<(), String> {
        let result = account_files(self.path.parent().unwrap_or(Path::new(".")))
            .iter()
            .try_for_each(|file| remove(file));
        // Delete All must leave the count and retryable copies intact on failure.
        // Opting out still forgets the key and plaintext even if deletion fails.
        if result.is_err() && !forget_key {
            return result;
        }
        if let Some(copies) = self.copies.as_mut() {
            copies.messages.clear();
        }
        if forget_key {
            self.copies = None;
            if let Err(error) = crate::keystore::delete(KEY_NAME) {
                log::warn!("could not delete the unsent messages key: {error}");
            }
        }
        self.revision += 1;
        result
    }
}

/// The retention period as Settings has it now.
fn retention_days(app: &tauri::AppHandle) -> u32 {
    app.state::<crate::AppState>()
        .settings
        .lock()
        .unwrap()
        .unsent_retention_days
}

fn with_store<T>(
    app: &tauri::AppHandle,
    run: impl FnOnce(&mut Store) -> Result<T, String>,
) -> Result<T, String> {
    let state = app
        .try_state::<Mutex<Store>>()
        .ok_or("no data directory for unsent messages")?;
    let mut store = state.lock().unwrap();
    run(&mut store)
}

/// Settings turned the feature on or off. On makes sure the key can be kept
/// (an error keeps the setting off); off deletes every copy and the key.
pub(crate) fn set_enabled(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    with_store(app, |store| {
        if enabled && !store.accepting {
            return Err(crate::i18n::t("settings.unsent.multi_instance").to_owned());
        }
        if enabled {
            store.copies().map_err(|error| {
                log::error!("could not set up the unsent messages key: {error}");
                crate::i18n::t("settings.unsent.keystore_failed").to_owned()
            })?;
        } else {
            store.clear(true).inspect_err(|error| {
                log::error!("could not delete kept unsent messages: {error}");
            })?;
        }
        store.enabled = enabled;
        Ok(())
    })?;
    if !enabled {
        announce_change(app, None);
    }
    Ok(())
}

/// A settings save failed after `set_enabled` ran: follow the setting that
/// stays in effect. Copies already deleted stay deleted.
pub(crate) fn follow_settings(app: &tauri::AppHandle) {
    let state = app.state::<crate::AppState>();
    let enabled = state.settings.lock().unwrap().recover_unsent_messages;
    let _ = with_store(app, |store| {
        store.enabled = enabled;
        if !enabled {
            store.clear(true)?;
        }
        Ok(())
    });
}

/// Settings changed the retention period.
pub(crate) fn retention_changed(app: &tauri::AppHandle) {
    purge(app);
}

/// Delete copies past the retention period, and tell the pages showing them.
fn purge(app: &tauri::AppHandle) {
    let days = retention_days(app);
    match with_store(app, |store| {
        if store.enabled {
            store.purge(days)
        } else if store.path.exists() {
            // A file a failed delete left behind when the setting went off.
            store.clear(true).map(|()| true)
        } else {
            Ok(false)
        }
    }) {
        Ok(true) => announce_change(app, None),
        Ok(false) => {}
        Err(error) => log::error!("could not delete old unsent messages: {error}"),
    }
}

/// How many copies are kept, for Settings.
#[tauri::command]
pub(crate) async fn unsent_messages_count(app: tauri::AppHandle) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        purge(&app);
        with_store(&app, |store| {
            if !store.enabled {
                return Ok(0);
            }
            Ok(store.copies()?.messages.len())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Settings → Delete stored messages, after confirmation. Returns whether
/// they were deleted.
#[tauri::command]
pub(crate) async fn delete_unsent_messages(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let t = crate::i18n::t;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(t("dialog.delete_unsent.message"))
        .title(t("dialog.delete_unsent.title"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            t("dialog.delete_unsent.confirm").into(),
            t("dialog.cancel").into(),
        ))
        .parent(&window)
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
        });
    if !receiver.await.unwrap_or(false) {
        return Ok(false);
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || with_store(&handle, |store| store.clear(false)))
        .await
        .map_err(|e| e.to_string())?
        .inspect_err(|error| log::error!("could not delete kept unsent messages: {error}"))?;
    announce_change(&app, None);
    Ok(true)
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Op {
    List,
    Add { message: Kept },
}

#[derive(Deserialize)]
struct Request {
    /// The page's token for the signed reply.
    request: String,
    account: String,
    #[serde(flatten)]
    op: Op,
}

/// Tell Messenger windows other than `except` to ask again. It carries
/// nothing, so a page script faking it only causes a signed request.
fn announce_change(app: &tauri::AppHandle, except: Option<&str>) {
    let script = format!("window.dispatchEvent(new Event('{CHANGED_EVENT}'));");
    for (label, window) in app.webview_windows() {
        if Some(label.as_str()) != except && crate::window::is_messenger_window_label(&label) {
            let _ = window.eval(&script);
        }
    }
}

fn answer(app: &tauri::AppHandle, label: &str, request: Request) {
    let days = retention_days(app);
    let result = with_store(app, |store| -> Result<(serde_json::Value, bool), String> {
        if !(store.enabled && store.accepting) {
            let data =
                serde_json::json!({ "enabled": false, "revision": store.revision, "messages": [] });
            return Ok((data, false));
        }
        let mut changed = store.purge(days)?;
        if let Op::Add { message } = request.op
            && let Some(kept) = message.cleaned(now_ms())
        {
            store.add(&request.account, kept)?;
            changed = true;
        }
        let messages = serde_json::to_value(store.copies()?.list(&request.account))
            .map_err(|e| e.to_string())?;
        let data = serde_json::json!({ "enabled": true, "revision": store.revision, "messages": messages });
        Ok((data, changed))
    });
    let (data, changed) = result.unwrap_or_else(|error| {
        log::error!("unsent messages request failed: {error}");
        // The page keeps what it shows until an answer succeeds.
        (serde_json::json!({ "error": true }), false)
    });
    crate::send_data_result(app, label, EVENT, &request.request, data.to_string());
    if changed {
        announce_change(app, Some(label));
    }
}

pub(crate) fn install(app: &tauri::AppHandle, single_instance: bool) {
    let Ok(directory) = app.path().app_data_dir() else {
        return;
    };
    let path = directory.join(STORE_FILE);
    let enabled = app
        .state::<crate::AppState>()
        .settings
        .lock()
        .unwrap()
        .recover_unsent_messages;
    app.manage(Mutex::new(Store {
        path,
        copies: None,
        revision: 1,
        enabled,
        accepting: single_instance,
    }));

    // Once now, then hourly.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let worker = handle.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || purge(&worker)).await;
            tokio::time::sleep(PURGE_INTERVAL).await;
        }
    });

    let handle = app.clone();
    app.listen_any(EVENT, move |event| {
        // Any script on a granted origin can emit this event, so only
        // Chatpane's signed requests are answered.
        let Ok(signed) = serde_json::from_str::<crate::SignedAction>(event.payload()) else {
            return;
        };
        let Some(label) = crate::signed_action_window(&handle, EVENT, &signed) else {
            return;
        };
        let Ok(request) = serde_json::from_str::<Request>(&signed.message) else {
            return;
        };
        if request.request.len() != 32
            || !request.request.bytes().all(|b| b.is_ascii_hexdigit())
            || !crate::scheduled_send::valid_account(&request.account)
        {
            return;
        }
        let handle = handle.clone();
        tauri::async_runtime::spawn_blocking(move || answer(&handle, &label, request));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kept(id: &str, kept_ms: i64) -> Kept {
        Kept {
            id: id.into(),
            thread: "42".into(),
            sender: "7".into(),
            sent_ms: 1_000,
            kept_ms,
            text: Some("hello".into()),
            attachments: Vec::new(),
        }
    }

    #[test]
    fn sealed_copies_open_only_with_their_key() {
        let key = [7u8; KEY_LEN];
        let file = seal(&key, b"secret text").unwrap();
        assert!(file.starts_with(MAGIC));
        assert!(!file.windows(11).any(|window| window == b"secret text"));
        assert_eq!(open(&key, &file).unwrap(), b"secret text");
        assert!(open(&[8u8; KEY_LEN], &file).is_none());
        let mut tampered = file.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(open(&key, &tampered).is_none());
        // A fresh nonce each time.
        assert_ne!(seal(&key, b"secret text").unwrap(), file);
    }

    #[test]
    fn an_unreadable_file_starts_over() {
        let file = seal(&[1u8; KEY_LEN], b"[]").unwrap();
        let copies = Copies::from_file([2u8; KEY_LEN], Some(&file));
        assert!(copies.messages.is_empty());
    }

    #[test]
    fn page_copies_are_validated_and_capped() {
        let message: Kept = serde_json::from_value(serde_json::json!({
            "id": "1234@msgr.5678", "thread": "42", "sender": "7", "sentMs": 5,
            "keptMs": 99, "text": "hi\u{0}there",
            "attachments": [{ "kind": "image", "name": "  " }, { "kind": "file", "name": "a\nb.pdf" }],
        }))
        .unwrap();
        let cleaned = message.clone().cleaned(1_000).unwrap();
        assert_eq!(cleaned.kept_ms, 1_000, "the page doesn't choose its age");
        assert_eq!(cleaned.text.as_deref(), Some("hithere"));
        assert_eq!(cleaned.attachments[0].name, None);
        assert_eq!(cleaned.attachments[1].name.as_deref(), Some("a b.pdf"));

        for bad in [
            Kept {
                id: "<script>".into(),
                ..message.clone()
            },
            Kept {
                thread: "4a".into(),
                ..message.clone()
            },
            Kept {
                text: Some("   ".into()),
                attachments: Vec::new(),
                ..message.clone()
            },
        ] {
            assert!(bad.cleaned(1_000).is_none());
        }
        let long = Kept {
            text: Some("x".repeat(MAX_TEXT_CHARS + 10)),
            ..message
        };
        assert_eq!(
            long.cleaned(1).unwrap().text.unwrap().chars().count(),
            MAX_TEXT_CHARS
        );
    }

    #[test]
    fn copies_are_per_account_replaced_by_id_and_purged_by_age() {
        let mut copies = Copies::default();
        copies.add("1", kept("a", 10 * DAY_MS));
        copies.add("1", kept("a", 11 * DAY_MS));
        copies.add("2", kept("b", 2 * DAY_MS));
        assert_eq!(copies.list("1").len(), 1);
        assert_eq!(copies.list("1")[0].kept_ms, 11 * DAY_MS);
        assert_eq!(copies.list("2").len(), 1);
        assert!(copies.purge(12 * DAY_MS, 7));
        assert!(copies.list("2").is_empty());
        assert!(!copies.purge(12 * DAY_MS, 7));
    }

    #[test]
    fn failed_delete_all_preserves_copies_and_revision_until_retry() {
        let dir = std::env::temp_dir().join(format!("chatpane-unsent-{}", uuid::Uuid::new_v4()));
        let path = dir.join(STORE_FILE);
        // A directory at the file path reliably makes remove_file fail on all platforms.
        std::fs::create_dir_all(&path).unwrap();
        let mut copies = Copies::default();
        copies.add("1", kept("a", now_ms()));
        let mut store = Store {
            path: path.clone(),
            copies: Some(copies),
            revision: 1,
            enabled: true,
            accepting: true,
        };
        assert!(store.clear(false).is_err());
        assert_eq!(store.copies().unwrap().messages.len(), 1);
        assert_eq!(store.revision, 1);

        std::fs::remove_dir(&path).unwrap();
        store.copies().unwrap().save(&path).unwrap();
        store.clear(false).unwrap();
        assert!(!path.exists());
        assert!(store.copies().unwrap().messages.is_empty());
        assert_eq!(store.revision, 2);
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn the_oldest_copies_go_past_the_cap() {
        let mut copies = Copies::default();
        for index in 0..=MAX_MESSAGES {
            copies.add("1", kept(&format!("m{index}"), index as i64));
        }
        assert_eq!(copies.messages.len(), MAX_MESSAGES);
        assert!(copies.list("1").iter().all(|kept| kept.id != "m0"));
    }
}
