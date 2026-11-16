//! Secrets in the OS credential store: the macOS Keychain, the Windows
//! Credential Manager, or a Secret Service keyring (GNOME Keyring, KWallet)
//! on Linux. Each secret is one item named by `name`, under Chatpane's
//! identifier. Used for the key that encrypts kept unsent messages
//! (unsent_messages.rs), so the key never sits next to the data it protects.

/// Every item lives under this service, so the OS lists them as Chatpane's.
const SERVICE: &str = crate::identity::IDENTIFIER;

/// The secret named `name`, or None when there is none.
pub(crate) fn read(name: &str) -> Result<Option<Vec<u8>>, String> {
    platform::read(name)
}

/// Store `secret` as `name`, replacing any earlier one.
pub(crate) fn write(name: &str, secret: &[u8]) -> Result<(), String> {
    platform::write(name, secret)
}

/// Delete the secret named `name`. Deleting one that doesn't exist succeeds.
pub(crate) fn delete(name: &str) -> Result<(), String> {
    platform::delete(name)
}

#[cfg(target_os = "macos")]
mod platform {
    use security_framework::passwords;

    /// errSecItemNotFound
    const NOT_FOUND: i32 = -25300;

    pub(super) fn read(name: &str) -> Result<Option<Vec<u8>>, String> {
        match passwords::get_generic_password(super::SERVICE, name) {
            Ok(secret) => Ok(Some(secret)),
            Err(error) if error.code() == NOT_FOUND => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    pub(super) fn write(name: &str, secret: &[u8]) -> Result<(), String> {
        passwords::set_generic_password(super::SERVICE, name, secret).map_err(|e| e.to_string())
    }

    pub(super) fn delete(name: &str) -> Result<(), String> {
        match passwords::delete_generic_password(super::SERVICE, name) {
            Err(error) if error.code() != NOT_FOUND => Err(error.to_string()),
            _ => Ok(()),
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, GetLastError};
    use windows_sys::Win32::Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree,
        CredReadW, CredWriteW,
    };

    /// "app.chatpane.Chatpane/<name>", NUL-terminated UTF-16.
    fn target(name: &str) -> Vec<u16> {
        format!("{}/{name}", super::SERVICE)
            .encode_utf16()
            .chain(Some(0))
            .collect()
    }

    fn last_error(call: &str) -> String {
        // SAFETY: reads the calling thread's last-error value.
        format!("{call} failed ({})", unsafe { GetLastError() })
    }

    pub(super) fn read(name: &str) -> Result<Option<Vec<u8>>, String> {
        let target = target(name);
        let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `target` is NUL-terminated and outlives the call; on success
        // `credential` points to a block the system allocated, freed below.
        if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
            // SAFETY: as in `last_error`.
            if unsafe { GetLastError() } == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(last_error("CredReadW"));
        }
        // SAFETY: CredReadW succeeded, so `credential` is valid until CredFree,
        // and its blob holds `CredentialBlobSize` bytes.
        let secret = unsafe {
            let blob = (*credential).CredentialBlob;
            let size = (*credential).CredentialBlobSize as usize;
            let secret = if blob.is_null() {
                Vec::new()
            } else {
                std::slice::from_raw_parts(blob, size).to_vec()
            };
            CredFree(credential.cast());
            secret
        };
        Ok(Some(secret))
    }

    pub(super) fn write(name: &str, secret: &[u8]) -> Result<(), String> {
        let mut target = target(name);
        let mut blob = secret.to_vec();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            CredentialBlobSize: u32::try_from(blob.len()).map_err(|e| e.to_string())?,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        // SAFETY: every pointer in `credential` points into a live local buffer.
        if unsafe { CredWriteW(&credential, 0) } == 0 {
            return Err(last_error("CredWriteW"));
        }
        Ok(())
    }

    pub(super) fn delete(name: &str) -> Result<(), String> {
        let target = target(name);
        // SAFETY: `target` is NUL-terminated and outlives the call.
        if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0
            // SAFETY: as in `last_error`.
            && unsafe { GetLastError() } != ERROR_NOT_FOUND
        {
            return Err(last_error("CredDeleteW"));
        }
        Ok(())
    }
}

/// The freedesktop Secret Service API over the session bus, with the "plain"
/// transfer: the bus is local to the session, as with libsecret's own use of
/// it. A locked keyring asks the user to unlock it.
#[cfg(target_os = "linux")]
mod platform {
    use std::collections::HashMap;
    use std::time::Duration;

    use serde::{Deserialize, Serialize};
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::{OwnedObjectPath, OwnedValue, Type, Value};

    const BUS: &str = "org.freedesktop.secrets";
    const SERVICE_PATH: &str = "/org/freedesktop/secrets";
    const DEFAULT_COLLECTION: &str = "/org/freedesktop/secrets/aliases/default";
    const SERVICE_IFACE: &str = "org.freedesktop.Secret.Service";
    const COLLECTION_IFACE: &str = "org.freedesktop.Secret.Collection";
    const ITEM_IFACE: &str = "org.freedesktop.Secret.Item";
    const PROMPT_IFACE: &str = "org.freedesktop.Secret.Prompt";
    /// How long an unlock prompt may wait for the user.
    const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

    #[derive(Debug, Serialize, Deserialize, Type)]
    struct Secret {
        session: OwnedObjectPath,
        parameters: Vec<u8>,
        value: Vec<u8>,
        content_type: String,
    }

    struct Session {
        connection: Connection,
        path: OwnedObjectPath,
    }

    fn error(error: zbus::Error) -> String {
        format!("Secret Service: {error}")
    }

    impl Session {
        fn open() -> Result<Self, String> {
            let connection = Connection::session().map_err(error)?;
            let service =
                Proxy::new(&connection, BUS, SERVICE_PATH, SERVICE_IFACE).map_err(error)?;
            let (_, path): (OwnedValue, OwnedObjectPath) = service
                .call("OpenSession", &("plain", Value::from("")))
                .map_err(error)?;
            Ok(Self { connection, path })
        }

        fn proxy<'a>(&'a self, path: &'a str, interface: &'a str) -> Result<Proxy<'a>, String> {
            Proxy::new(&self.connection, BUS, path, interface).map_err(error)
        }

        fn attributes(name: &str) -> HashMap<&str, &str> {
            HashMap::from([("application", super::SERVICE), ("name", name)])
        }

        /// Wait for the user to answer a prompt; false when they dismissed it.
        fn prompt(&self, prompt: &OwnedObjectPath) -> Result<bool, String> {
            if prompt.as_str() == "/" {
                return Ok(true);
            }
            let proxy = self.proxy(prompt.as_str(), PROMPT_IFACE)?;
            let mut completed = proxy.receive_signal("Completed").map_err(error)?;
            let _: () = proxy.call("Prompt", &("",)).map_err(error)?;
            let (sender, receiver) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let dismissed = completed
                    .next()
                    .and_then(|message| message.body().deserialize::<(bool, OwnedValue)>().ok())
                    .is_none_or(|(dismissed, _)| dismissed);
                let _ = sender.send(dismissed);
            });
            match receiver.recv_timeout(PROMPT_TIMEOUT) {
                Ok(dismissed) => Ok(!dismissed),
                Err(_) => Err("Secret Service: the keyring prompt timed out".into()),
            }
        }

        /// Unlocked items named `name`, asking to unlock locked ones.
        fn items(&self, name: &str) -> Result<Vec<OwnedObjectPath>, String> {
            let service = self.proxy(SERVICE_PATH, SERVICE_IFACE)?;
            let (unlocked, locked): (Vec<OwnedObjectPath>, Vec<OwnedObjectPath>) = service
                .call("SearchItems", &(Self::attributes(name),))
                .map_err(error)?;
            if locked.is_empty() {
                return Ok(unlocked);
            }
            let (mut opened, prompt): (Vec<OwnedObjectPath>, OwnedObjectPath) =
                service.call("Unlock", &(locked,)).map_err(error)?;
            if prompt.as_str() != "/" {
                if !self.prompt(&prompt)? {
                    return Err("Secret Service: the keyring stayed locked".into());
                }
                return self.items(name);
            }
            opened.extend(unlocked);
            Ok(opened)
        }
    }

    pub(super) fn read(name: &str) -> Result<Option<Vec<u8>>, String> {
        let session = Session::open()?;
        let Some(item) = session.items(name)?.into_iter().next() else {
            return Ok(None);
        };
        let secret: Secret = session
            .proxy(item.as_str(), ITEM_IFACE)?
            .call("GetSecret", &(&session.path,))
            .map_err(error)?;
        Ok(Some(secret.value))
    }

    pub(super) fn write(name: &str, value: &[u8]) -> Result<(), String> {
        let session = Session::open()?;
        let label = format!("Chatpane ({name})");
        let attributes = Session::attributes(name);
        let properties = HashMap::from([
            ("org.freedesktop.Secret.Item.Label", Value::from(label)),
            (
                "org.freedesktop.Secret.Item.Attributes",
                Value::from(attributes),
            ),
        ]);
        let secret = Secret {
            session: session.path.clone(),
            parameters: Vec::new(),
            value: value.to_vec(),
            content_type: "application/octet-stream".into(),
        };
        let collection = session.proxy(DEFAULT_COLLECTION, COLLECTION_IFACE)?;
        let (_, prompt): (OwnedObjectPath, OwnedObjectPath) = collection
            .call("CreateItem", &(properties, secret, true))
            .map_err(error)?;
        if !session.prompt(&prompt)? {
            return Err("Secret Service: the keyring stayed locked".into());
        }
        // A prompted creation reports its item only in the prompt's result,
        // so check that it landed.
        if prompt.as_str() != "/" && session.items(name)?.is_empty() {
            return Err("Secret Service: the key was not saved".into());
        }
        Ok(())
    }

    pub(super) fn delete(name: &str) -> Result<(), String> {
        let session = Session::open()?;
        for item in session.items(name)? {
            let prompt: OwnedObjectPath = session
                .proxy(item.as_str(), ITEM_IFACE)?
                .call("Delete", &())
                .map_err(error)?;
            session.prompt(&prompt)?;
        }
        Ok(())
    }
}
