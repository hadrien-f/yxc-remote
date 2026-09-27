// Cast phone audio to the receiver (spike). The Kotlin capture service connects to `listen` over loopback,
// sends "<receiver ip>\n" then raw PCM (s16le, 48 kHz, stereo). We encode it to MP3 320 kbps, serve it over
// HTTP and tell the receiver to play it (DLNA AVTransport). Why MP3 and the ID3 padding: IMPLEMENTATION.md.
use mp3lame_encoder::{Bitrate, Builder, FlushNoGap, InterleavedPcm, Quality};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread;

const RATE: u32 = 48_000;
const FRAMES: usize = 1152; // one MP3 frame
// Fills the receiver's ~90 KB start threshold instantly; decoders skip ID3 tags, so it adds no delay
const ID3_PADDING: u32 = 120_000;

pub fn serve(listen: &str) -> std::io::Result<()> {
    let l = TcpListener::bind(listen)?;
    thread::spawn(move || {
        for pcm in l.incoming().flatten() {
            thread::spawn(move || {
                if let Err(e) = cast(pcm) {
                    eprintln!("cast: {e}");
                }
            });
        }
    });
    Ok(())
}

type Sink = Arc<Mutex<Option<SyncSender<Vec<u8>>>>>;

fn cast(pcm: TcpStream) -> std::io::Result<()> {
    let mut pcm = BufReader::new(pcm);
    let mut rx = String::new();
    pcm.read_line(&mut rx)?;
    let rx: IpAddr = rx.trim().parse().map_err(|_| std::io::Error::other("bad receiver ip"))?;

    let http = TcpListener::bind("0.0.0.0:0")?;
    let url = format!("http://{}:{}/cast.mp3", local_ip(rx)?, http.local_addr()?.port());
    let sink: Sink = Arc::default();
    let s = sink.clone();
    thread::spawn(move || {
        for c in http.incoming().flatten() {
            let s = s.clone();
            thread::spawn(move || serve_http(c, s));
        }
    });

    let didl = format!(
        r#"<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dc="http://purl.org/dc/elements/1.1/"><item id="1" parentID="0" restricted="1"><dc:title>Phone audio</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="http-get:*:audio/mpeg:*">{url}</res></item></DIDL-Lite>"#
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
    while pcm.read_exact(&mut buf).is_ok() {
        for (d, b) in samples.iter_mut().zip(buf.chunks_exact(2)) {
            *d = i16::from_le_bytes([b[0], b[1]]);
        }
        out.clear();
        enc.encode_to_vec(InterleavedPcm(&samples), &mut out).map_err(|e| std::io::Error::other(format!("{e:?}")))?;
        if let Some(tx) = sink.lock().unwrap().as_ref() {
            let _ = tx.try_send(out.clone()); // live audio: drop rather than queue behind a stalled client
        }
    }
    out.clear();
    let _ = enc.flush_to_vec::<FlushNoGap>(&mut out);
    soap(rx, "Stop", "<InstanceID>0</InstanceID>")?;
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
    fn id3_padding_header() {
        let t = id3_padding(120_000);
        assert_eq!(t.len(), 120_010);
        assert_eq!(&t[..10], b"ID3\x04\x00\x00\x00\x07\x29\x40"); // 120000 = 7<<14 | 41<<7 | 64
    }

    // Streams 20 s of beeps to the real receiver: YXC_RX=<receiver ip> cargo test cast_beeps -- --ignored
    #[test]
    #[ignore]
    fn cast_beeps() {
        serve("127.0.0.1:8770").unwrap();
        let mut s = TcpStream::connect("127.0.0.1:8770").unwrap();
        s.write_all(format!("{}\n", std::env::var("YXC_RX").expect("YXC_RX")).as_bytes()).unwrap();
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
