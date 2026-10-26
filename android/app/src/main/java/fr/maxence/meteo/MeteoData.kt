package fr.maxence.meteo

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Lecture du résumé publié par l'appli (widget.json) et cache local pour l'affichage hors ligne. */
object MeteoData {
    const val DEFAULT_SITE = "https://maxencedevos83.github.io/App-meteo/"
    private const val PREFS = "meteo"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun siteUrl(context: Context): String =
        prefs(context).getString("site", DEFAULT_SITE)!!.let { if (it.endsWith("/")) it else "$it/" }

    fun setSiteUrl(context: Context, url: String) {
        prefs(context).edit().putString("site", url.trim()).apply()
    }

    fun cached(context: Context): JSONObject? =
        prefs(context).getString("json", null)?.let { runCatching { JSONObject(it) }.getOrNull() }

    fun lastError(context: Context): String? = prefs(context).getString("error", null)

    /** Télécharge la dernière prévision ; en cas d'échec, renvoie la dernière connue. */
    fun refresh(context: Context): JSONObject? {
        val url = siteUrl(context) + "data/widget.json?t=" + System.currentTimeMillis()
        return try {
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = 15000
                readTimeout = 15000
                setRequestProperty("Cache-Control", "no-cache")
            }
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            conn.disconnect()
            val json = JSONObject(body)
            prefs(context).edit().putString("json", body).remove("error").apply()
            json
        } catch (e: Exception) {
            prefs(context).edit().putString("error", e.message ?: e.javaClass.simpleName).apply()
            cached(context)
        }
    }

    /**
     * Pluie de la prochaine heure par quarts d'heure (AROME, via Open-Meteo), lue directement par le téléphone :
     * plus récente que la prévision publiée toutes les 30 min. Renvoie (heure locale, mm) ou null si indisponible.
     */
    fun nowcast(lat: Double, lon: Double): List<Pair<String, Double>>? = try {
        val url = "https://api.open-meteo.com/v1/forecast?latitude=$lat&longitude=$lon" +
            "&minutely_15=precipitation&forecast_minutely_15=5&timezone=auto"
        val conn = (URL(url).openConnection() as HttpURLConnection).apply { connectTimeout = 10000; readTimeout = 10000 }
        val m = JSONObject(conn.inputStream.bufferedReader().use { it.readText() }).getJSONObject("minutely_15")
        conn.disconnect()
        val times = m.getJSONArray("time")
        val mm = m.getJSONArray("precipitation")
        (0 until times.length()).map { times.getString(it) to mm.optDouble(it, 0.0) }
    } catch (e: Exception) {
        null
    }

    // Échelle de couleurs du vent (nœuds), proche de Windguru.
    private val STOPS = listOf(
        0 to intArrayOf(255, 255, 255), 5 to intArrayOf(200, 245, 255), 9 to intArrayOf(120, 230, 160),
        13 to intArrayOf(170, 240, 70), 17 to intArrayOf(255, 240, 60), 21 to intArrayOf(255, 170, 40),
        25 to intArrayOf(255, 80, 60), 30 to intArrayOf(230, 40, 160), 38 to intArrayOf(150, 60, 220),
    )

    fun windColor(kn: Double): Int {
        val i = STOPS.indexOfFirst { it.first > kn }
        val rgb = when (i) {
            -1 -> STOPS.last().second
            0 -> STOPS.first().second
            else -> {
                val (k0, c0) = STOPS[i - 1]
                val (k1, c1) = STOPS[i]
                val f = (kn - k0) / (k1 - k0)
                IntArray(3) { j -> (c0[j] + (c1[j] - c0[j]) * f).toInt() }
            }
        }
        return (0xFF shl 24) or (rgb[0] shl 16) or (rgb[1] shl 8) or rgb[2]
    }

    /** Flèche indiquant où va le vent (le vent de nord souffle vers le sud). */
    fun arrow(deg: Double?): String {
        if (deg == null || deg.isNaN()) return ""
        val arrows = arrayOf("↑", "↗", "→", "↘", "↓", "↙", "←", "↖")
        return arrows[(Math.round(((deg + 180) % 360) / 45.0) % 8).toInt()]
    }
}
