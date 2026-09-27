// Cast this device's audio to the receiver: raw PCM (s16le, 48 kHz, stereo) in, MP3 320 kbps out over HTTP,
// played by the receiver through DLNA AVTransport. Why MP3 and the ID3 padding: IMPLEMENTATION.md.
// Android: the Kotlin capture service (Cast.kt) connects to `serve` over loopback and sends
// "<token> <receiver ip> <device name>\n" first; the token keeps other apps on the phone from using us.
// Linux: lib.rs pipes PipeWire's recording into `run`.
use mp3lame_encoder::{Bitrate, Builder, FlushNoGap, InterleavedPcm, Quality};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const RATE: u32 = 48_000;
const FRAMES: usize = 1152; // one MP3 frame
// Fills the receiver's ~90 KB start threshold instantly; decoders skip ID3 tags, so it adds no delay
const ID3_PADDING: u32 = 120_000;
const START_TIMEOUT: Duration = Duration::from_secs(15);
// the receiver left our stream (other input, other device casting): wait this long for a reconnect, then stop
const GONE_GRACE: Duration = Duration::from_secs(3);

/// What the UI hears about a cast
pub enum Event {
    Playing(bool),
    Failed(String),
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))] // Android loopback path
pub fn serve(listen: &str, token: String, on_event: impl Fn(Event) + Send + Sync + 'static) -> std::io::Result<()> {
    let l = TcpListener::bind(listen)?;
    let on_event = Arc::new(on_event);
    thread::spawn(move || {
        for pcm in l.incoming().flatten() {
            let (token, on_event) = (token.clone(), on_event.clone());
            thread::spawn(move || {
                if let Err(e) = cast(pcm, &token, &*on_event) {
                    on_event(Event::Failed(e.to_string()));
                }
            });
        }
    });
    Ok(())
}

/// "<token> <receiver ip> <device name>" → (receiver ip, device name), if the token matches
#[cfg_attr(not(target_os = "android"), allow(dead_code))] // Android loopback path
fn parse_hello(line: &str, token: &str) -> std::io::Result<(IpAddr, String)> {
    let mut parts = line.trim().splitn(3, ' ');
    if parts.next() != Some(token) {
        return Err(std::io::Error::other("bad token"));
    }
    let ip = parts.next().and_then(|ip| ip.parse().ok()).ok_or_else(|| std::io::Error::other("bad receiver ip"))?;
    Ok((ip, parts.next().unwrap_or("").to_string()))
}

type Sink = Arc<Mutex<Option<SyncSender<Vec<u8>>>>>;

#[cfg_attr(not(target_os = "android"), allow(dead_code))] // Android loopback path
fn cast(pcm: TcpStream, token: &str, on_event: &dyn Fn(Event)) -> std::io::Result<()> {
    let mut pcm = BufReader::new(pcm);
    let mut hello = String::new();
    pcm.read_line(&mut hello)?;
    let (rx, name) = parse_hello(&hello, token)?;
    run(pcm, rx, &name, "Phone audio", on_event)
}

/// Casts PCM from `pcm` until it ends (then stops the receiver) or the receiver leaves our stream.
/// The receiver shows the device name as the title (its biggest text) and `kind` ("Phone audio") as the artist.
pub fn run(mut pcm: impl Read, rx: IpAddr, device: &str, kind: &str, on_event: &dyn Fn(Event)) -> std::io::Result<()> {

    let http = TcpListener::bind("0.0.0.0:0")?;
    let url = format!("http://{}:{}/cast.mp3", local_ip(rx)?, http.local_addr()?.port());
    let sink: Sink = Arc::default();
    let s = sink.clone();
    thread::spawn(move || {
        for c in http.incoming().flatten() {
            let s = s.clone();
            // only the receiver gets the stream, not anyone else on the LAN
            if c.peer_addr().is_ok_and(|a| a.ip() == rx) {
                thread::spawn(move || serve_http(c, s));
            }
        }
    });

    let (title, artist) = (xml_escape(if device.is_empty() { kind } else { device }), xml_escape(kind));
    let didl = format!(
        r#"<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dc="http://purl.org/dc/elements/1.1/"><item id="1" parentID="0" restricted="1"><dc:title>{title}</dc:title><upnp:artist>{artist}</upnp:artist><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="http-get:*:audio/mpeg:*">{url}</res></item></DIDL-Lite>"#
    );
    soap(rx, "SetAVTransportURI", &format!("<InstanceID>0</InstanceID><CurrentURI>{url}</CurrentURI><CurrentURIMetaData>{}</CurrentURIMetaData>", xml_escape(&didl)))?;
    soap(rx, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>")?;

    let mut enc = Builder::new().ok_or_else(|| std::io::Error::other("lame init"))?;
    enc.set_num_channels(2).and_then(|_| enc.set_sample_rate(RATE)).and_then(|_| enc.set_brate(Bitrate::Kbps320))
        .and_then(|_| enc.set_quality(Quality::NearBest)).map_err(|e| std::io::Error::other(format!("{e:?}")))?;
    let mut enc = enc.build().map_err(|e| std::io::Error::other(format!("{e:?}")))?;
    let mut buf = vec![0u8; FRAMES * 4];
    let mut samples = vec![0i16; FRAMES * 2];
    let mut out = Vec::with_capacity(mp3lame_encoder::max_required_buffer_size(FRAMES));
    let (started, mut playing, mut gone) = (Instant::now(), false, None::<Instant>);
    while pcm.read_exact(&mut buf).is_ok() {
        for (d, b) in samples.iter_mut().zip(buf.chunks_exact(2)) {
            *d = i16::from_le_bytes([b[0], b[1]]);
        }
        out.clear();
        enc.encode_to_vec(InterleavedPcm(&samples), &mut out).map_err(|e| std::io::Error::other(format!("{e:?}")))?;
        let mut s = sink.lock().unwrap();
        // live audio: drop rather than queue behind a stalled client. Disconnected = the receiver hung up
        if s.as_ref().is_some_and(|tx| matches!(tx.try_send(out.clone()), Err(TrySendError::Disconnected(_)))) {
            *s = None;
        }
        let connected = s.is_some();
        drop(s);
        if connected != playing {
            playing = connected;
            gone = (!playing).then(Instant::now);
            if playing {
                on_event(Event::Playing(true));
            }
        }
        if gone.is_some_and(|t| t.elapsed() > GONE_GRACE) {
            on_event(Event::Playing(false));
            return Ok(()); // no Stop: the receiver may be playing someone else's cast now
        }
        if !playing && gone.is_none() && started.elapsed() > START_TIMEOUT {
            return Err(std::io::Error::other("the receiver didn't start playing"));
        }
    }
    out.clear();
    let _ = enc.flush_to_vec::<FlushNoGap>(&mut out);
    on_event(Event::Playing(false));
    if playing {
        soap(rx, "Stop", "<InstanceID>0</InstanceID>")?; // we stopped while it was still ours
    }
    Ok(())
}

fn serve_http(mut c: TcpStream, sink: Sink) {
    let mut req = Vec::new();
    let mut b = [0u8; 1024];
    while !req.windows(4).any(|w| w == b"\r\n\r\n") {
        match c.read(&mut b) {
            Ok(0) | Err(_) => return,
            Ok(n) => req.extend_from_slice(&b[..n]),
        }
    }
    let head = "HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\ntransferMode.dlna.org: Streaming\r\nConnection: close\r\n\r\n";
    if c.write_all(head.as_bytes()).is_err() || req.starts_with(b"HEAD") {
        return;
    }
    let (tx, rx) = sync_channel(64);
    *sink.lock().unwrap() = Some(tx); // newest client wins
    if c.write_all(&id3_padding(ID3_PADDING)).is_err() {
        return;
    }
    for chunk in rx {
        if c.write_all(&chunk).is_err() {
            return;
        }
    }
}

/// ID3v2.4 tag containing only padding; its size is a 28-bit "syncsafe" integer (7 bits per byte).
fn id3_padding(size: u32) -> Vec<u8> {
    let mut t = b"ID3\x04\x00\x00".to_vec();
    t.extend([21, 14, 7, 0].map(|s| ((size >> s) & 0x7f) as u8));
    t.resize(10 + size as usize, 0);
    t
}

/// The address the receiver can reach us on (no packet is sent).
fn local_ip(rx: IpAddr) -> std::io::Result<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0")?;
    s.connect((rx, 9))?;
    Ok(s.local_addr()?.ip())
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn soap(rx: IpAddr, action: &str, body: &str) -> std::io::Result<()> {
    let env = format!(
        r#"<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:{action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">{body}</u:{action}></s:Body></s:Envelope>"#
    );
    let mut s = TcpStream::connect((rx, 49154))?;
    write!(s, "POST /AVTransport/ctrl HTTP/1.1\r\nHost: {rx}:49154\r\nContent-Type: text/xml; charset=\"utf-8\"\r\nSOAPACTION: \"urn:schemas-upnp-org:service:AVTransport:1#{action}\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{env}", env.len())?;
    let mut status = String::new();
    BufReader::new(s).read_line(&mut status)?;
    if !status.contains(" 200 ") {
        return Err(std::io::Error::other(format!("{action}: {}", status.trim())));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_needs_the_token() {
        let ip: IpAddr = "192.0.2.10".parse().unwrap();
        assert_eq!(parse_hello("abc 192.0.2.10 My Phone\n", "abc").unwrap(), (ip, "My Phone".into()));
        assert_eq!(parse_hello("abc 192.0.2.10\n", "abc").unwrap(), (ip, "".into()));
        assert!(parse_hello("xyz 192.0.2.10 My Phone\n", "abc").is_err());
        assert!(parse_hello("192.0.2.10\n", "abc").is_err());
    }

    #[test]
    fn id3_padding_header() {
        let t = id3_padding(120_000);
        assert_eq!(t.len(), 120_010);
        assert_eq!(&t[..10], b"ID3\x04\x00\x00\x00\x07\x29\x40"); // 120000 = 7<<14 | 41<<7 | 64
    }

    // Casts what this Linux machine plays for 40 s: YXC_RX=<receiver ip> cargo test cast_pipewire -- --ignored
    #[test]
    #[ignore]
    #[cfg(target_os = "linux")]
    fn cast_pipewire() {
        let rx: IpAddr = std::env::var("YXC_RX").expect("YXC_RX").parse().unwrap();
        let mut rec = std::process::Command::new("pw-record")
            .args(["-P", "{ stream.capture.sink=true }", "--rate", "48000", "--channels", "2", "--format", "s16", "-"])
            .stdout(std::process::Stdio::piped()).spawn().unwrap();
        let pcm = rec.stdout.take().unwrap();
        let t = thread::spawn(move || run(pcm, rx, "test", "Computer audio", &|e| if let Event::Playing(p) = e { println!("playing: {p}") }));
        thread::sleep(Duration::from_secs(40));
        rec.kill().unwrap();
        t.join().unwrap().unwrap();
    }

    // Streams 20 s of beeps to the real receiver: YXC_RX=<receiver ip> cargo test cast_beeps -- --ignored
    #[test]
    #[ignore]
    fn cast_beeps() {
        serve("127.0.0.1:8770", "t".into(), |e| if let Event::Failed(e) = e { panic!("{e}") }).unwrap();
        let mut s = TcpStream::connect("127.0.0.1:8770").unwrap();
        s.write_all(format!("t {} test\n", std::env::var("YXC_RX").expect("YXC_RX")).as_bytes()).unwrap();
        let t0 = std::time::Instant::now();
        for n in 0..RATE as usize * 20 {
            let v = if n % RATE as usize > RATE as usize / 10 { 0 } else { ((n as f32 * 440.0 * std::f32::consts::TAU / RATE as f32).sin() * 3000.0) as i16 };
            s.write_all(&[v.to_le_bytes(), v.to_le_bytes()].concat()).unwrap();
            if n % 960 == 0 {
                // pace to real time, like a live capture
                let ahead = std::time::Duration::from_secs_f64(n as f64 / RATE as f64).saturating_sub(t0.elapsed());
                thread::sleep(ahead);
            }
        }
        drop(s);
        thread::sleep(std::time::Duration::from_secs(1));
    }
}
