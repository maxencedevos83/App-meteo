package fr.maxence.meteo

import android.content.Context
import android.util.Log
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

    // Autour du lieu principal, la prévision publiée (Windguru, stations, vigilance) reste la meilleure.
    private const val HOME_RADIUS_KM = 15.0

    /**
     * Dernière prévision pour le widget : celle publiée par l'appli près du lieu principal,
     * sinon une prévision calculée sur le téléphone pour la ville où l'on se trouve.
     */
    fun refresh(context: Context): JSONObject? {
        val here = if (Position.follow(context)) Position.current(context) else null
        if (Position.follow(context)) Log.i("Meteo", if (here == null) "Position inconnue : lieu principal" else "Position : ${here.name}")
        if (here == null) return refreshHome(context, "data/")
        // Près d'un lieu suivi par l'appli (Le Lavandou, Cambrils…) : sa prévision complète publiée.
        val near = places(context).minByOrNull { LocalForecast.distanceKm(here.lat, here.lon, it.lat, it.lon) }
            ?.takeIf { LocalForecast.distanceKm(here.lat, here.lon, it.lat, it.lon) <= HOME_RADIUS_KM }
        if (near != null) {
            Log.i("Meteo", "Lieu suivi : ${near.name}")
            return refreshHome(context, near.path)
        }
        return try {
            val json = LocalForecast.build(here.lat, here.lon, here.name)
            Log.i("Meteo", "Prévision locale : ${here.name} ${json.optString("temp")}° ${json.optString("cond")}")
            prefs(context).edit().putString("json", json.toString()).remove("error").apply()
            json
        } catch (e: Exception) {
            Log.e("Meteo", "Prévision locale impossible", e)
            prefs(context).edit().putString("error", e.message ?: e.javaClass.simpleName).apply()
            cached(context)
        }
    }

    class Tracked(val name: String, val lat: Double, val lon: Double, val path: String)

    /** Lieux suivis par l'appli (data/places.json), gardés en cache ; à défaut, Le Lavandou. */
    private fun places(context: Context): List<Tracked> {
        val body = runCatching {
            val conn = (URL(siteUrl(context) + "data/places.json?t=" + System.currentTimeMillis()).openConnection() as HttpURLConnection).apply {
                connectTimeout = 10000; readTimeout = 10000
            }
            conn.inputStream.bufferedReader().use { it.readText() }.also { conn.disconnect() }
        }.getOrNull()
        if (body != null) prefs(context).edit().putString("places", body).apply()
        val arr = runCatching { org.json.JSONArray(body ?: prefs(context).getString("places", null)) }.getOrNull()
            ?: return listOf(Tracked("Le Lavandou", 43.1375, 6.3683, "data/"))
        return (0 until arr.length()).map { arr.getJSONObject(it) }.map {
            Tracked(it.optString("place"), it.optDouble("latitude"), it.optDouble("longitude"), it.optString("path", "data/"))
        }
    }

    /** Télécharge la prévision publiée d'un lieu suivi ; en cas d'échec, renvoie la dernière connue. */
    private fun refreshHome(context: Context, path: String): JSONObject? {
        val url = siteUrl(context) + path + "widget.json?t=" + System.currentTimeMillis()
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

    /**
     * Prévision recalée sur l'heure actuelle : la mise à jour publiée peut dater de quelques heures
     * (GitHub ne la lance pas toujours toutes les 30 min), et afficherait alors encore la nuit au matin.
     * Les valeurs de l'heure en cours sont reprises de la courbe horaire, le jour et la nuit recalculés ici.
     */
    fun fresh(d: JSONObject, now: Long = System.currentTimeMillis()): JSONObject {
        val out = JSONObject(d.toString())
        val lat = out.optDouble("lat", 43.1375)
        val lon = out.optDouble("lon", 6.3683)
        val isDayNow = Astro.isDay(now, lat, lon)
        out.put("isDay", isDayNow)
        val fmt = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:00", java.util.Locale.ROOT)
        val hourKey = fmt.format(java.util.Date(now))
        val chart = out.optJSONArray("chart")
        val idx = if (chart == null) -1 else (0 until chart.length()).firstOrNull { chart.getJSONObject(it).optString("t") >= hourKey } ?: -1
        if (chart != null && idx > 0) {
            val next = org.json.JSONArray()
            for (i in idx until chart.length()) next.put(chart.getJSONObject(i))
            out.put("chart", next)
            val cur = next.getJSONObject(0)
            val code = cur.optInt("code", out.optInt("code", 3))
            out.put("code", code)
            out.put("cond", LocalForecast.codeLabel(code, isDayNow))
            for (k in listOf("temp", "wind", "gust", "pop")) if (cur.has(k) && !cur.isNull(k)) out.put(k, cur.get(k))
            if (cur.has("feels") && !cur.isNull("feels")) out.put("feels", cur.get("feels"))
            if (cur.has("dir") && !cur.isNull("dir")) {
                out.put("dirDeg", cur.getDouble("dir"))
                out.put("dir", LocalForecast.dirLabel(cur.getDouble("dir")))
            }
            // La pluie « dans l'heure » publiée n'est plus d'actualité.
            out.put("rain", "")
            val hours = org.json.JSONArray()
            var i = 1
            while (i < next.length() && hours.length() < 6) {
                val h = next.getJSONObject(i)
                val t = h.optString("t")
                val ms = runCatching { fmt.parse(t)!!.time }.getOrNull() ?: now
                hours.put(JSONObject().put("t", "${t.substring(11, 13).toInt()}h").put("temp", h.opt("temp")).put("code", h.optInt("code", 3))
                    .put("isDay", Astro.isDay(ms + 1_800_000, lat, lon)).put("pop", h.opt("pop")).put("wind", h.opt("wind"))
                    .put("gust", h.opt("gust")).put("dirDeg", h.opt("dir")))
                i += 2
            }
            out.put("h", hours)
        }
        // Jours passés retirés.
        val days = out.optJSONArray("d")
        if (days != null && days.length() > 0 && days.getJSONObject(0).has("date")) {
            val today = hourKey.take(10)
            val kept = org.json.JSONArray()
            for (j in 0 until days.length()) days.getJSONObject(j).let { if (it.optString("date") >= today) kept.put(it) }
            if (kept.length() > 0) {
                if (kept.getJSONObject(0).optString("date") == today && kept.length() < days.length()) {
                    kept.getJSONObject(0).put("day", "Auj.")
                    if (kept.length() > 1) kept.getJSONObject(1).put("day", "Dem.")
                }
                out.put("d", kept)
            }
        }
        return out
    }

    /** Le vent est publié en nœuds (unité des modèles) et affiché en km/h. */
    fun kmh(kn: Double?): String = kn?.let { Math.round(it * 1.852).toString() } ?: "–"

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
