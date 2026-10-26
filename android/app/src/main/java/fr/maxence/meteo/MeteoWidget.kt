package fr.maxence.meteo

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.AlarmClock
import android.view.View
import android.widget.RemoteViews
import org.json.JSONObject
import kotlin.concurrent.thread

class MeteoWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        AlertJob.schedule(context)
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
                val data = MeteoData.refresh(context)
                runCatching { render(context, data) }
                if (MeteoData.lastError(context) == null) runCatching { Notifier.notifyNew(context, data) }
            } finally {
                pending.finish()
            }
        }
    }

    enum class Size { SMALL, MEDIUM, LARGE }

    companion object {
        const val ACTION_REFRESH = "fr.maxence.meteo.REFRESH"

        fun render(context: Context, data: JSONObject?) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, MeteoWidget::class.java))
            for (id in ids) {
                val options = manager.getAppWidgetOptions(id)
                val minW = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250)
                val maxW = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, minW)
                val minH = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 110)
                val maxH = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, minH)
                // La taille choisie par l'utilisateur décide de la mise en page.
                val size = when {
                    minW < 200 || maxH < 100 -> Size.SMALL
                    maxH >= 230 -> Size.LARGE
                    else -> Size.MEDIUM
                }
                manager.updateAppWidget(id, build(context, data, size, maxW, maxH))
            }
        }

        fun build(context: Context, d: JSONObject?, size: Size, widthDp: Int, heightDp: Int): RemoteViews {
            val layout = when (size) {
                Size.SMALL -> R.layout.widget_small
                Size.MEDIUM -> R.layout.widget_meteo
                Size.LARGE -> R.layout.widget_large
            }
            val v = RemoteViews(context.packageName, layout)
            val open = Intent(Intent.ACTION_VIEW, Uri.parse(MeteoData.siteUrl(context)))
            v.setOnClickPendingIntent(R.id.root, PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE))
            val refresh = Intent(context, MeteoWidget::class.java).setAction(ACTION_REFRESH)
            v.setOnClickPendingIntent(R.id.refresh, PendingIntent.getBroadcast(context, 1, refresh, PendingIntent.FLAG_IMMUTABLE))

            // Apparence choisie dans l'appli, et horloge (un appui ouvre l'horloge du téléphone).
            val style = WidgetStyle.load(context)
            WidgetStyle.apply(context, v, layout, style)
            val alarms = PendingIntent.getActivity(context, 3, Intent(AlarmClock.ACTION_SHOW_ALARMS), PendingIntent.FLAG_IMMUTABLE)
            v.setOnClickPendingIntent(R.id.clock_small, alarms)
            val bigClock = size != Size.SMALL && style.clock == WidgetStyle.CLOCK_BIG
            if (size == Size.SMALL) {
                v.setViewVisibility(R.id.clock_small, if (style.clock == WidgetStyle.CLOCK_HIDDEN) View.GONE else View.VISIBLE)
            } else {
                v.setViewVisibility(R.id.clock_row, if (bigClock) View.VISIBLE else View.GONE)
                v.setViewVisibility(R.id.date, if (style.showDate) View.VISIBLE else View.GONE)
                v.setViewVisibility(R.id.clock_small, if (style.clock == WidgetStyle.CLOCK_SMALL) View.VISIBLE else View.GONE)
                v.setOnClickPendingIntent(R.id.clock_row, alarms)
            }
            // Place prise par la grande horloge, selon la taille du texte.
            val clockDp = if (bigClock) 56 * style.textScale / 100 else 0

            if (d == null) {
                if (size == Size.SMALL) {
                    v.setTextViewText(R.id.wind, "Pas de données")
                    v.setTextViewText(R.id.rain, "Touchez ⟳")
                } else {
                    v.setTextViewText(R.id.cond, "Pas encore de données")
                    v.setTextViewText(R.id.footer, MeteoData.lastError(context) ?: "Touchez ⟳ pour actualiser")
                }
                return v
            }

            fun num(o: JSONObject, k: String): Double? = if (o.isNull(k)) null else o.optDouble(k).takeIf { !it.isNaN() }
            fun int(o: JSONObject, k: String) = num(o, k)?.let { Math.round(it).toString() } ?: "–"

            v.setTextViewText(R.id.icon, d.optString("icon"))
            v.setTextViewText(R.id.temp, "${int(d, "temp")}°")
            v.setTextViewText(R.id.wind, "${MeteoData.arrow(num(d, "dirDeg"))} ${int(d, "wind")} kn · raf. ${int(d, "gust")} ${d.optString("dir")}")
            val rain = d.optString("rain")
            val sea = num(d, "sea")?.let { " · mer ${Math.round(it)}°" } ?: ""
            v.setTextViewText(R.id.rain, "💧 ${if (rain.isNotEmpty()) rain else "${int(d, "pop")} % de pluie"}$sea")
            if (size == Size.SMALL) return v

            v.setTextViewText(R.id.place, d.optString("place"))
            v.setTextViewText(R.id.cond, d.optString("cond"))
            v.setTextViewText(R.id.minmax, "${int(d, "min")}° / ${int(d, "max")}° · ressenti ${int(d, "feels")}°")

            // Alerte la plus importante (vigilance, orage, coup de vent, pluie).
            val alerts = d.optJSONArray("alerts")
            var top: JSONObject? = null
            if (alerts != null) for (i in 0 until alerts.length()) {
                val a = alerts.getJSONObject(i)
                if (a.optString("type") == "session") continue
                if (top == null || a.optInt("level") > top.optInt("level")) top = a
            }
            if (top != null) {
                v.setViewVisibility(R.id.alert, View.VISIBLE)
                v.setTextViewText(R.id.alert, "⚠ ${top.optString("title")}")
            } else {
                v.setViewVisibility(R.id.alert, View.GONE)
            }

            val hours = d.optJSONArray("h")
            val hourIds = listOf(
                arrayOf(R.id.h0_t, R.id.h0_icon, R.id.h0_temp, R.id.h0_wind),
                arrayOf(R.id.h1_t, R.id.h1_icon, R.id.h1_temp, R.id.h1_wind),
                arrayOf(R.id.h2_t, R.id.h2_icon, R.id.h2_temp, R.id.h2_wind),
                arrayOf(R.id.h3_t, R.id.h3_icon, R.id.h3_temp, R.id.h3_wind),
                arrayOf(R.id.h4_t, R.id.h4_icon, R.id.h4_temp, R.id.h4_wind),
                arrayOf(R.id.h5_t, R.id.h5_icon, R.id.h5_temp, R.id.h5_wind),
            )
            val days = d.optJSONArray("d")
            // Colonne d'un jour : nom (et risque de pluie), icône, min/max, vent moyen·rafales.
            fun fillDay(ids: Array<Int>, day: JSONObject) {
                val pop = num(day, "pop") ?: 0.0
                v.setTextViewText(ids[0], if (pop >= 40) "${day.optString("day")} ${Math.round(pop)}%" else day.optString("day"))
                v.setTextViewText(ids[1], day.optString("icon"))
                v.setTextViewText(ids[2], "${int(day, "min")}/${int(day, "max")}°")
                val wind = num(day, "wind") ?: 0.0
                v.setTextViewText(ids[3], "${Math.round(wind)}·${int(day, "gust")}")
                v.setInt(ids[3], "setBackgroundColor", MeteoData.windColor(wind))
            }

            // Un widget moyen peu haut n'affiche pas la ligne des prévisions.
            v.setViewVisibility(R.id.hours, when {
                size == Size.MEDIUM && heightDp < 130 + clockDp -> View.GONE
                // Le grand widget a déjà sa ligne des jours sous le graphe.
                size == Size.LARGE && style.daily -> View.GONE
                else -> View.VISIBLE
            })
            if (size == Size.MEDIUM && style.daily) {
                // Prévision sur plusieurs jours, à partir de demain quand la journée est presque finie.
                val hourNow = d.optString("updated").substringBefore('h').toIntOrNull() ?: 0
                val start = if (hourNow >= 20 && days != null && days.length() > hourIds.size) 1 else 0
                hourIds.forEachIndexed { i, ids ->
                    val day = days?.optJSONObject(start + i)
                    if (day != null) fillDay(ids, day) else ids.forEach { id -> v.setTextViewText(id, "") }
                }
            } else hourIds.forEachIndexed { i, ids ->
                val h = hours?.optJSONObject(i) ?: return@forEachIndexed
                val pop = num(h, "pop") ?: 0.0
                v.setTextViewText(ids[0], if (pop >= 30) "${h.optString("t")} ${Math.round(pop)}%" else h.optString("t"))
                v.setTextViewText(ids[1], h.optString("icon"))
                v.setTextViewText(ids[2], "${int(h, "temp")}°")
                val wind = num(h, "wind") ?: 0.0
                v.setTextViewText(ids[3], "${MeteoData.arrow(num(h, "dirDeg"))}${Math.round(wind)}")
                v.setInt(ids[3], "setBackgroundColor", MeteoData.windColor(wind))
            }

            if (size == Size.LARGE) {
                val density = context.resources.displayMetrics.density
                // Hauteur du graphe : ce qui reste une fois les autres lignes placées (≈ 250 dp, plus l'horloge).
                val chartHeightDp = (heightDp - 250 - clockDp + if (style.daily) 60 else 0).coerceIn(50, 180)
                val bmp = ChartRenderer.render(d.optJSONArray("chart"), ((widthDp - 24) * density).toInt(), (chartHeightDp * density).toInt(), density, style.textColor)
                if (bmp != null) v.setImageViewBitmap(R.id.chart, bmp)

                val dayIds = listOf(
                    arrayOf(R.id.d0_t, R.id.d0_icon, R.id.d0_temp, R.id.d0_wind),
                    arrayOf(R.id.d1_t, R.id.d1_icon, R.id.d1_temp, R.id.d1_wind),
                    arrayOf(R.id.d2_t, R.id.d2_icon, R.id.d2_temp, R.id.d2_wind),
                    arrayOf(R.id.d3_t, R.id.d3_icon, R.id.d3_temp, R.id.d3_wind),
                    arrayOf(R.id.d4_t, R.id.d4_icon, R.id.d4_temp, R.id.d4_wind),
                )
                dayIds.forEachIndexed { i, ids ->
                    val day = days?.optJSONObject(i) ?: return@forEachIndexed
                    fillDay(ids, day)
                }

                val sessions = d.optJSONArray("sessions")
                val parts = mutableListOf<String>()
                if (sessions != null) for (i in 0 until sessions.length()) {
                    val s = sessions.getJSONObject(i)
                    if (s.optString("id") == "balade") continue
                    parts.add("${s.optString("emoji")} ${s.optString("when")}")
                }
                v.setTextViewText(R.id.sessions, if (parts.isEmpty()) "Pas de bon créneau nautique sur 5 jours" else parts.joinToString("   "))
            }

            val stale = MeteoData.lastError(context)?.let { " · hors ligne" } ?: ""
            v.setTextViewText(R.id.footer, "Maj ${d.optString("updated")} · fiabilité ${int(d, "confidence")} % · ${int(d, "sources")} modèles$stale")
            return v
        }
    }
}
