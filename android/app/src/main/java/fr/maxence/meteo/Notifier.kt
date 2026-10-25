package fr.maxence.meteo

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import org.json.JSONObject

/** Notifications des alertes publiées par l'appli, une seule fois par alerte. */
object Notifier {
    private const val CHANNEL = "alertes"
    private const val PREFS = "meteo"

    // Types d'alerte réglables dans l'écran de l'appli (clé, libellé, activé par défaut).
    val TYPES = listOf(
        Triple("vigilance", "Vigilance Météo-France", true),
        Triple("pluie", "Pluie dans l'heure", true),
        Triple("vent", "Coup de vent et orages", true),
        Triple("session", "Bons créneaux de sortie (kite, voile, paddle)", true),
    )

    fun enabled(context: Context, type: String): Boolean {
        val key = if (type == "orage") "vent" else type
        val default = TYPES.firstOrNull { it.first == key }?.third ?: true
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("notif_$key", default)
    }

    fun setEnabled(context: Context, type: String, on: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("notif_$type", on).apply()
    }

    fun notifyNew(context: Context, data: JSONObject?) {
        val alerts = data?.optJSONArray("alerts") ?: return
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val seen = prefs.getString("notified", "")!!.split('\n').filter { it.isNotEmpty() }.toMutableList()
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Alertes météo", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(
            context, 2, Intent(Intent.ACTION_VIEW, Uri.parse(MeteoData.siteUrl(context))), PendingIntent.FLAG_IMMUTABLE,
        )
        for (i in 0 until alerts.length()) {
            val a = alerts.getJSONObject(i)
            val id = a.optString("id")
            if (id.isEmpty() || id in seen || !enabled(context, a.optString("type"))) continue
            val n = android.app.Notification.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(a.optString("title"))
                .setContentText(a.optString("text"))
                .setStyle(android.app.Notification.BigTextStyle().bigText(a.optString("text")))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build()
            manager.notify(id.hashCode(), n)
            seen.add(id)
        }
        prefs.edit().putString("notified", seen.takeLast(60).joinToString("\n")).apply()
    }
}
