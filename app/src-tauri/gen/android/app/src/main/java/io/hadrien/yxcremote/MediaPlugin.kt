package io.hadrien.yxcremote

import android.app.Activity
import android.content.Intent
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

// Bridge from the webview (via the Rust `media_update` command) to MediaService.
// The web UI stays the source of truth: it pushes what is playing, the service mirrors it.
@TauriPlugin
class MediaPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun update(invoke: Invoke) {
        val a = invoke.getArgs()
        val intent = Intent(activity, MediaService::class.java)
        if (a.getBoolean("on", false)) {
            MediaService.state = MediaService.State(
                host = a.getString("host"),
                title = a.getString("title", "") ?: "",
                artist = a.getString("artist", "") ?: "",
                art = a.getString("art", "") ?: "",
                volume = a.getInteger("volume", 0),
                max = a.getInteger("max", 130),
                playing = a.getBoolean("playing", false),
                pauseCmd = a.getString("pauseCmd", null),
                canPlay = a.getBoolean("canPlay", false),
            )
            ContextCompat.startForegroundService(activity, intent.setAction(MediaService.ACTION_UPDATE))
        } else {
            MediaService.state = null
            activity.stopService(intent)
        }
        invoke.resolve()
    }

    @Command
    fun cast(invoke: Invoke) {
        val a = invoke.getArgs()
        if (a.getBoolean("on", false))
            activity.startActivity(Intent(activity, CastActivity::class.java).putExtra("rx", a.getString("rx")))
        else activity.stopService(Intent(activity, CastService::class.java))
        invoke.resolve()
    }
}
