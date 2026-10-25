package fr.maxence.meteo

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import kotlin.concurrent.thread

class MeteoWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        refreshAsync(context)
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        render(context, MeteoData.cached(context))
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH) refreshAsync(context)
    }

    private fun refreshAsync(context: Context) {
        val pending = goAsync()
        thread {
            try {
                render(context, MeteoData.refresh(context))
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_REFRESH = "fr.maxence.meteo.REFRESH"

        fun requestUpdate(context: Context) {
            context.sendBroadcast(Intent(context, MeteoWidget::class.java).setAction(ACTION_REFRESH))
        }

        fun render(context: Context, data: JSONObject?) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, MeteoWidget::class.java))
            for (id in ids) {
                val views = build(context, data)
                // Widget peu haut : on masque la ligne des heures.
                val h = manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 110)
                views.setViewVisibility(R.id.hours, if (h < 100) View.GONE else View.VISIBLE)
                manager.updateAppWidget(id, views)
            }
        }

        private fun build(context: Context, d: JSONObject?): RemoteViews {
            val v = RemoteViews(context.packageName, R.layout.widget_meteo)
            val open = Intent(Intent.ACTION_VIEW, Uri.parse(MeteoData.siteUrl(context)))
            v.setOnClickPendingIntent(R.id.root, PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE))
            val refresh = Intent(context, MeteoWidget::class.java).setAction(ACTION_REFRESH)
            v.setOnClickPendingIntent(R.id.refresh, PendingIntent.getBroadcast(context, 1, refresh, PendingIntent.FLAG_IMMUTABLE))

            if (d == null) {
                v.setTextViewText(R.id.cond, "Pas encore de données")
                v.setTextViewText(R.id.footer, MeteoData.lastError(context) ?: "Touchez ⟳ pour actualiser")
                return v
            }

            fun num(o: JSONObject, k: String): Double? = if (o.isNull(k)) null else o.optDouble(k).takeIf { !it.isNaN() }
            fun int(o: JSONObject, k: String) = num(o, k)?.let { Math.round(it).toString() } ?: "–"

            v.setTextViewText(R.id.place, d.optString("place"))
            v.setTextViewText(R.id.icon, d.optString("icon"))
            v.setTextViewText(R.id.temp, "${int(d, "temp")}°")
            v.setTextViewText(R.id.cond, d.optString("cond"))
            v.setTextViewText(R.id.minmax, "${int(d, "min")}° / ${int(d, "max")}° · ressenti ${int(d, "feels")}°")
            v.setTextViewText(R.id.wind, "${MeteoData.arrow(num(d, "dirDeg"))} ${int(d, "wind")} kn · raf. ${int(d, "gust")} ${d.optString("dir")}")

            val rain = d.optString("rain")
            val sea = num(d, "sea")?.let { " · mer ${Math.round(it)}°" } ?: ""
            v.setTextViewText(R.id.rain, "💧 ${if (rain.isNotEmpty()) rain else "${int(d, "pop")} % de pluie"}$sea")

            val hours = d.optJSONArray("h")
            val cols = listOf(
                arrayOf(R.id.h0_t, R.id.h0_icon, R.id.h0_temp, R.id.h0_wind),
                arrayOf(R.id.h1_t, R.id.h1_icon, R.id.h1_temp, R.id.h1_wind),
                arrayOf(R.id.h2_t, R.id.h2_icon, R.id.h2_temp, R.id.h2_wind),
                arrayOf(R.id.h3_t, R.id.h3_icon, R.id.h3_temp, R.id.h3_wind),
                arrayOf(R.id.h4_t, R.id.h4_icon, R.id.h4_temp, R.id.h4_wind),
                arrayOf(R.id.h5_t, R.id.h5_icon, R.id.h5_temp, R.id.h5_wind),
            )
            cols.forEachIndexed { i, ids ->
                val h = hours?.optJSONObject(i) ?: return@forEachIndexed
                val pop = num(h, "pop") ?: 0.0
                v.setTextViewText(ids[0], if (pop >= 30) "${h.optString("t")} ${Math.round(pop)}%" else h.optString("t"))
                v.setTextViewText(ids[1], h.optString("icon"))
                v.setTextViewText(ids[2], "${int(h, "temp")}°")
                val wind = num(h, "wind") ?: 0.0
                v.setTextViewText(ids[3], "${MeteoData.arrow(num(h, "dirDeg"))}${Math.round(wind)}")
                v.setInt(ids[3], "setBackgroundColor", MeteoData.windColor(wind))
            }

            val stale = MeteoData.lastError(context)?.let { " · hors ligne" } ?: ""
            v.setTextViewText(R.id.footer, "Maj ${d.optString("updated")} · fiabilité ${int(d, "confidence")} % · ${int(d, "sources")} modèles$stale")
            return v
        }
    }
}
