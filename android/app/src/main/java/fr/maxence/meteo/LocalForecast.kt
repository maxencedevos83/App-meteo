package fr.maxence.meteo

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Prévision calculée sur le téléphone pour l'endroit où l'on se trouve, hors du lieu principal :
 * moyenne pondérée de Météo-France (AROME/ARPEGE), ECMWF et ICON, au même format que widget.json.
 * (Windguru, les stations et la vigilance du Var restent réservés au lieu principal.)
 */
object LocalForecast {
    private val MODELS = listOf("meteofrance_seamless" to 0.5, "ecmwf_ifs025" to 0.3, "icon_seamless" to 0.2)
    private const val VARS = "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day"

    private class Hour(
        val time: String, val temp: Double?, val feels: Double?, val precip: Double, val pop: Int, val code: Int,
        val wind: Double?, val gust: Double?, val dir: Double?, val isDay: Boolean, val spread: Double,
    )

    fun build(lat: Double, lon: Double, place: String): JSONObject {
        val url = "https://api.open-meteo.com/v1/forecast?latitude=$lat&longitude=$lon&hourly=$VARS" +
            "&models=${MODELS.joinToString(",") { it.first }}&wind_speed_unit=kn&timezone=auto&forecast_days=8"
        val conn = (URL(url).openConnection() as HttpURLConnection).apply { connectTimeout = 15000; readTimeout = 20000 }
        val json = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
        conn.disconnect()
        val offsetSec = json.optInt("utc_offset_seconds", 0)
        val hourly = json.getJSONObject("hourly")
        val times = hourly.getJSONArray("time")

        fun series(name: String, model: String): JSONArray? = hourly.optJSONArray("${name}_$model") ?: hourly.optJSONArray(name)
        fun value(arr: JSONArray?, i: Int): Double? = if (arr == null || arr.isNull(i)) null else arr.optDouble(i).takeIf { !it.isNaN() }

        val cols = MODELS.associate { (m, _) -> m to VARS.split(',').associateWith { series(it, m) } }
        val hours = (0 until times.length()).map { i ->
            var wSum = 0.0; var t = 0.0; var f = 0.0; var p = 0.0; var w = 0.0; var g = 0.0; var u = 0.0; var v = 0.0; var wet = 0.0
            var tw = 0.0; var fw = 0.0; var ww = 0.0; var gw = 0.0
            val temps = mutableListOf<Double>()
            var code: Int? = null
            var isDay = true
            for ((m, weight) in MODELS) {
                val c = cols.getValue(m)
                value(c["temperature_2m"], i)?.let { t += it * weight; tw += weight; temps.add(it) }
                value(c["apparent_temperature"], i)?.let { f += it * weight; fw += weight }
                value(c["wind_speed_10m"], i)?.let { w += it * weight; ww += weight }
                value(c["wind_gusts_10m"], i)?.let { g += it * weight; gw += weight }
                value(c["wind_direction_10m"], i)?.let {
                    val r = Math.toRadians(it)
                    u += sin(r) * weight; v += cos(r) * weight
                }
                val pr = value(c["precipitation"], i)
                if (pr != null) {
                    p += pr * weight; wSum += weight
                    if (pr >= 0.1) wet += weight
                }
                if (code == null) code = value(c["weather_code"], i)?.toInt()
                value(c["is_day"], i)?.let { isDay = it > 0.5 }
            }
            val spread = if (temps.size > 1) temps.max() - temps.min() else 0.0
            Hour(
                time = times.getString(i),
                temp = if (tw > 0) t / tw else null,
                feels = if (fw > 0) f / fw else null,
                precip = if (wSum > 0) p / wSum else 0.0,
                pop = if (wSum > 0) (wet / wSum * 100).roundToInt() else 0,
                code = code ?: 3,
                wind = if (ww > 0) w / ww else null,
                gust = if (gw > 0) g / gw else null,
                dir = if (u != 0.0 || v != 0.0) (Math.toDegrees(atan2(u, v)) + 360) % 360 else null,
                isDay = isDay,
                spread = spread,
            )
        }

        // Heure locale du lieu (le fuseau vient de la réponse).
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:00", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val nowKey = fmt.format(Date(System.currentTimeMillis() + offsetSec * 1000L))
        val start = hours.indexOfFirst { it.time >= nowKey }.coerceAtLeast(0)
        val next = hours.drop(start)
        val cur = next.firstOrNull() ?: throw IllegalStateException("prévision vide")

        val nowcast = MeteoData.nowcast(lat, lon)
        val wetSlot = nowcast?.firstOrNull { it.second >= 0.1 }
        val rain = when {
            nowcast == null -> ""
            wetSlot == null -> "Pas de pluie dans l'heure"
            nowcast.first().second >= 0.1 -> "Pluie en cours"
            else -> "Pluie vers ${hourLabel(wetSlot.first)}"
        }

        val today = next.filter { it.time.take(10) == cur.time.take(10) }
        val span = (if (today.size < 8) next.take(24) else today).mapNotNull { it.temp }

        val out = JSONObject()
        out.put("place", place)
        out.put("local", true)
        out.put("lat", lat)
        out.put("lon", lon)
        val clock = Calendar.getInstance()
        out.put("updated", String.format(Locale.ROOT, "%dh%02d", clock.get(Calendar.HOUR_OF_DAY), clock.get(Calendar.MINUTE)))
        out.put("temp", cur.temp?.roundToInt())
        out.put("feels", cur.feels?.roundToInt())
        out.put("code", cur.code)
        out.put("isDay", cur.isDay)
        out.put("cond", codeLabel(cur.code, cur.isDay))
        out.put("wind", cur.wind?.roundToInt())
        out.put("gust", cur.gust?.roundToInt())
        out.put("dir", dirLabel(cur.dir))
        out.put("dirDeg", cur.dir?.roundToInt())
        out.put("pop", cur.pop)
        out.put("rain", rain)
        if (span.isNotEmpty()) { out.put("min", span.min().roundToInt()); out.put("max", span.max().roundToInt()) }
        // Fiabilité : accord entre modèles sur la température des 24 prochaines heures.
        val meanSpread = next.take(24).map { it.spread }.average().takeIf { !it.isNaN() } ?: 0.0
        out.put("confidence", (95 - meanSpread * 12).roundToInt().coerceIn(35, 95))
        out.put("sources", MODELS.size)

        out.put("h", JSONArray().apply {
            for (i in 1 until next.size step 2) {
                if (length() >= 6) break
                val h = next[i]
                put(JSONObject().put("t", "${h.time.substring(11, 13).toInt()}h").put("temp", h.temp?.roundToInt()).put("code", h.code)
                    .put("isDay", h.isDay).put("pop", h.pop).put("wind", h.wind?.roundToInt()).put("gust", h.gust?.roundToInt())
                    .put("dir", dirLabel(h.dir)).put("dirDeg", h.dir?.roundToInt()))
            }
        })

        val days = next.groupBy { it.time.take(10) }.entries.take(7)
        out.put("d", JSONArray().apply {
            days.forEachIndexed { i, (date, list) ->
                // Le temps du jour : le plus marquant entre 7 h et 20 h.
                val daytime = list.filter { it.time.substring(11, 13).toInt() in 7..20 }.ifEmpty { list }
                put(JSONObject()
                    .put("day", if (i == 0) "Auj." else if (i == 1) "Dem." else dayName(date))
                    .put("min", list.mapNotNull { it.temp }.minOrNull()?.roundToInt())
                    .put("max", list.mapNotNull { it.temp }.maxOrNull()?.roundToInt())
                    .put("code", daytime.maxOf { severity(it.code) * 100 + it.code } % 100)
                    .put("pop", list.maxOf { it.pop })
                    .put("wind", list.mapNotNull { it.wind }.maxOrNull()?.roundToInt())
                    .put("gust", list.mapNotNull { it.gust }.maxOrNull()?.roundToInt()))
            }
        })

        out.put("chart", JSONArray().apply {
            for (h in next.take(24)) {
                put(JSONObject().put("t", h.time).put("h", h.time.substring(11, 13).toInt()).put("code", h.code)
                    .put("temp", h.temp?.let { (it * 10).roundToInt() / 10.0 }).put("wind", h.wind?.roundToInt())
                    .put("gust", h.gust?.roundToInt()).put("dir", h.dir?.roundToInt()).put("pop", h.pop)
                    .put("precip", (h.precip * 10).roundToInt() / 10.0))
            }
        })
        out.put("alerts", JSONArray())
        out.put("sessions", JSONArray())
        return out
    }

    // Plus le code est marquant (orage > neige > pluie > nuages), plus il l'emporte pour la journée.
    private fun severity(code: Int) = when (code) {
        in 95..99 -> 6
        in 71..77, 85, 86 -> 5
        in 61..67, in 80..82 -> 4
        in 51..57 -> 3
        45, 48 -> 2
        3 -> 1
        else -> 0
    }

    private fun hourLabel(time: String): String {
        val h = time.substring(11, 13).toInt()
        val m = time.substring(14, 16)
        return if (m == "00") "${h}h" else "${h}h$m"
    }

    private fun dayName(date: String): String {
        val c = Calendar.getInstance(TimeZone.getTimeZone("UTC"))
        c.set(date.substring(0, 4).toInt(), date.substring(5, 7).toInt() - 1, date.substring(8, 10).toInt(), 12, 0)
        return arrayOf("Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam")[c.get(Calendar.DAY_OF_WEEK) - 1]
    }

    private val DIRS = arrayOf("N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO")
    private fun dirLabel(deg: Double?) = if (deg == null) "" else DIRS[((deg / 22.5).roundToInt()) % 16]

    fun codeLabel(code: Int, isDay: Boolean): String = when (code) {
        0 -> if (isDay) "Ensoleillé" else "Ciel clair"
        1 -> "Peu nuageux"
        2 -> "Partiellement nuageux"
        3 -> "Couvert"
        45, 48 -> "Brouillard"
        51, 53, 55 -> "Bruine"
        56, 57 -> "Bruine verglaçante"
        61 -> "Pluie faible"
        63 -> "Pluie"
        65 -> "Forte pluie"
        66, 67 -> "Pluie verglaçante"
        71 -> "Neige faible"
        73 -> "Neige"
        75 -> "Forte neige"
        77 -> "Grains de neige"
        80 -> "Averses"
        81 -> "Averses modérées"
        82 -> "Fortes averses"
        85, 86 -> "Averses de neige"
        95 -> "Orage"
        96, 99 -> "Orage avec grêle"
        else -> "—"
    }

    /** Distance à vol d'oiseau en km. */
    fun distanceKm(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val r = 6371.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val h = sin(dLat / 2) * sin(dLat / 2) + cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * r * Math.asin(sqrt(h))
    }
}
