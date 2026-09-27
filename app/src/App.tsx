import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Container, Group, Modal, Stack, Text, Title } from "@mantine/core";
import { useLocalStorage } from "@mantine/hooks";
import {
  addFavorite, albumArtUrl, cast, castAvailable, CAST_INPUT, CAST_TITLE, discover, getFavorites, getInputs, getPlayInfo, getRecents, getStatus, getTunerPlayInfo, Input, Item, PlayInfo,
  inTauri, mediaUpdate, onCastError, onReceiverEvent, pushEnabled, recallFavorite, recallRecent, Receiver, selectInput, setMute, setPlayback, setMaxVolume, setPower, setReceiverHost, setVolume, Status, transportCaps, DEFAULT_MAX_VOLUME,
} from "./yxc";
import { InputsSheet, NowPlaying, PowerButton, QuickRow, ReceiverSheet, StationsSheet, Transport, VolumeSlider } from "./components";

// With UDP push, polling is only a safety net for lost datagrams; a browser has no UDP, so it polls fast
const POLL_MS = pushEnabled ? 10_000 : 2000;
const PUSH_DEBOUNCE_MS = 200; // an input switch sends a ~3 s burst of events: refresh once it settles
const QUICK_STATIONS = 6;

const toggle = (id: string) => (list: string[]) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [play, setPlay] = useState<PlayInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [castError, setCastError] = useState<string | null>(null); // separate: refresh() clears `error`
  const [inputs, setInputs] = useState<Input[]>([]);
  const [favorites, setFavorites] = useState<Item[]>([]);
  const [recents, setRecents] = useState<Item[]>([]);
  const [sheet, setSheet] = useState<"inputs" | "stations" | "receiver" | "cast" | null>(null);
  const [receiver, setReceiver] = useLocalStorage<Receiver | null>({
    key: "receiver",
    defaultValue: null,
    getInitialValueInEffect: false,
  });
  const [found, setFound] = useState<Receiver[]>([]);
  const [scanning, setScanning] = useState(false);
  if (receiver) setReceiverHost(receiver.ip);
  const [maxVolume, setMaxVolumePref] = useLocalStorage({ key: "maxVolume", defaultValue: DEFAULT_MAX_VOLUME, getInitialValueInEffect: false });
  setMaxVolume(maxVolume);
  // In a browser the Vite proxy picks the receiver, so there is nothing to choose
  const ready = !inTauri || !!receiver;
  // Per-phone preferences (the receiver can't store favorite inputs)
  const [pinned, setPinned] = useLocalStorage<string[]>({ key: "pinnedInputs", defaultValue: [] });
  const [hidden, setHidden] = useLocalStorage<string[]>({ key: "hiddenInputs", defaultValue: [] });

  // Scan the LAN: one receiver is picked automatically, several open the chooser
  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const list = await discover();
      setFound(list);
      if (list.length === 1) setReceiver(list[0]);
      else setSheet("receiver");
    } catch (e) {
      setError(String(e));
      setSheet("receiver");
    } finally {
      setScanning(false);
    }
  }, [setReceiver]);

  // First launch: no saved receiver yet
  useEffect(() => {
    if (!ready) scan();
  }, [ready, scan]);

  useEffect(() => {
    if (ready) getInputs().then(setInputs, (e) => setError(String(e)));
  }, [ready, receiver?.ip]);

  // Saved receiver unreachable (new IP from DHCP?): rescan once per session
  const rescanned = useRef(false);

  const refresh = useCallback(async () => {
    if (!ready) return;
    try {
      const s = await getStatus();
      const type = inputs.find((i) => i.id === s.input)?.playInfoType;
      setStatus(s);
      setPlay(s.power !== "on" ? null : type === "netusb" ? await getPlayInfo() : type === "tuner" ? await getTunerPlayInfo() : null);
      setError(null);
    } catch (e) {
      setError(String(e));
      if (inTauri && !rescanned.current) {
        rescanned.current = true;
        scan();
      }
    }
  }, [inputs, ready, scan]);

  useEffect(() => {
    refresh();
    const id = setInterval(() => !document.hidden && refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unlisten = onReceiverEvent(() => {
      clearTimeout(timer);
      timer = setTimeout(() => latestRefresh.current(), PUSH_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      unlisten.then((f) => f());
    };
  }, []);

  const act = (cmd: () => Promise<unknown>) =>
    cmd().catch((e) => setError(String(e))).then(refresh);

  const on = status?.power === "on";
  // netusb play info can lag behind an input switch: only trust it when it names the current input
  const current = play && play.input === status?.input ? play : null;
  const radio = status?.input === "net_radio";
  // the receiver keeps showing our title after a cast ends, so only "play" counts
  const casting = status?.input === "server" && current?.track === CAST_TITLE && current.playback === "play";
  const currentInput = casting ? CAST_INPUT.id : status?.input;
  // Another input picked, or stop pressed on the receiver: end the capture too
  useEffect(() => {
    const unlisten = onCastError(setCastError);
    return () => void unlisten.then((f) => f());
  }, []);
  const wasCasting = useRef(false);
  useEffect(() => {
    if (wasCasting.current && !casting) cast(false, "").catch(() => {});
    wasCasting.current = casting;
  }, [casting]);
  const station = current?.artist ?? ""; // net radio puts the station name in "artist"

  // Stations only change when the station does, no need to poll them
  const loadStations = useCallback(() => {
    getFavorites().then(setFavorites, () => {});
    getRecents().then((r) => setRecents(r.filter((x) => x.input === "net_radio")), () => {});
  }, []);
  useEffect(() => {
    if (radio) loadStations();
  }, [radio, station, loadStations]);

  const favorite = () =>
    act(async () => {
      if ((await addFavorite()) === null) throw new Error("All 40 favorite slots are used");
      loadStations();
    });

  // Favorites first, then recently played stations not already favorites
  const quickStations = [
    ...favorites.map((f) => ({ ...f, recall: () => recallFavorite(f.num) })),
    ...recents.filter((r) => !favorites.some((f) => f.text === r.text)).map((r) => ({ ...r, recall: () => recallRecent(r.num) })),
  ].slice(0, QUICK_STATIONS);

  const allInputs = castAvailable && receiver ? [CAST_INPUT, ...inputs] : inputs; // first: the feature the official app lacks
  const pinnedInputs = allInputs.filter((i) => pinned.includes(i.id));
  const choose = (id: string) =>
    id === CAST_INPUT.id ? !casting && setSheet("cast") : act(() => selectInput(id));

  // Mirror the screen into the Android media notification; only push when something changed
  const caps = transportCaps(current?.attribute ?? 0);
  const media = JSON.stringify({
    on: !!receiver && on,
    host: receiver?.ip ?? "",
    title: current?.track || status?.input_text || "",
    artist: current?.artist || receiver?.name || "",
    art: current ? albumArtUrl(current) : "",
    volume: status?.volume ?? 0,
    max: maxVolume,
    playing: current?.playback === "play",
    pauseCmd: caps.pause ? "pause" : caps.stop ? "stop" : null,
    canPlay: caps.play,
  });
  useEffect(() => {
    if (status) mediaUpdate(JSON.parse(media)).catch((e) => console.warn("media_update failed", e));
  }, [media, !!status]);

  return (
    <Container size="xs" p="md">
      <Stack gap="lg">
        <Group justify="space-between">
          {inTauri ? (
            <Button variant="subtle" size="compact-xl" px={0} data-testid="receiver" onClick={() => setSheet("receiver")}>
              {receiver?.name ?? "Find receiver"} ▾
            </Button>
          ) : (
            <Title order={2}>YXC Remote</Title>
          )}
          {status && <PowerButton on={on} onToggle={() => act(() => setPower(!on))} />}
        </Group>
        {error && <Alert color="red" title="Receiver unreachable">{error}</Alert>}
        {castError && <Alert color="red" title="Casting failed" withCloseButton onClose={() => setCastError(null)}>{castError}</Alert>}
        {status && !on && <Text c="dimmed">Receiver in standby</Text>}
        {!ready && <Text c="dimmed">{scanning ? "Searching for your receiver…" : "No receiver selected"}</Text>}
        {status && on && (
          <>
            <QuickRow
              label="Pinned inputs"
              items={pinnedInputs.map((i) => ({
                key: i.id,
                text: i.name,
                active: i.id === currentInput,
                onClick: () => choose(i.id),
              }))}
              more={{ text: "Inputs ▾", onClick: () => setSheet("inputs") }}
            />
            <NowPlaying
              inputText={status.input_text}
              play={current}
              isFavorite={radio && favorites.some((f) => f.text === station)}
              onFavorite={radio && current ? favorite : undefined}
              onStations={radio ? () => setSheet("stations") : undefined}
            />
            {radio && quickStations.length > 0 && (
              <QuickRow
                label="Favorite stations"
                items={quickStations.map((s) => ({
                  key: `${s.num}${s.text}`,
                  text: s.text.replace(/\s*\(.*\)$/, ""), // "Rinse France (Paris/English)" → "Rinse France"
                  active: s.text === station,
                  onClick: () => act(s.recall),
                }))}
              />
            )}
            {current && <Transport play={current} onCommand={(p) => act(() => setPlayback(p))} />}
            <VolumeSlider
              value={status.volume}
              max={maxVolume}
              muted={status.mute}
              onCommit={(v) => act(() => setVolume(v))}
              onMute={() => act(() => setMute(!status.mute))}
            />
            <InputsSheet
              opened={sheet === "inputs"}
              onClose={() => setSheet(null)}
              inputs={allInputs}
              pinned={pinned}
              hidden={hidden}
              current={currentInput ?? ""}
              onSelect={choose}
              onTogglePin={(id) => setPinned(toggle(id))}
              onToggleHidden={(id) => setHidden(toggle(id))}
            />
            {/* Before Android's capture prompt: what it is and what to pick */}
            <Modal opened={sheet === "cast"} onClose={() => setSheet(null)} title="Cast phone audio" centered>
              <Stack>
                <Text>Plays your phone's sound on the receiver.</Text>
                <Text>
                  Android will ask to share your screen. Choose <b>Entire screen</b> so you can switch apps. Only the sound is sent.
                </Text>
                <Button onClick={() => { setSheet(null); setCastError(null); act(() => cast(true, receiver!.ip)); }}>Continue</Button>
              </Stack>
            </Modal>
            <StationsSheet
              opened={sheet === "stations"}
              onClose={() => setSheet(null)}
              favorites={favorites}
              recents={recents}
              playing={station}
              onFavorite={(n) => act(() => recallFavorite(n))}
              onRecent={(n) => act(() => recallRecent(n))}
            />
          </>
        )}
        <ReceiverSheet
          opened={sheet === "receiver"}
          onClose={() => setSheet(null)}
          found={found}
          scanning={scanning}
          onScan={scan}
          maxVolume={maxVolume}
          onMaxVolume={setMaxVolumePref}
          onChoose={(r) => {
            setReceiver(r);
            setStatus(null);
            setSheet(null);
          }}
        />
      </Stack>
    </Container>
  );
}
