// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::NewWindowResponse;
use tauri::{WebviewUrl, WebviewWindowBuilder};

/// The live responsive client — the same origin, auth, API, and socket that
/// browsers and the RN-web build use, so desktop and mobile share one account
/// and one live conversation state. Keep in sync with `build.frontendDist`.
const APP_URL: &str = "https://chat.globalbr.ai/app/";

/// Hand `window.open` / `Linking.openURL` targets to the system browser; the
/// webview has no tabs, so an in-app popup would just be a dead window.
fn open_in_system_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    if let Err(err) = result {
        eprintln!("could not open {url} in the system browser: {err}");
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(APP_URL.parse()?))
                .title("OpenChat")
                .inner_size(1100.0, 760.0)
                .min_inner_size(380.0, 480.0)
                .on_new_window(|url, _features| {
                    open_in_system_browser(url.as_str());
                    NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OpenChat desktop application");
}
