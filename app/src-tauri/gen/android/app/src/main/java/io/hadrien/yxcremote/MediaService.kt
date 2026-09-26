package io.hadrien.yxcremote

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.media.VolumeProviderCompat
import androidx.media.app.NotificationCompat.MediaStyle
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

// Media notification + lock screen controls + phone volume keys, for a receiver we only remote-control.
// A remote VolumeProvider is what makes the hardware volume keys drive the receiver instead of the phone.
class MediaService : Service() {
    data class State(
        val host: String,
        val title: String,
        val artist: String,
        val art: String,
        val volume: Int,
        val max: Int, // user's safety cap (raw 0–161), set in the app
        val playing: Boolean,
        val pauseCmd: String?, // YXC command that pauses this source ("pause", or "stop" for net radio); null if none
        val canPlay: Boolean,
    ) {
        val toggleCmd get() = if (playing) pauseCmd else "play".takeIf { canPlay }
        val canToggle get() = pauseCmd != null || canPlay
    }

    companion object {
        const val SLIDER_STEPS = 100L // the progress bar is a 0–100 % volume slider (Android labels it as 0:00–1:40)
        const val ACTION_UPDATE = "update"
        const val VOL_UP = "vol_up"
        const val VOL_DOWN = "vol_down"
        const val TOGGLE = "toggle"
        private const val CHANNEL = "controls"

        @Volatile
        var state: State? = null
    }

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var session: MediaSessionCompat
    private var volume: VolumeProviderCompat? = null
    private var artUrl = ""
    private var art: Bitmap? = null

    override fun onBind(intent: Intent?) = null

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Receiver controls", NotificationManager.IMPORTANCE_LOW),
            )
        }
        session = MediaSessionCompat(this, "yxc-remote").apply {
            setSessionActivity(openApp())
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() = toggle()
                override fun onPause() = toggle()
                override fun onStop() = toggle()
                override fun onCustomAction(action: String, extras: Bundle?) = handle(action)
                override fun onSeekTo(pos: Long) {
                    val max = state?.max ?: return
                    setVolume((pos * max / (SLIDER_STEPS * 1000)).toInt())
                }
            })
            isActive = true
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.action?.let(::handle)
        render()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        session.release()
        io.shutdown()
        super.onDestroy()
    }

    private fun handle(action: String) = when (action) {
        VOL_UP -> setVolume((state?.volume ?: 0) + 1)
        VOL_DOWN -> setVolume((state?.volume ?: 0) - 1)
        TOGGLE -> toggle()
        else -> Unit
    }

    private fun setVolume(v: Int) {
        android.util.Log.d("YxcMedia", "setVolume $v (was ${state?.volume})")
        val s = state ?: return
        val clamped = v.coerceIn(0, s.max)
        state = s.copy(volume = clamped)
        send(s.host, "main/setVolume?volume=$clamped")
        render()
    }

    private fun toggle() {
        val s = state ?: return
        val cmd = s.toggleCmd ?: return
        state = s.copy(playing = cmd == "play")
        send(s.host, "netusb/setPlayback?playback=$cmd")
        render()
    }

    // ponytail: fire-and-forget GET; the web UI re-syncs the real state on the next UDP event or poll
    private fun send(host: String, path: String) = io.execute {
        runCatching {
            (URL("http://$host/YamahaExtendedControl/v1/$path").openConnection() as HttpURLConnection).run {
                connectTimeout = 3000
                readTimeout = 3000
                inputStream.close()
                disconnect()
            }
        }
    }

    private fun render() {
        val s = state ?: return stopSelf()
        remoteVolume(s.max).currentVolume = s.volume.coerceIn(0, s.max)
        loadArt(s.art)

        session.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, s.title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, s.artist)
                .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, SLIDER_STEPS * 1000)
                .build(),
        )
        // Android 10+ media controls: the progress bar is the volume slider (position = % of the cap, speed 0 so it
        // never advances). Android 13+ builds its controls from this session state only.
        val percent = if (s.max > 0) s.volume * SLIDER_STEPS / s.max else 0
        val toggle = if (s.canToggle) PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE else 0
        session.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setState(
                    if (s.playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
                    percent * 1000,
                    0f,
                )
                .setActions(toggle or PlaybackStateCompat.ACTION_SEEK_TO)
                .build(),
        )

        // Android 7–12 show the notification's own actions (no slider before 10): keep −/+ there
        val b = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_speaker)
            .setContentTitle(s.title)
            .setContentText(s.artist)
            .setLargeIcon(art)
            .setContentIntent(openApp())
            .setOngoing(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(R.drawable.ic_vol_down, "Volume down", pending(VOL_DOWN))
        if (s.canToggle) {
            val icon = if (s.playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
            b.addAction(icon, "Play/pause", pending(TOGGLE))
        }
        b.addAction(R.drawable.ic_vol_up, "Volume up", pending(VOL_UP))
        val compact = if (s.canToggle) intArrayOf(0, 1, 2) else intArrayOf(0, 1)
        b.setStyle(MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(*compact))

        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0
        ServiceCompat.startForeground(this, 1, b.build(), type)
    }

    // Phone volume keys drive the receiver through this; recreated when the user changes the cap
    private fun remoteVolume(max: Int): VolumeProviderCompat {
        volume?.takeIf { it.maxVolume == max }?.let { return it }
        return object : VolumeProviderCompat(VOLUME_CONTROL_ABSOLUTE, max, 0) {
            override fun onSetVolumeTo(v: Int) = setVolume(v)

            // Each key press sends ±1, then 0 ("just show the volume panel"): skip the 0
            override fun onAdjustVolume(direction: Int) {
                if (direction != 0) setVolume((state?.volume ?: currentVolume) + direction)
            }
        }.also {
            volume = it
            session.setPlaybackToRemote(it)
        }
    }

    private fun loadArt(url: String) {
        if (url == artUrl) return
        artUrl = url
        art = null
        if (url.isEmpty()) return
        io.execute {
            val bmp = runCatching { URL(url).openStream().use(BitmapFactory::decodeStream) }.getOrNull()
            main.post {
                if (artUrl == url) {
                    art = bmp
                    render()
                }
            }
        }
    }

    private fun openApp() = PendingIntent.getActivity(
        this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_IMMUTABLE,
    )

    private fun pending(action: String) = PendingIntent.getService(
        this, action.hashCode(), Intent(this, MediaService::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE,
    )
}
