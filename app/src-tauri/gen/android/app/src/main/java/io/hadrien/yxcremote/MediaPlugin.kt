package io.hadrien.yxcremote

import android.app.Activity
import android.app.AppOpsManager
import android.content.Intent
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
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
                name = a.getString("name", "") ?: "",
                port = a.getInteger("port", 0),
            )
            ContextCompat.startForegroundService(activity, intent.setAction(MediaService.ACTION_UPDATE))
        } else {
            MediaService.state = null
            activity.stopService(intent)
        }
        invoke.resolve()
    }

    // Rust forwards every receiver UDP event here, so the notification stays current while the webview sleeps
    @Command
    fun refresh(invoke: Invoke) {
        MediaService.instance?.refresh()
        invoke.resolve()
    }

    // Android skips its capture prompt when the "project media" app op was granted over adb:
    //   adb shell appops set io.hadrien.yxcremote PROJECT_MEDIA allow
    @Command
    fun castConsentNeeded(invoke: Invoke) {
        val ops = activity.getSystemService(AppOpsManager::class.java)
        val mode = ops.unsafeCheckOpNoThrow("android:project_media", android.os.Process.myUid(), activity.packageName)
        invoke.resolve(JSObject().put("needed", mode != AppOpsManager.MODE_ALLOWED))
    }

    @Command
    fun cast(invoke: Invoke) {
        val a = invoke.getArgs()
        if (a.getBoolean("on", false))
            activity.startActivity(Intent(activity, CastActivity::class.java)
                .putExtra("rx", a.getString("rx")).putExtra("token", a.getString("token")))
        else activity.stopService(Intent(activity, CastService::class.java))
        invoke.resolve()
    }
}
