package fr.maxence.meteo

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * L'appli complète, dans l'APK : l'interface (prévision 48 h, vent, 10 jours détaillés, sorties, mer, radars,
 * prévu vs réel, sources) est embarquée dans l'APK ; seules les données de prévision viennent d'Internet,
 * et le téléphone garde la dernière copie pour fonctionner hors ligne.
 */
class AppActivity : Activity() {

    private lateinit var web: WebView
    private var geoCallback: Pair<String, GeolocationPermissions.Callback>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AlertJob.schedule(this)
        web = WebView(this)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setGeolocationEnabled(true)
            mediaPlaybackRequiresUserGesture = true
        }
        web.addJavascriptInterface(Bridge(), "MeteoApp")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (request.url.host == HOST) serve(request.url) else null

            // Liens vers d'autres sites (bulletins, radars) : dans le navigateur du téléphone.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == HOST || !request.isForMainFrame) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                if (Position.granted(this@AppActivity)) callback.invoke(origin, true, false)
                else {
                    geoCallback = origin to callback
                    requestPermissions(arrayOf(android.Manifest.permission.ACCESS_COARSE_LOCATION), GEO)
                }
            }

            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.w(TAG, "Page : ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }
        setContentView(web)
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl("https://$HOST/index.html")
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != GEO) return
        val ok = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        geoCallback?.let { (origin, cb) -> cb.invoke(origin, ok, false) }
        geoCallback = null
    }

    @Deprecated("Bouton retour : ferme d'abord une page ouverte dans l'appli")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    /** Fichiers de l'interface depuis l'APK ; données de prévision depuis le site, avec copie hors ligne. */
    private fun serve(url: Uri): WebResourceResponse {
        val path = url.path.orEmpty().trimStart('/').ifEmpty { "index.html" }
        if (path.startsWith("data/") || path == "config.json") return remote(path)
        return try {
            WebResourceResponse(mime(path), "utf-8", assets.open("web/$path"))
        } catch (e: Exception) {
            notFound()
        }
    }

    private fun remote(path: String): WebResourceResponse {
        val copy = File(cacheDir, "web/" + path.replace('/', '_'))
        try {
            val conn = URL(MeteoData.siteUrl(this) + path + "?t=" + System.currentTimeMillis()).openConnection() as HttpURLConnection
            conn.connectTimeout = 10_000
            conn.readTimeout = 20_000
            conn.setRequestProperty("Cache-Control", "no-cache")
            try {
                if (conn.responseCode == 200) {
                    val body = conn.inputStream.use { it.readBytes() }
                    copy.parentFile?.mkdirs()
                    runCatching { copy.writeBytes(body) }
                    return WebResourceResponse(mime(path), "utf-8", ByteArrayInputStream(body))
                }
                if (conn.responseCode == 404) return notFound()
            } finally {
                conn.disconnect()
            }
        } catch (e: Exception) {
            Log.w(TAG, "Hors ligne pour $path : ${e.message}")
        }
        // Pas de réseau : dernière prévision reçue.
        return if (copy.exists()) WebResourceResponse(mime(path), "utf-8", copy.inputStream()) else notFound()
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private fun mime(path: String) = when (path.substringAfterLast('.')) {
        "html" -> "text/html"
        "js", "mjs" -> "text/javascript"
        "css" -> "text/css"
        "json", "webmanifest" -> "application/json"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        else -> "application/octet-stream"
    }

    inner class Bridge {
        @JavascriptInterface
        fun openSettings() {
            runOnUiThread { startActivity(Intent(this@AppActivity, MainActivity::class.java)) }
        }

        /** Appelé par la page une fois la prévision affichée (sert aussi à l'essai sur émulateur). */
        @JavascriptInterface
        fun ready(place: String, days: Int) {
            Log.i(TAG, "Appli affichée : $place, $days jours")
        }
    }

    companion object {
        private const val HOST = "appassets.androidplatform.net"
        private const val TAG = "Meteo"
        private const val GEO = 7
    }
}
