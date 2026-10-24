//! Background auto-update for the desktop shell.
//!
//! The chat UI itself is the live `/app` client, so it is always current. This
//! module keeps the *shell* (window, menus, webview host) current too:
//!
//! - checks on launch and every [`CHECK_INTERVAL`], downloads in the background;
//! - installs the new bundle on disk but never swaps the running app: the new
//!   version starts on the next launch (or via "Restart to Update");
//! - trusts nothing from the feed alone: the minisign signature is checked by
//!   the updater plugin, then the extracted bundle must carry the same Developer
//!   ID Team ID as the running app and pass Gatekeeper before it is installed;
//! - never downgrades (the plugin only offers strictly newer semver versions);
//! - fails silently: a failed check is logged, never shown as an error;
//! - automatic install can be turned off from the app menu; manual "Check for
//!   Updates…" always works.
//!
//! State is mirrored to the webview as `window.__OPENCHAT_DESKTOP__` so the
//! client's Settings screen can show the Mac app version and update state.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Release feed. The release script attaches `latest.json` to every
/// `desktop-v*` GitHub release; `latest` resolves to the newest one.
const FEED_URL: &str =
    "https://github.com/IdeaFlowCo/OpenChat/releases/latest/download/latest.json";
/// Lets a test build point at a local feed without rebuilding.
const FEED_OVERRIDE_ENV: &str = "OPENCHAT_UPDATE_FEED";
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(8);
const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

pub const MENU_STATUS: &str = "updates.status";
pub const MENU_CHECK: &str = "updates.check";
pub const MENU_RESTART: &str = "updates.restart";
pub const MENU_AUTO: &str = "updates.auto";

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Idle,
    Checking,
    UpToDate { checked_at: String },
    Available { version: String },
    Downloading { version: String },
    Ready { version: String },
    Failed { checked_at: String },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Prefs {
    auto_install: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { auto_install: true }
    }
}

pub struct Updates {
    status: Mutex<Status>,
    auto_install: Mutex<bool>,
    busy: Mutex<bool>,
    menu: Mutex<Option<MenuItems>>,
}

struct MenuItems {
    status: MenuItem<Wry>,
    check: MenuItem<Wry>,
    restart: MenuItem<Wry>,
}

impl Updates {
    pub fn new(app: &AppHandle) -> Self {
        Updates {
            status: Mutex::new(Status::Idle),
            auto_install: Mutex::new(load_prefs(app).auto_install),
            busy: Mutex::new(false),
            menu: Mutex::new(None),
        }
    }

    pub fn auto_install(&self) -> bool {
        *self.auto_install.lock().unwrap()
    }
}

fn prefs_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("updates.json"))
}

fn load_prefs(app: &AppHandle) -> Prefs {
    prefs_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_prefs(app: &AppHandle, prefs: &Prefs) {
    let Some(path) = prefs_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(prefs) {
        let _ = std::fs::write(path, bytes);
    }
}

fn version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn now_iso() -> String {
    // Seconds since the epoch is enough for "last checked"; the web side formats it.
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default()
}

/// Insert the version/update items at the top of the macOS app menu, below
/// "About OpenChat", keeping the default Edit/Window menus (copy/paste etc.).
pub fn install_menu(app: &AppHandle, menu: &Menu<Wry>) -> tauri::Result<()> {
    let state = app.state::<Updates>();
    let status = MenuItem::with_id(app, MENU_STATUS, status_text(app, &Status::Idle), false, None::<&str>)?;
    let check = MenuItem::with_id(app, MENU_CHECK, "Check for Updates…", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, MENU_RESTART, "Restart to Update", false, None::<&str>)?;
    let auto = CheckMenuItem::with_id(
        app,
        MENU_AUTO,
        "Install Updates Automatically",
        true,
        state.auto_install(),
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;

    if let Some(app_menu) = menu.items()?.first().and_then(|item| item.as_submenu().cloned()) {
        // Position 0 is "About OpenChat".
        app_menu.insert(&status, 1)?;
        app_menu.insert(&check, 2)?;
        app_menu.insert(&restart, 3)?;
        app_menu.insert(&auto, 4)?;
        app_menu.insert(&separator, 5)?;
    }
    *state.menu.lock().unwrap() = Some(MenuItems { status, check, restart });
    Ok(())
}

pub fn on_menu_event(app: &AppHandle, id: &str) {
    match id {
        MENU_CHECK => spawn_check(app.clone(), true),
        MENU_RESTART => app.restart(),
        MENU_AUTO => {
            let state = app.state::<Updates>();
            let enabled = {
                let mut auto = state.auto_install.lock().unwrap();
                *auto = !*auto;
                *auto
            };
            save_prefs(app, &Prefs { auto_install: enabled });
            if enabled {
                spawn_check(app.clone(), false);
            }
        }
        _ => {}
    }
}

/// First check shortly after launch, then on a fixed interval.
pub fn start_background_checks(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        loop {
            tauri::async_runtime::block_on(check(&app, false));
            std::thread::sleep(CHECK_INTERVAL);
        }
    });
}

fn spawn_check(app: AppHandle, manual: bool) {
    tauri::async_runtime::spawn(async move { check(&app, manual).await });
}

async fn check(app: &AppHandle, manual: bool) {
    let state = app.state::<Updates>();
    {
        let mut busy = state.busy.lock().unwrap();
        if *busy {
            return;
        }
        // Once an update is installed on disk there is nothing left to do
        // until the next launch.
        if matches!(*state.status.lock().unwrap(), Status::Ready { .. }) {
            return;
        }
        *busy = true;
    }
    if manual || !matches!(*state.status.lock().unwrap(), Status::Available { .. }) {
        set_status(app, Status::Checking);
    }
    let result = run_check(app, manual).await;
    if let Err(err) = &result {
        eprintln!("[openchat-updater] {err}");
    }
    *state.busy.lock().unwrap() = false;
    let status = match result {
        Ok(status) => status,
        Err(_) => Status::Failed { checked_at: now_iso() },
    };
    set_status(app, status);
}

async fn run_check(app: &AppHandle, manual: bool) -> Result<Status, String> {
    let mut builder = app.updater_builder();
    if let Ok(feed) = std::env::var(FEED_OVERRIDE_ENV) {
        let url = feed.parse().map_err(|e| format!("bad {FEED_OVERRIDE_ENV}: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    } else {
        let url = FEED_URL.parse().map_err(|e| format!("bad feed url: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| format!("check failed: {e}"))? else {
        return Ok(Status::UpToDate { checked_at: now_iso() });
    };

    let bundle = running_bundle().ok_or("not running from an .app bundle")?;
    let auto = app.state::<Updates>().auto_install();
    // An automatic install must never surprise the user with an admin
    // password prompt; leave non-writable installs to a manual check.
    if !manual && (!auto || !can_replace(&bundle)) {
        return Ok(Status::Available { version: update.version.clone() });
    }

    set_status(app, Status::Downloading { version: update.version.clone() });
    install_verified(&update, &bundle).await?;
    Ok(Status::Ready { version: update.version.clone() })
}

async fn install_verified(update: &Update, running: &Path) -> Result<(), String> {
    // `download` verifies the minisign signature against the configured pubkey.
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    verify_bundle(&bytes, running, &update.version)?;
    update.install(&bytes).map_err(|e| format!("install failed: {e}"))
}

/// The `.app` directory the current executable runs from.
fn running_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    // .../OpenChat.app/Contents/MacOS/openchat-desktop
    let bundle = exe.parent()?.parent()?.parent()?.to_path_buf();
    (bundle.extension()? == "app").then_some(bundle)
}

fn can_replace(bundle: &Path) -> bool {
    // The installer renames the bundle out of its parent directory.
    let writable = |p: &Path| Command::new("test").arg("-w").arg(p).status().map(|s| s.success()).unwrap_or(false);
    bundle.parent().map(writable).unwrap_or(false) && writable(bundle)
}

/// Extract the downloaded bundle to a scratch directory and check that it is
/// signed by the same Developer ID team as the running app, passes Gatekeeper,
/// and is the version the feed advertised.
fn verify_bundle(archive: &[u8], running: &Path, expected_version: &str) -> Result<(), String> {
    let expected_team = team_id(running).ok_or("running app has no Developer ID team; refusing auto-install")?;

    let scratch = std::env::temp_dir().join(format!("openchat-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    let result = (|| {
        let tarball = scratch.join("update.app.tar.gz");
        std::fs::write(&tarball, archive).map_err(|e| e.to_string())?;
        run("tar", &["-xzf", path_str(&tarball)?, "-C", path_str(&scratch)?])?;
        let app = std::fs::read_dir(&scratch)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .find(|p| p.extension().map(|x| x == "app").unwrap_or(false))
            .ok_or("archive has no .app bundle")?;

        run("codesign", &["--verify", "--deep", "--strict", path_str(&app)?])?;
        let team = team_id(&app).ok_or("update is not Developer ID signed")?;
        if team != expected_team {
            return Err(format!("update signed by team {team}, expected {expected_team}"));
        }
        run("spctl", &["--assess", "--type", "execute", path_str(&app)?])?;

        let plist = app.join("Contents/Info.plist");
        let version = Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", "Print :CFBundleShortVersionString", path_str(&plist)?])
            .output()
            .map_err(|e| e.to_string())?;
        let version = String::from_utf8_lossy(&version.stdout).trim().to_string();
        if version != expected_version {
            return Err(format!("bundle is {version}, feed advertised {expected_version}"));
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    result
}

fn team_id(app: &Path) -> Option<String> {
    let out = Command::new("codesign").args(["-dv", "--verbose=2"]).arg(app).output().ok()?;
    // codesign prints signing details on stderr.
    String::from_utf8_lossy(&out.stderr)
        .lines()
        .find_map(|l| l.strip_prefix("TeamIdentifier="))
        .map(str::trim)
        .filter(|t| !t.is_empty() && *t != "not set")
        .map(str::to_string)
}

fn run(cmd: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new(cmd).args(args).output().map_err(|e| format!("{cmd}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("{cmd} failed: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

fn path_str(p: &Path) -> Result<&str, String> {
    p.to_str().ok_or_else(|| format!("non-UTF-8 path {}", p.display()))
}

fn status_text(app: &AppHandle, status: &Status) -> String {
    let v = version(app);
    match status {
        Status::Idle => format!("Version {v}"),
        Status::Checking => format!("Version {v} — checking for updates…"),
        Status::UpToDate { .. } => format!("Version {v} — up to date"),
        Status::Available { version } => format!("Version {version} available — use Check for Updates"),
        Status::Downloading { version } => format!("Downloading version {version}…"),
        Status::Ready { version } => format!("Version {version} installs on next launch"),
        Status::Failed { .. } => format!("Version {v} — couldn’t check for updates"),
    }
}

fn set_status(app: &AppHandle, status: Status) {
    eprintln!("[openchat-updater] {}", status_text(app, &status));
    let state = app.state::<Updates>();
    *state.status.lock().unwrap() = status.clone();
    if let Some(items) = state.menu.lock().unwrap().as_ref() {
        let _ = items.status.set_text(status_text(app, &status));
        let _ = items.restart.set_enabled(matches!(status, Status::Ready { .. }));
        let _ = items.check.set_enabled(!matches!(
            status,
            Status::Checking | Status::Downloading { .. } | Status::Ready { .. }
        ));
    }
    publish_to_webview(app);
}

/// JavaScript that sets `window.__OPENCHAT_DESKTOP__` and notifies listeners.
pub fn webview_state_script(app: &AppHandle) -> String {
    let state = app.state::<Updates>();
    let payload = serde_json::json!({
        "platform": "macos",
        "version": version(app),
        "autoInstall": state.auto_install(),
        "update": *state.status.lock().unwrap(),
    });
    format!(
        "window.__OPENCHAT_DESKTOP__ = {payload};\
         window.dispatchEvent(new Event('openchat-desktop-update'));"
    )
}

pub fn publish_to_webview(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(webview_state_script(app));
    }
}
