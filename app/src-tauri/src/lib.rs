#[cfg_attr(not(target_os = "android"), allow(dead_code))] // desktop: only its tests use it
mod cast;

use std::net::UdpSocket;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

#[derive(serde::Serialize, Debug, PartialEq)]
struct Receiver {
    ip: String,
    model: String,
    name: String,
}

const SEARCH: &[u8] = b"M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n";

// Yamaha MusicCast devices answer with "X-ModelName: HTR-4072:00A0DE000001:Living Room"
fn parse_reply(reply: &str, ip: String) -> Option<Receiver> {
    let value = reply.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case("x-modelname").then(|| v.trim())
    })?;
    let mut parts = value.splitn(3, ':');
    let model = parts.next()?.to_string();
    let name = parts.nth(1).unwrap_or(&model).to_string();
    Some(Receiver { ip, model, name })
}

// SSDP search on the LAN; the webview can't do UDP, so this lives in Rust
fn search(wait: Duration) -> std::io::Result<Vec<Receiver>> {
    let socket = UdpSocket::bind("0.0.0.0:0")?;
    // UDP is lossy: UPnP recommends sending the search more than once
    for _ in 0..2 {
        socket.send_to(SEARCH, "239.255.255.250:1900")?;
    }
    let deadline = Instant::now() + wait;
    let mut found: Vec<Receiver> = Vec::new();
    let mut buf = [0u8; 2048];
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        socket.set_read_timeout(Some(left.max(Duration::from_millis(1))))?;
        let Ok((n, from)) = socket.recv_from(&mut buf) else { break };
        let reply = String::from_utf8_lossy(&buf[..n]);
        if let Some(r) = parse_reply(&reply, from.ip().to_string()) {
            if !found.iter().any(|f| f.ip == r.ip) {
                found.push(r);
            }
        }
    }
    Ok(found)
}

#[tauri::command]
async fn discover() -> Result<Vec<Receiver>, String> {
    tauri::async_runtime::spawn_blocking(|| search(Duration::from_secs(2)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

// YXC push: the receiver sends JSON datagrams to the port we announce in X-AppPort.
// Events are mostly "re-fetch" flags, so the webview just gets a ping and refreshes.
struct EventsPort(u16);

#[tauri::command]
fn events_port(port: tauri::State<EventsPort>) -> u16 {
    port.0
}

// Everything but the 1 Hz netusb.play_time tick is worth a refresh
fn worth_refresh(datagram: &[u8]) -> bool {
    let Ok(serde_json::Value::Object(event)) = serde_json::from_slice(datagram) else { return false };
    event.iter().any(|(module, changes)| match (module.as_str(), changes) {
        ("device_id", _) => false,
        ("netusb", serde_json::Value::Object(c)) => c.keys().any(|k| k != "play_time"),
        _ => true,
    })
}

fn listen_events(app: tauri::AppHandle) -> std::io::Result<u16> {
    let socket = UdpSocket::bind("0.0.0.0:0")?; // random port: 41100 may be taken by the official app
    let port = socket.local_addr()?.port();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok((n, _)) = socket.recv_from(&mut buf) {
            if worth_refresh(&buf[..n]) {
                let _ = app.emit("yxc-event", ());
            }
        }
    });
    Ok(port)
}

// Android media notification, lock screen and volume keys: Kotlin MediaPlugin/MediaService in gen/android.
// The webview pushes what's playing; on desktop this is a no-op.
#[cfg(target_os = "android")]
struct Media(tauri::plugin::PluginHandle<tauri::Wry>);

fn media_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("media")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _app.manage(Media(_api.register_android_plugin("io.hadrien.yxcremote", "MediaPlugin")?));
            Ok(())
        })
        .build()
}

// async: sync commands run on the main thread, and run_mobile_plugin waits on Kotlin, which needs it too (deadlock)
#[tauri::command]
async fn media_update(_app: tauri::AppHandle, _state: serde_json::Value) -> Result<(), String> {
    #[cfg(target_os = "android")]
    _app.state::<Media>().0.run_mobile_plugin::<()>("update", _state).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(media_plugin())
        .setup(|app| {
            let port = listen_events(app.handle().clone())?;
            app.manage(EventsPort(port));
            #[cfg(target_os = "android")]
            cast::serve("127.0.0.1:8770")?; // spike: fed by CastSpikeService
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![discover, events_port, media_update])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from the HTR-4072 on 2026-09-26
    const REPLY: &str = "HTTP/1.1 200 OK\r\nLocation: http://192.0.2.10:49154/MediaRenderer/desc.xml\r\nServer: Linux/3.2 UPnP/1.0 Network_Module/1.0 (HTR-4072)\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nX-ModelName: HTR-4072:00A0DE000001:Living Room\r\n\r\n";

    #[test]
    fn parses_yamaha_reply() {
        assert_eq!(
            parse_reply(REPLY, "192.0.2.10".into()),
            Some(Receiver { ip: "192.0.2.10".into(), model: "HTR-4072".into(), name: "Living Room".into() })
        );
    }

    #[test]
    fn ignores_non_yamaha_renderers() {
        assert_eq!(parse_reply("HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n", "1.2.3.4".into()), None);
    }

    // Captured from the HTR-4072 on 2026-09-26
    #[test]
    fn skips_only_play_time_ticks() {
        assert!(!worth_refresh(br#"{"netusb":{"play_time":6903},"device_id":"00A0DE000001"}"#));
        assert!(worth_refresh(br#"{"netusb":{"play_info_updated":true,"play_time":7011},"device_id":"00A0DE000001"}"#));
        assert!(worth_refresh(br#"{"main":{"volume":78,"actual_volume":{"mode":"db","value":-41.5,"unit":"dB"}},"device_id":"00A0DE000001"}"#));
        assert!(!worth_refresh(b"not json"));
    }

    // Hits the real LAN: cargo test -- --ignored
    #[test]
    #[ignore]
    fn finds_receiver_on_lan() {
        println!("{:?}", search(Duration::from_secs(2)).unwrap());
    }
}
