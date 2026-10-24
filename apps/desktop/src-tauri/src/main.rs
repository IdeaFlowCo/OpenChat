// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod updates;

use tauri::menu::Menu;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// The live responsive client — the same origin, auth, API, and socket that
/// browsers and the RN-web build use, so desktop and mobile share one account
/// and one live conversation state. Keep in sync with `build.frontendDist`.
const APP_URL: &str = "https://chat.ideaflow.app/app/";

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(updates::Updates::new(&handle));

            let menu = Menu::default(&handle)?;
            updates::install_menu(&handle, &menu)?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| updates::on_menu_event(app, event.id().as_ref()));

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(APP_URL.parse()?))
                .title("OpenChat")
                .inner_size(1100.0, 760.0)
                .min_inner_size(380.0, 480.0)
                // Expose the shell version + update state to the client's
                // Settings screen (`window.__OPENCHAT_DESKTOP__`).
                .initialization_script(updates::webview_state_script(&handle))
                .on_page_load(|webview, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        updates::publish_to_webview(webview.app_handle());
                    }
                })
                .on_new_window(|url, _features| {
                    open_in_system_browser(url.as_str());
                    NewWindowResponse::Deny
                })
                .build()?;

            updates::start_background_checks(handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OpenChat desktop application");
}
