package fr.maxence.meteo

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import org.json.JSONObject

/**
 * Notifications d'alerte, une seule fois par alerte.
 * Vigilance et orages viennent de la prévision publiée ; le vent est recalculé avec le seuil choisi
 * sur le téléphone, et la pluie dans l'heure est lue en direct.
 */
object Notifier {
    private const val CHANNEL = "alertes"
    private const val CHANNEL_STRONG = "alertes_fortes"
    private const val PREFS = "meteo"
    private const val RAIN_PAUSE_MS = 3 * 3600 * 1000L

    // Types d'alerte réglables dans l'appli (clé, libellé, activé par défaut).
    val TYPES = listOf(
        Triple("vigilance", "Vigilance Météo-France (Var)", true),
        Triple("orage", "Orages", true),
        Triple("vent", "Vent violent", true),
        Triple("pluie", "Pluie (dans l'heure et dans les 6 h)", true),
        Triple("session", "Bons créneaux de sortie en bateau", true),
    )

    class Alert(val id: String, val type: String, val level: Int, val title: String, val text: String)

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun enabled(context: Context, type: String): Boolean {
        val default = TYPES.firstOrNull { it.first == type }?.third ?: true
        return prefs(context).getBoolean("notif_$type", default)
    }

    fun setEnabled(context: Context, type: String, on: Boolean) {
        prefs(context).edit().putBoolean("notif_$type", on).apply()
    }

    /** Seuil de rafales pour l'alerte vent, réglé en km/h (la prévision est en nœuds). */
    fun gustThresholdKmh(context: Context) = prefs(context).getInt("gust_kmh", 55)
    fun setGustThresholdKmh(context: Context, kmh: Int) = prefs(context).edit().putInt("gust_kmh", kmh).apply()

    /** Niveau de vigilance minimal notifié : 2 = jaune, 3 = orange. */
    fun vigilanceMin(context: Context) = prefs(context).getInt("vig_min", 2)
    fun setVigilanceMin(context: Context, level: Int) = prefs(context).edit().putInt("vig_min", level).apply()

    private fun hourLabel(time: String): String {
        val h = time.substring(11, 13).toInt()
        val m = time.substring(14, 16)
        return if (m == "00") "${h}h" else "${h}h$m"
    }

    /** Toutes les alertes en cours, calculées à partir de la prévision publiée et des mesures en direct. */
    fun collect(context: Context, raw: JSONObject, withNowcast: Boolean = true): List<Alert> {
        // Les « prochaines heures » comptent à partir de maintenant, même si la prévision publiée date un peu.
        val data = runCatching { MeteoData.fresh(raw) }.getOrDefault(raw)
        val out = mutableListOf<Alert>()
        val chart = data.optJSONArray("chart")
        val hasTimes = chart != null && chart.length() > 0 && chart.getJSONObject(0).has("t")

        val published = data.optJSONArray("alerts")
        var publishedRain: Alert? = null
        if (published != null) for (i in 0 until published.length()) {
            val a = published.getJSONObject(i)
            val alert = Alert(a.optString("id"), a.optString("type"), a.optInt("level"), a.optString("title"), a.optString("text"))
            when (alert.type) {
                "vigilance" -> if (alert.level >= vigilanceMin(context)) out.add(alert)
                // Recalculé ici avec le seuil du téléphone quand la prévision le permet.
                "vent" -> if (!hasTimes) out.add(alert)
                "pluie" -> publishedRain = alert
                else -> out.add(alert)
            }
        }

        if (hasTimes) {
            // Vent violent sur les 12 prochaines heures, avec le seuil choisi.
            val thresholdKmh = gustThresholdKmh(context)
            val threshold = thresholdKmh / 1.852
            var first: JSONObject? = null
            var peak: JSONObject? = null
            for (i in 0 until minOf(12, chart!!.length())) {
                val h = chart.getJSONObject(i)
                if (h.optDouble("gust", 0.0) < threshold) continue
                if (first == null) first = h
                if (peak == null || h.optDouble("gust") > peak.optDouble("gust")) peak = h
            }
            if (first != null && peak != null) {
                val gust = peak.optDouble("gust")
                out.add(Alert(
                    "vent-${first.optString("t").take(10)}-$thresholdKmh", "vent", if (gust >= threshold + 10) 3 else 2,
                    "Vent violent : rafales ${MeteoData.kmh(gust)} km/h",
                    "Dès ${hourLabel(first.optString("t"))}, maximum vers ${hourLabel(peak.optString("t"))} " +
                        "(vent moyen ${MeteoData.kmh(peak.optDouble("wind", 0.0))} km/h)",
                ))
            }
        }

        // Pluie dans l'heure : mesure en direct, sinon celle de la prévision publiée.
        var rainNow: Alert? = null
        val lat = data.optDouble("lat", 43.1375)
        val lon = data.optDouble("lon", 6.3683)
        val slots = if (withNowcast) MeteoData.nowcast(lat, lon) else null
        if (slots != null) {
            val wet = slots.firstOrNull { it.second >= 0.1 }
            if (wet != null) {
                val total = slots.sumOf { it.second }
                val ongoing = slots.first().second >= 0.1
                rainNow = Alert(
                    "rain-${wet.first.take(13)}", "pluie", 1,
                    if (ongoing) "Il pleut" else "Pluie vers ${hourLabel(wet.first)}",
                    "Environ ${String.format("%.1f", total)} mm dans l'heure",
                )
            }
        } else {
            rainNow = publishedRain
        }
        if (rainNow != null) out.add(rainNow)

        // Pluie probable dans les 6 h (une fois par demi-journée).
        if (rainNow == null && hasTimes) {
            for (i in 1 until minOf(7, chart!!.length())) {
                val h = chart.getJSONObject(i)
                if (h.optDouble("pop", 0.0) < 60 || h.optDouble("precip", 0.0) < 0.3) continue
                val t = h.optString("t")
                val half = if (t.substring(11, 13).toInt() < 13) "matin" else "soir"
                out.add(Alert(
                    "rainsoon-${t.take(10)}-$half", "pluie", 1, "Pluie probable vers ${hourLabel(t)}",
                    "Probabilité ${Math.round(h.optDouble("pop"))} %, environ ${String.format("%.1f", h.optDouble("precip"))} mm/h",
                ))
                break
            }
        }
        return out
    }

    private fun canNotify(context: Context) = Build.VERSION.SDK_INT < 33 ||
        context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun manager(context: Context): NotificationManager {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Alertes météo", NotificationManager.IMPORTANCE_DEFAULT))
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_STRONG, "Alertes fortes (orange, rouge, orages, tempête)", NotificationManager.IMPORTANCE_HIGH),
        )
        return manager
    }

    private fun show(context: Context, manager: NotificationManager, a: Alert) {
        val strong = a.level >= 3
        val open = PendingIntent.getActivity(
            context, 2, Intent(Intent.ACTION_VIEW, Uri.parse(MeteoData.siteUrl(context))), PendingIntent.FLAG_IMMUTABLE,
        )
        val n = Notification.Builder(context, if (strong) CHANNEL_STRONG else CHANNEL)
            .setSmallIcon(if (strong) android.R.drawable.ic_dialog_alert else android.R.drawable.ic_dialog_info)
            .setContentTitle(a.title)
            .setContentText(a.text)
            .setStyle(Notification.BigTextStyle().bigText(a.text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        manager.notify(a.id.hashCode(), n)
    }

    @Synchronized
    fun notifyNew(context: Context, data: JSONObject?) {
        if (data == null || !canNotify(context)) return
        val alerts = collect(context, data)
        val prefs = prefs(context)
        val seen = prefs.getString("notified", "")!!.split('\n').filter { it.isNotEmpty() }.toMutableList()
        val manager = manager(context)
        val now = System.currentTimeMillis()
        var lastRain = prefs.getLong("last_rain", 0)
        for (a in alerts) {
            if (a.id.isEmpty() || a.id in seen || !enabled(context, a.type)) continue
            // Une averse qui dure ne renvoie pas une notification à chaque heure.
            if (a.type == "pluie") {
                if (now - lastRain < RAIN_PAUSE_MS) continue
                lastRain = now
            }
            show(context, manager, a)
            seen.add(a.id)
        }
        prefs.edit().putString("notified", seen.takeLast(80).joinToString("\n")).putLong("last_rain", lastRain).apply()
    }

    /** Notification d'essai, pour vérifier que les alertes arrivent bien. */
    fun test(context: Context): Boolean {
        if (!canNotify(context)) return false
        show(context, manager(context), Alert("test", "test", 3, "Test : alerte météo", "Les alertes arriveront comme celle-ci."))
        return true
    }
}
