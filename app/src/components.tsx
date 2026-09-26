import { useState } from "react";
import { ActionIcon, Button, Card, Drawer, Group, Image, NavLink, ScrollArea, Slider, Stack, Text, TextInput, Title } from "@mantine/core";
import { albumArtUrl, Input, Receiver, Item, Playback, PlayInfo, transportCaps, VOLUME_CEILING, volumeToDb } from "./yxc";

export function NowPlaying({ inputText, play, isFavorite, onFavorite, onStations }: {
  inputText: string;
  play: PlayInfo | null;
  isFavorite?: boolean;
  onFavorite?: () => void;
  onStations?: () => void;
}) {
  const art = play && albumArtUrl(play);
  return (
    <Card withBorder radius="lg" padding="lg">
      {art && (
        <Card.Section>
          <Image src={art} alt="Album art" fit="contain" h={280} bg="dark.8" />
        </Card.Section>
      )}
      <Group justify="space-between" mt={art ? "md" : 0}>
        <Group gap="xs">
          <Text size="xs" c="dimmed" tt="uppercase">{inputText}</Text>
          {onStations && (
            <Button variant="light" size="compact-sm" onClick={onStations}>
              Stations ▾
            </Button>
          )}
        </Group>
        {onFavorite && (
          <ActionIcon
            variant="subtle"
            size="lg"
            aria-label={isFavorite ? "Favorite" : "Add to favorites"}
            disabled={isFavorite}
            onClick={onFavorite}
          >
            {isFavorite ? "★" : "☆"}
          </ActionIcon>
        )}
      </Group>
      {play && (
        <>
          <Title order={3} data-testid="track">{play.track || "—"}</Title>
          <Text data-testid="artist">{play.artist}</Text>
          {play.album && <Text c="dimmed">{play.album}</Text>}
        </>
      )}
    </Card>
  );
}

// Shows dB, sends raw 0–161. Local drag value wins over polled value until the command lands.
export function VolumeSlider({ value, max, muted, onCommit, onMute }: {
  value: number;
  max: number;
  muted: boolean;
  onCommit: (v: number) => Promise<unknown>;
  onMute: () => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const v = drag ?? value;
  return (
    <Stack gap="xs">
      <Group justify="space-between">
        <Button size="compact-md" variant={muted ? "filled" : "default"} color={muted ? "red" : undefined} onClick={onMute}>
          {muted ? "Muted" : "Mute"}
        </Button>
        <Text fw={700} data-testid="volume-db" td={muted ? "line-through" : undefined}>
          {volumeToDb(v).toFixed(1)} dB
        </Text>
      </Group>
      <Slider
        thumbLabel="Volume"
        size="xl"
        thumbSize={28}
        min={0}
        max={max}
        label={null}
        value={v}
        onChange={setDrag}
        onChangeEnd={async (x) => {
          await onCommit(x);
          setDrag(null);
        }}
      />
    </Stack>
  );
}

export function PowerButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <Button size="lg" radius="xl" variant={on ? "light" : "filled"} data-testid="power" onClick={onToggle}>
      {on ? "Standby" : "Power on"}
    </Button>
  );
}

// Inline SVG paths (24×24): unicode media glyphs render as colour emoji on Android
const ICONS: Record<Playback, string> = {
  previous: "M6 5h2v14H6zM20 5v14L9 12z",
  play: "M8 5v14l11-7z",
  pause: "M6 5h4v14H6zM14 5h4v14h-4z",
  stop: "M6 6h12v12H6z",
  next: "M16 5h2v14h-2zM4 5v14l11-7z",
};

// Only shows what the current source supports (net radio: play/stop, no skip)
export function Transport({ play, onCommand }: { play: PlayInfo; onCommand: (p: Playback) => void }) {
  const caps = transportCaps(play.attribute);
  const playing = play.playback === "play";
  const main: Playback | null = !playing ? (caps.play ? "play" : null) : caps.pause ? "pause" : caps.stop ? "stop" : null;
  const buttons = [caps.previous && "previous", main, caps.next && "next"].filter(Boolean) as Playback[];
  return (
    <Group justify="center" gap="xl">
      {buttons.map((b) => (
        <ActionIcon key={b} aria-label={b} size={b === main ? 64 : 48} radius="xl" variant={b === main ? "filled" : "light"} onClick={() => onCommand(b)}>
          <svg viewBox="0 0 24 24" width={b === main ? 32 : 24} height={b === main ? 32 : 24} fill="currentColor" aria-hidden>
            <path d={ICONS[b]} />
          </svg>
        </ActionIcon>
      ))}
    </Group>
  );
}

// Horizontal row of big buttons: pinned inputs, or favorite stations. The optional "more" button stays put, first.
export function QuickRow({ label, items, more }: {
  label: string;
  items: { key: string; text: string; active: boolean; onClick: () => void }[];
  more?: { text: string; onClick: () => void };
}) {
  return (
    <Group gap="xs" wrap="nowrap">
      {more && (
        <Button radius="xl" flex="none" variant="light" onClick={more.onClick}>
          {more.text}
        </Button>
      )}
      <ScrollArea type="never" aria-label={label}>
        <Group gap="xs" wrap="nowrap">
          {items.map((i) => (
            <Button key={i.key} radius="xl" flex="none" variant={i.active ? "filled" : "default"} onClick={i.onClick}>
              {i.text}
            </Button>
          ))}
        </Group>
      </ScrollArea>
    </Group>
  );
}

function SourceRow({ label, description, art, active, onClick, right }: {
  label: string;
  description?: string;
  art?: string;
  active?: boolean;
  onClick?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <NavLink
      label={label}
      description={description}
      active={active}
      onClick={onClick}
      leftSection={art ? <Image src={art} w={40} h={40} radius="sm" alt="" /> : undefined}
      rightSection={right}
      py="sm"
    />
  );
}

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <Text size="xs" c="dimmed" tt="uppercase" mt="md">{children}</Text>
);

// Pinned inputs first, then the rest; Edit mode toggles pin and visibility per input
export function InputsSheet({ opened, onClose, inputs, pinned, hidden, current, onSelect, onTogglePin, onToggleHidden }: {
  opened: boolean;
  onClose: () => void;
  inputs: Input[];
  pinned: string[];
  hidden: string[];
  current: string;
  onSelect: (id: string) => void;
  onTogglePin: (id: string) => void;
  onToggleHidden: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const sorted = [...inputs.filter((i) => pinned.includes(i.id)), ...inputs.filter((i) => !pinned.includes(i.id))];
  return (
    <Drawer opened={opened} onClose={onClose} position="bottom" size="85%" title="Inputs" radius="lg">
      <Group justify="flex-end">
        <Button size="compact-sm" variant="subtle" onClick={() => setEditing(!editing)}>
          {editing ? "Done" : "Edit"}
        </Button>
      </Group>
      {sorted
        .filter((i) => editing || !hidden.includes(i.id))
        .map((i) =>
          editing ? (
            <SourceRow
              key={i.id}
              label={i.name}
              right={
                <Group gap={4}>
                  <ActionIcon variant={pinned.includes(i.id) ? "filled" : "default"} aria-label={`Pin ${i.name}`} onClick={() => onTogglePin(i.id)}>
                    📌
                  </ActionIcon>
                  <ActionIcon variant={hidden.includes(i.id) ? "default" : "light"} aria-label={`Show ${i.name}`} onClick={() => onToggleHidden(i.id)}>
                    {hidden.includes(i.id) ? "–" : "👁"}
                  </ActionIcon>
                </Group>
              }
            />
          ) : (
            <SourceRow
              key={i.id}
              label={i.name}
              description={pinned.includes(i.id) ? "pinned" : undefined}
              active={i.id === current}
              onClick={() => {
                onSelect(i.id);
                onClose();
              }}
            />
          ),
        )}
    </Drawer>
  );
}

// Net radio only: favorites (device presets) and recently played stations
export function StationsSheet({ opened, onClose, favorites, recents, playing, onFavorite, onRecent }: {
  opened: boolean;
  onClose: () => void;
  favorites: Item[];
  recents: Item[];
  playing: string;
  onFavorite: (num: number) => void;
  onRecent: (num: number) => void;
}) {
  const pick = (fn: () => void) => {
    fn();
    onClose();
  };
  return (
    <Drawer opened={opened} onClose={onClose} position="bottom" size="85%" title="Stations" radius="lg">
      <SectionTitle>Favorites</SectionTitle>
      {favorites.length === 0 && <Text c="dimmed" size="sm" py="xs">No favorites yet: tap ☆ on what's playing</Text>}
      {favorites.map((f) => (
        <SourceRow key={`f${f.num}`} label={f.text} active={f.text === playing} onClick={() => pick(() => onFavorite(f.num))} />
      ))}
      <SectionTitle>Recent</SectionTitle>
      {/* ponytail: first 8 of the device's 40, add "show more" if needed */}
      {recents.slice(0, 8).map((r) => (
        <SourceRow key={`r${r.num}`} label={r.text} art={r.albumart_url} active={r.text === playing} onClick={() => pick(() => onRecent(r.num))} />
      ))}
    </Drawer>
  );
}

// Found receivers, rescan, or type an IP by hand
export function ReceiverSheet({ opened, onClose, found, scanning, onScan, onChoose, maxVolume, onMaxVolume }: {
  opened: boolean;
  onClose: () => void;
  found: Receiver[];
  scanning: boolean;
  onScan: () => void;
  onChoose: (r: Receiver) => void;
  maxVolume: number;
  onMaxVolume: (v: number) => void;
}) {
  const [ip, setIp] = useState("");
  const validIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
  return (
    <Drawer opened={opened} onClose={onClose} position="bottom" size="60%" title="Receiver" radius="lg">
      <Button fullWidth variant="light" loading={scanning} onClick={onScan}>
        Search the network
      </Button>
      {!scanning && found.length === 0 && <Text c="dimmed" size="sm" py="xs">No receiver found</Text>}
      {found.map((r) => (
        <SourceRow key={r.ip} label={r.name} description={`${r.model} · ${r.ip}`} onClick={() => onChoose(r)} />
      ))}
      <SectionTitle>Manual</SectionTitle>
      <Group mt="xs" wrap="nowrap">
        <TextInput flex={1} placeholder="192.168.1.20" inputMode="decimal" value={ip} onChange={(e) => setIp(e.currentTarget.value.trim())} aria-label="Receiver IP" />
        <Button disabled={!validIp} onClick={() => onChoose({ ip, model: "", name: ip })}>
          Connect
        </Button>
      </Group>
      <SectionTitle>Maximum volume</SectionTitle>
      <Text size="sm" c="dimmed">Caps the app, the notification and the phone's volume keys: {volumeToDb(maxVolume).toFixed(1)} dB</Text>
      <Slider
        mt="md"
        mb="xl"
        thumbLabel="Maximum volume"
        min={60}
        max={VOLUME_CEILING}
        value={maxVolume}
        onChange={onMaxVolume}
        label={(v) => `${volumeToDb(v).toFixed(1)} dB`}
        marks={[{ value: 130, label: "default" }, { value: VOLUME_CEILING, label: "0 dB" }]}
      />
    </Drawer>
  );
}
