package io.hadrien.yxcremote

// ponytail: throwaway spike (branch spike/cast-capture). Captures what other apps play and streams raw
// PCM (s16le, 48 kHz, stereo) over loopback to the app's Rust side (src/cast.rs: MP3 + HTTP + DLNA).
// The app must be open (Rust listens on 127.0.0.1:8770 once it has started). Not for main.
//   start: adb shell am start -n <pkg>/io.hadrien.yxcremote.CastSpikeActivity --es rx <receiver ip>
//   stop:  adb shell am start -n <pkg>/io.hadrien.yxcremote.CastSpikeActivity --ez stop true

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import java.net.InetSocketAddress
import java.net.Socket
import kotlin.math.abs

private const val TAG = "CastSpike"

class CastSpikeActivity : Activity() {
    private var rx = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (intent.getBooleanExtra("stop", false) || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            stopService(Intent(this, CastSpikeService::class.java)); finish(); return
        }
        rx = intent.getStringExtra("rx") ?: run { Log.e(TAG, "missing --es rx <receiver ip>"); finish(); return }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS), 1)
        else askProjection()
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) askProjection()
        else { Log.e(TAG, "RECORD_AUDIO denied"); finish() }
    }

    private fun askProjection() =
        startActivityForResult(getSystemService(MediaProjectionManager::class.java).createScreenCaptureIntent(), 2)

    @Deprecated("spike")
    override fun onActivityResult(code: Int, result: Int, data: Intent?) {
        if (result == RESULT_OK && data != null)
            startForegroundService(Intent(this, CastSpikeService::class.java)
                .putExtra("rx", rx).putExtra("result", result).putExtra("data", data))
        else Log.e(TAG, "projection consent refused")
        finish()
    }
}

class CastSpikeService : Service() {
    @Volatile private var running = false
    private var projection: MediaProjection? = null

    override fun onBind(i: Intent?): IBinder? = null

    @SuppressLint("MissingPermission")
    override fun onStartCommand(intent: Intent, flags: Int, startId: Int): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || running) return START_NOT_STICKY
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel("cast", "Cast spike", NotificationManager.IMPORTANCE_LOW))
        val n = NotificationCompat.Builder(this, "cast").setSmallIcon(R.drawable.ic_stat_speaker)
            .setContentTitle("Casting phone audio (spike)").setOngoing(true).build()
        // Android 14+: the mediaProjection foreground service must be running before getMediaProjection()
        ServiceCompat.startForeground(this, 2, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)

        @Suppress("DEPRECATION") val data = intent.getParcelableExtra<Intent>("data")!!
        val p = getSystemService(MediaProjectionManager::class.java).getMediaProjection(intent.getIntExtra("result", 0), data)!!
        p.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() { Log.i(TAG, "projection stopped by system/user"); running = false }
        }, null)
        projection = p
        val rx = intent.getStringExtra("rx")!!

        val capture = AudioPlaybackCaptureConfiguration.Builder(p)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN).build()
        val fmt = AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(48000)
            .setChannelMask(AudioFormat.CHANNEL_IN_STEREO).build()
        val chunk = 48000 / 50 * 4  // 20 ms
        val rec = AudioRecord.Builder().setAudioFormat(fmt).setAudioPlaybackCaptureConfig(capture)
            .setBufferSizeInBytes(maxOf(chunk * 4, AudioRecord.getMinBufferSize(48000, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)))
            .build()

        running = true
        Thread {
            try {
                Socket().use { s ->
                    s.tcpNoDelay = true
                    s.connect(InetSocketAddress("127.0.0.1", 8770), 3000)
                    Log.i(TAG, "casting to $rx, recording")
                    val out = s.getOutputStream(); val buf = ByteArray(chunk)
                    out.write("$rx\n".toByteArray())
                    rec.startRecording()
                    var sent = 0L; var peak = 0; var t = System.currentTimeMillis()
                    while (running) {
                        val n = rec.read(buf, 0, buf.size)
                        if (n <= 0) { Log.w(TAG, "read=$n"); continue }
                        out.write(buf, 0, n); sent += n
                        for (i in 0 until n step 4) peak = maxOf(peak, abs((buf[i + 1].toInt() shl 8) or (buf[i].toInt() and 0xff)))
                        if (System.currentTimeMillis() - t > 5000) {
                            // peak 0 = capture is silent (nothing playing, app opted out, or muted before capture)
                            Log.i(TAG, "sent ${sent / 192000}s of audio, peak last 5s = $peak/32767"); peak = 0; t = System.currentTimeMillis()
                        }
                    }
                }
            } catch (e: Exception) { Log.e(TAG, "stream ended: $e") }
            rec.stop(); rec.release(); stopSelf()
        }.start()
        return START_NOT_STICKY
    }

    override fun onDestroy() { running = false; projection?.stop() }
}
