package fr.maxence.meteo

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.AlarmClock
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.util.Log
import android.util.SizeF
import android.view.View
import android.widget.FrameLayout
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
        when (intent.action) {
            ACTION_REFRESH -> refreshAsync(context)
            ACTION_MOVED -> {
                // Le téléphone s'est déplacé : nouvelle prévision si l'on a bougé d'au moins 1 km,
                // et au plus une fois toutes les 5 minutes.
                @Suppress("DEPRECATION")
                val loc = intent.getParcelableExtra<Location>(LocationManager.KEY_LOCATION_CHANGED) ?: return
                val prefs = context.getSharedPreferences("meteo", Context.MODE_PRIVATE)
                val now = System.currentTimeMillis()
                if (!Position.follow(context) || !Position.movedFar(context, loc) || now - prefs.getLong("moved_at", 0) < 5 * 60_000) return
                prefs.edit().putLong("moved_at", now).apply()
                Log.i("Meteo", "Déplacement détecté : actualisation du widget")
                refreshAsync(context)
            }
        }
    }

    private fun refreshAsync(context: Context) {
        val pending = goAsync()
        thread {
            var data: JSONObject? = null
            try {
                data = MeteoData.refresh(context)
                if (MeteoData.lastError(context) == null) runCatching { Notifier.notifyNew(context, data) }
            } finally {
                // La mise en page se mesure sur le fil principal (comme l'écran d'accueil).
                MAIN.post {
                    runCatching { renderNow(context, data) }.onFailure { Log.w("Meteo", "Widget", it) }
                    pending.finish()
                }
            }
        }
    }

    /** Images déjà dessinées, partagées entre les tailles (l'écran d'accueil ne les reçoit qu'une fois). */
    class Icons {
        private val cache = HashMap<String, Bitmap>()
        fun get(code: Int, isDay: Boolean, windy: Boolean, px: Int, frame: Int): Bitmap =
            cache.getOrPut("$code/$isDay/$windy/$px/$frame") { WeatherArt.icon(code, isDay, windy, px, frame) }
    }

    /** Un bloc facultatif : les vues qu'il montre, et celles qu'il remplace quand il est affiché. */
    private class Block(val show: List<Int>, val hide: List<Int> = emptyList())

    companion object {
        const val ACTION_REFRESH = "fr.maxence.meteo.REFRESH"
        const val ACTION_MOVED = "fr.maxence.meteo.MOVED"
        private val MAIN = Handler(Looper.getMainLooper())
        private val ICON_FRAMES = listOf(
            R.id.icon_f0, R.id.icon_f1, R.id.icon_f2, R.id.icon_f3, R.id.icon_f4, R.id.icon_f5, R.id.icon_f6, R.id.icon_f7,
        )

        fun render(context: Context, data: JSONObject?) {
            if (Looper.myLooper() == Looper.getMainLooper()) renderNow(context, data)
            else MAIN.post { runCatching { renderNow(context, data) }.onFailure { Log.w("Meteo", "Widget", it) } }
        }

        private fun renderNow(context: Context, data: JSONObject?) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, MeteoWidget::class.java))
            val style = WidgetStyle.load(context)
            val icons = Icons()
            for (id in ids) {
                val options = manager.getAppWidgetOptions(id)
                // Android 12 et plus : une mise en page par taille réelle (portrait, paysage), l'écran d'accueil
                // choisit celle qui correspond exactement à la place du widget.
                val sizes = if (Build.VERSION.SDK_INT >= 31) {
                    @Suppress("DEPRECATION")
                    options.getParcelableArrayList<SizeF>(AppWidgetManager.OPTION_APPWIDGET_SIZES)
                        ?.filter { it.width > 0 && it.height > 0 }?.distinct()?.take(4)
                } else null
                val views = if (Build.VERSION.SDK_INT >= 31 && !sizes.isNullOrEmpty()) {
                    RemoteViews(sizes.associateWith { build(context, data, it.width.toInt(), it.height.toInt(), style, icons) })
                } else {
                    // Avant Android 12 : largeur mini et hauteur maxi = taille en portrait.
                    val w = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250)
                    val h = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 110)
                    build(context, data, w, h, style, icons)
                }
                manager.updateAppWidget(id, views)
            }
        }

        /**
         * Widget pour une place de [widthDp] × [heightDp]. Le contenu est mesuré pour cette place :
         * les blocs les moins utiles sont masqués plutôt que coupés, et le petit modèle prend le relais
         * quand même l'essentiel ne tient pas.
         */
        fun build(
            context: Context, data: JSONObject?, widthDp: Int, heightDp: Int,
            style: WidgetStyle.Style = WidgetStyle.load(context), icons: Icons = Icons(),
        ): RemoteViews {
            val d = data?.let { runCatching { MeteoData.fresh(it) }.getOrDefault(it) }
            if (widthDp >= 180) {
                val (v, blocks) = full(context, d, widthDp, style, icons)
                if (fit(context, v, widthDp, heightDp, blocks)) return v
            }
            val (v, blocks) = small(context, d, style, icons)
            fit(context, v, widthDp, heightDp, blocks)
            return v
        }

        private fun num(o: JSONObject, k: String): Double? = if (o.isNull(k)) null else o.optDouble(k).takeIf { !it.isNaN() }
        private fun int(o: JSONObject, k: String) = num(o, k)?.let { Math.round(it).toString() } ?: "–"

        /** Commun aux deux modèles : appuis, apparence, icône animée et fond du ciel. */
        private fun common(context: Context, layout: Int, d: JSONObject?, style: WidgetStyle.Style, icons: Icons, iconDp: Int): RemoteViews {
            val v = RemoteViews(context.packageName, layout)
            // Appui sur le widget : l'appli complète de l'APK.
            val open = Intent(context, AppActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            v.setOnClickPendingIntent(R.id.root, PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE))
            val refresh = Intent(context, MeteoWidget::class.java).setAction(ACTION_REFRESH)
            v.setOnClickPendingIntent(R.id.refresh, PendingIntent.getBroadcast(context, 1, refresh, PendingIntent.FLAG_IMMUTABLE))
            // Un appui sur l'horloge ouvre l'horloge du téléphone.
            val alarms = PendingIntent.getActivity(context, 3, Intent(AlarmClock.ACTION_SHOW_ALARMS), PendingIntent.FLAG_IMMUTABLE)
            v.setOnClickPendingIntent(R.id.clock_small, alarms)

            WidgetStyle.apply(context, v, layout, style)
            val code = d?.optInt("code", 3) ?: 3
            val isDay = d?.optBoolean("isDay", true) ?: true
            val windy = d != null && ((num(d, "gust") ?: 0.0) >= 30 || (num(d, "wind") ?: 0.0) >= 18)
            val px = (iconDp * context.resources.displayMetrics.density).toInt()
            // Icône animée : une image par étape de la boucle (la même partout si les animations sont coupées).
            ICON_FRAMES.forEachIndexed { i, id -> v.setImageViewBitmap(id, icons.get(code, isDay, windy, px, if (style.animated) i else 0)) }
            // Fond aux couleurs du ciel de l'appli (mêmes teintes, aube et crépuscule compris).
            if (style.bgColor == WidgetStyle.WEATHER && d != null) v.setImageViewResource(R.id.bg, skyDrawable(d, code, isDay))
            return v
        }

        private fun skyDrawable(d: JSONObject, code: Int, isDay: Boolean): Int {
            val kind = WeatherArt.kind(code)
            if (kind == WeatherArt.Kind.CLEAR || kind == WeatherArt.Kind.PARTLY) {
                // Comme dayPhase() de l'appli : de 40 min avant à 50 min après le lever, de 50 min avant à 40 min après le coucher.
                val now = System.currentTimeMillis()
                val sky = Astro.day(now, d.optDouble("lat", 43.1375), d.optDouble("lon", 6.3683))
                val min = 60_000L
                val rise = sky.sunrise
                val set = sky.sunset
                if (rise != null && now in (rise - 40 * min)..(rise + 50 * min)) return R.drawable.sky_dawn
                if (set != null && now in (set - 50 * min)..(set + 40 * min)) return R.drawable.sky_dusk
            }
            return when (kind) {
                WeatherArt.Kind.CLEAR -> if (isDay) R.drawable.sky_clear_day else R.drawable.sky_clear_night
                WeatherArt.Kind.PARTLY -> if (isDay) R.drawable.sky_partly_day else R.drawable.sky_partly_night
                WeatherArt.Kind.CLOUDY -> if (isDay) R.drawable.sky_cloudy_day else R.drawable.sky_cloudy_night
                WeatherArt.Kind.FOG -> if (isDay) R.drawable.sky_fog_day else R.drawable.sky_fog_night
                WeatherArt.Kind.DRIZZLE, WeatherArt.Kind.RAIN -> if (isDay) R.drawable.sky_rain_day else R.drawable.sky_rain_night
                WeatherArt.Kind.SNOW -> if (isDay) R.drawable.sky_snow_day else R.drawable.sky_snow_night
                WeatherArt.Kind.STORM -> R.drawable.sky_storm
            }
        }

        private fun windLine(d: JSONObject) =
            "${MeteoData.arrow(num(d, "dirDeg"))} ${MeteoData.kmh(num(d, "wind"))} km/h · raf. ${MeteoData.kmh(num(d, "gust"))} ${d.optString("dir")}"

        private fun small(context: Context, d: JSONObject?, style: WidgetStyle.Style, icons: Icons): Pair<RemoteViews, List<Block>> {
            val v = common(context, R.layout.widget_small, d, style, icons, 40)
            v.setViewVisibility(R.id.clock_small, if (style.clock == WidgetStyle.CLOCK_HIDDEN) View.INVISIBLE else View.VISIBLE)
            if (d == null) {
                v.setTextViewText(R.id.wind, "Pas de données")
                v.setTextViewText(R.id.rain, "Touchez ⟳")
                return v to listOf(Block(listOf(R.id.wind)), Block(listOf(R.id.rain)))
            }
            v.setTextViewText(R.id.temp, "${int(d, "temp")}°")
            v.setTextViewText(R.id.wind, windLine(d))
            val rain = d.optString("rain")
            val sea = num(d, "sea")?.let { " · mer ${Math.round(it)}°" } ?: ""
            v.setTextViewText(R.id.rain, "💧 ${rain.ifEmpty { "${int(d, "pop")} % de pluie" }}$sea")
            return v to listOf(Block(listOf(R.id.wind)), Block(listOf(R.id.rain)))
        }

        private fun full(context: Context, d: JSONObject?, widthDp: Int, style: WidgetStyle.Style, icons: Icons): Pair<RemoteViews, List<Block>> {
            val v = common(context, R.layout.widget_meteo, d, style, icons, 56)
            val scale = style.textScale.coerceIn(50, 200) / 100f
            val blocks = mutableListOf<Block>()

            // Horloge : grande (bloc facultatif, remplacée par la petite de l'en-tête si elle ne tient pas),
            // petite dans l'en-tête, ou masquée.
            v.setViewVisibility(R.id.date, if (style.showDate) View.VISIBLE else View.GONE)
            v.setViewVisibility(R.id.clock_small, if (style.clock == WidgetStyle.CLOCK_HIDDEN) View.GONE else View.VISIBLE)
            v.setOnClickPendingIntent(R.id.clock_row, PendingIntent.getActivity(context, 3, Intent(AlarmClock.ACTION_SHOW_ALARMS), PendingIntent.FLAG_IMMUTABLE))
            v.setViewVisibility(R.id.clock_row, View.GONE)
            val clock = if (style.clock == WidgetStyle.CLOCK_BIG) Block(listOf(R.id.clock_row), hide = listOf(R.id.clock_small)) else null

            for (id in listOf(R.id.alert, R.id.tiles, R.id.strip_a, R.id.strip_b, R.id.sky, R.id.sessions)) v.setViewVisibility(id, View.GONE)
            if (d == null) {
                v.setTextViewText(R.id.cond, "Pas encore de données")
                v.setTextViewText(R.id.feels, MeteoData.lastError(context) ?: "Touchez ⟳ pour actualiser")
                v.setViewVisibility(R.id.wind, View.GONE)
                v.setViewVisibility(R.id.cond_line, View.GONE)
                v.setViewVisibility(R.id.wind_side, View.GONE)
                clock?.let { blocks += it }
                return v to blocks
            }

            // En-tête : lieu (📍 = prévision calculée pour l'endroit où l'on est) et heure de mise à jour.
            v.setTextViewText(R.id.place, (if (d.optBoolean("local")) "📍 " else "") + d.optString("place"))
            val stale = MeteoData.lastError(context)?.let { " · hors ligne" } ?: ""
            val narrowHeader = widthDp < 250 * scale
            v.setTextViewText(R.id.updated, (if (narrowHeader) "" else "maj ") + d.optString("updated") + stale)

            // Temps actuel.
            v.setTextViewText(R.id.temp, "${int(d, "temp")}°")
            v.setTextViewText(R.id.cond, d.optString("cond"))
            v.setTextViewText(R.id.feels, "Ressenti ${int(d, "feels")}° · ↓${int(d, "min")}° ↑${int(d, "max")}°")
            v.setTextViewText(R.id.wind, windLine(d))
            // À côté de la température, la flèche suffit pour la direction.
            v.setTextViewText(R.id.wind_side, "${MeteoData.arrow(num(d, "dirDeg"))} ${MeteoData.kmh(num(d, "wind"))} km/h · raf. ${MeteoData.kmh(num(d, "gust"))}")
            // Widget étroit : le ciel et le ressenti passent sous la température au lieu d'être tronqués à côté.
            val narrow = widthDp < 250 * scale
            v.setViewVisibility(R.id.hero_side, if (narrow) View.GONE else View.VISIBLE)
            v.setViewVisibility(R.id.cond_line, if (narrow) View.VISIBLE else View.GONE)
            v.setTextViewText(R.id.cond_line, "${d.optString("cond")} · ressenti ${int(d, "feels")}°")
            // Le vent se met à côté de la température (ou dessous si le widget est étroit) quand les cases sautent.
            val windAlone = if (narrow) R.id.wind else R.id.wind_side
            v.setViewVisibility(if (narrow) R.id.wind_side else R.id.wind, View.GONE)

            // Alerte la plus importante (vigilance, orage, coup de vent, pluie), teintée selon son niveau.
            val alerts = d.optJSONArray("alerts")
            var top: JSONObject? = null
            if (alerts != null) for (i in 0 until alerts.length()) {
                val a = alerts.getJSONObject(i)
                if (a.optString("type") == "session") continue
                if (top == null || a.optInt("level") > top.optInt("level")) top = a
            }
            if (top != null) {
                v.setTextViewText(R.id.alert, "⚠ ${top.optString("title")}")
                val bg = when (top.optInt("level").coerceIn(1, 4)) {
                    1 -> R.drawable.alert_bg_1
                    2 -> R.drawable.alert_bg_2
                    3 -> R.drawable.alert_bg_3
                    else -> R.drawable.alert_bg_4
                }
                v.setInt(R.id.alert, "setBackgroundResource", bg)
                blocks += Block(listOf(R.id.alert))
            }

            // Cases vent, pluie, mer, fiabilité : autant qu'il en tient en largeur.
            fillTiles(v, d, widthDp, scale)

            // Prévisions : par jour ou par heure en premier selon le réglage, l'autre ensuite s'il reste de la place.
            val cols = ((widthDp - 36) / (46 * scale)).toInt().coerceIn(3, 6)
            val hours = d.optJSONArray("h")
            val days = d.optJSONArray("d")
            val hourNow = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY)
            // En fin de journée, les jours commencent à demain.
            val dayStart = if (hourNow >= 20 && days != null && days.length() > cols) 1 else 0
            val hourList = (0 until (hours?.length() ?: 0)).mapNotNull { hours?.optJSONObject(it) }
            val dayList = (dayStart until (days?.length() ?: 0)).mapNotNull { days?.optJSONObject(it) }
            val (first, second) = if (style.daily) (dayList to true) to (hourList to false) else (hourList to false) to (dayList to true)
            // Ordre d'importance : alerte, prévision principale, grande horloge, cases, seconde prévision, soleil, sorties.
            if (fillStrip(context, v, "a", first.first, first.second, cols, icons, style)) blocks += Block(listOf(R.id.strip_a))
            clock?.let { blocks += it }
            blocks += Block(listOf(R.id.tiles), hide = listOf(windAlone))
            if (fillStrip(context, v, "b", second.first, second.second, cols, icons, style)) blocks += Block(listOf(R.id.strip_b))

            // Soleil et lune du jour, calculés ici pour le lieu affiché.
            val sky = Astro.day(System.currentTimeMillis(), d.optDouble("lat", 43.1375), d.optDouble("lon", 6.3683))
            val moon = if (widthDp < 250 * scale) "" else "    ${sky.moonEmoji} ${Astro.hm(sky.moonrise)} – ${Astro.hm(sky.moonset)}"
            v.setTextViewText(R.id.sky, "☀ ${Astro.hm(sky.sunrise)} – ${Astro.hm(sky.sunset)}$moon")
            blocks += Block(listOf(R.id.sky))

            val sessions = d.optJSONArray("sessions")
            val parts = mutableListOf<String>()
            if (sessions != null) for (i in 0 until sessions.length()) {
                val s = sessions.getJSONObject(i)
                if (s.optString("id") == "balade") continue
                parts.add("${s.optString("emoji")} ${s.optString("when")}")
            }
            if (parts.isNotEmpty()) {
                v.setTextViewText(R.id.sessions, parts.joinToString("   "))
                blocks += Block(listOf(R.id.sessions))
            }
            return v to blocks
        }

        private fun fillTiles(v: RemoteViews, d: JSONObject, widthDp: Int, scale: Float) {
            // Unité en plus petit, comme « 15 km/h » dans l'appli.
            fun small(s: String) = SpannableStringBuilder(s).apply {
                setSpan(RelativeSizeSpan(0.62f), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            v.setTextViewText(R.id.tile_wind_value, SpannableStringBuilder("${MeteoData.arrow(num(d, "dirDeg"))} ${MeteoData.kmh(num(d, "wind"))}").append(small(" km/h")))
            v.setTextViewText(R.id.tile_wind_sub, "${d.optString("dir")} · raf. ${MeteoData.kmh(num(d, "gust"))}")

            val pop = num(d, "pop") ?: 0.0
            v.setTextViewText(R.id.tile_rain_value, SpannableStringBuilder("${Math.round(pop)}").append(small(" %")))
            val rainText = d.optString("rain").takeUnless { it.isEmpty() || it.startsWith("Pas de pluie") }
            v.setTextViewText(R.id.tile_rain_sub, rainText ?: if (pop < 30) "temps sec" else "risque cette heure")

            val sea = num(d, "sea")
            if (sea != null) {
                v.setTextViewText(R.id.tile_sea_value, "${Math.round(sea)}°")
                v.setTextViewText(R.id.tile_sea_sub, num(d, "wave")?.let { "houle ${String.format(java.util.Locale.FRANCE, "%.1f", it)} m" } ?: "eau")
            }
            v.setTextViewText(R.id.tile_conf_value, SpannableStringBuilder(int(d, "confidence")).append(small(" %")))
            v.setTextViewText(R.id.tile_conf_sub, "${int(d, "sources")} modèles")

            // Une case fait au moins ~80 dp (plus si le texte est agrandi) : les dernières sautent sur un widget étroit.
            val room = ((widthDp - 28) / (80 * scale)).toInt().coerceIn(2, 4)
            val shown = listOfNotNull(R.id.tile_wind, R.id.tile_rain, if (sea != null) R.id.tile_sea else null, R.id.tile_conf).take(room)
            for (id in listOf(R.id.tile_wind, R.id.tile_rain, R.id.tile_sea, R.id.tile_conf)) v.setViewVisibility(id, if (id in shown) View.VISIBLE else View.GONE)
        }

        /** Remplit une ligne de prévision (colonnes [prefix]0 à 5) ; false si elle est vide. */
        private fun fillStrip(context: Context, v: RemoteViews, prefix: String, items: List<JSONObject>, daily: Boolean, cols: Int, icons: Icons, style: WidgetStyle.Style): Boolean {
            if (items.isEmpty()) return false
            val res = context.resources
            fun id(name: String) = res.getIdentifier("$prefix$name", "id", context.packageName)
            val iconPx = (28 * res.displayMetrics.density).toInt()
            // Ligne « risque de pluie » seulement si une colonne affichée en a.
            val popMin = 30.0
            val anyPop = items.take(cols).any { (num(it, "pop") ?: 0.0) >= popMin }
            for (i in 0 until 6) {
                val item = items.getOrNull(i)
                if (i >= cols || item == null) {
                    v.setViewVisibility(id("$i"), View.GONE)
                    continue
                }
                v.setViewVisibility(id("$i"), View.VISIBLE)
                val pop = num(item, "pop") ?: 0.0
                val wind = num(item, "wind") ?: 0.0
                if (daily) {
                    v.setTextViewText(id("${i}_t"), item.optString("day"))
                    v.setImageViewBitmap(id("${i}_icon"), icons.get(item.optInt("code", 3), true, false, iconPx, 0))
                    // Maxi, puis mini plus discret sur la même ligne.
                    val min = SpannableStringBuilder(" ${int(item, "min")}°").apply {
                        setSpan(RelativeSizeSpan(0.86f), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                        setSpan(ForegroundColorSpan((style.textColor and 0xFFFFFF) or (0xA6 shl 24)), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    }
                    v.setTextViewText(id("${i}_temp"), SpannableStringBuilder("${int(item, "max")}°").append(min))
                    v.setTextViewText(id("${i}_wind"), "${MeteoData.kmh(wind)}·${MeteoData.kmh(num(item, "gust"))}")
                } else {
                    v.setTextViewText(id("${i}_t"), item.optString("t"))
                    v.setImageViewBitmap(id("${i}_icon"), icons.get(item.optInt("code", 3), item.optBoolean("isDay", true), false, iconPx, 0))
                    v.setTextViewText(id("${i}_temp"), "${int(item, "temp")}°")
                    v.setTextViewText(id("${i}_wind"), "${MeteoData.arrow(num(item, "dirDeg"))}${MeteoData.kmh(wind)}")
                }
                v.setViewVisibility(id("${i}_pop"), if (anyPop) View.VISIBLE else View.GONE)
                v.setTextViewText(id("${i}_pop"), if (pop >= popMin) "💧${Math.round(pop)}%" else "")
                tint(v, id("${i}_wind"), MeteoData.windColor(wind))
            }
            return true
        }

        /** Pastille de vent arrondie teintée (Android 12+), sinon fond uni. */
        private fun tint(v: RemoteViews, id: Int, color: Int) {
            if (Build.VERSION.SDK_INT >= 31) v.setColorStateList(id, "setBackgroundTintList", ColorStateList.valueOf(color))
            else v.setInt(id, "setBackgroundColor", color)
        }

        /**
         * Mesure le widget dans sa place réelle, avec les mêmes textes et la même taille de police,
         * puis n'affiche les blocs facultatifs (par ordre d'importance) que s'ils tiennent en entier.
         * Renvoie false si même l'essentiel (en-tête et temps actuel) dépasse.
         */
        private fun fit(context: Context, v: RemoteViews, widthDp: Int, heightDp: Int, blocks: List<Block>): Boolean {
            val app = context.applicationContext
            val density = app.resources.displayMetrics.density
            val widthPx = (widthDp * density).toInt()
            // Petite marge : l'écran d'accueil arrondit parfois la place annoncée.
            val heightPx = ((heightDp - 2) * density).toInt()
            val root = try {
                v.apply(app, FrameLayout(app))
            } catch (e: Exception) {
                Log.e("Meteo", "Mesure du widget impossible", e)
                null
            }
            fun showRemote(b: Block, on: Boolean) {
                b.show.forEach { v.setViewVisibility(it, if (on) View.VISIBLE else View.GONE) }
                b.hide.forEach { v.setViewVisibility(it, if (on) View.GONE else View.VISIBLE) }
            }
            if (root == null) {
                // Sans mesure possible : seulement les deux premiers blocs.
                blocks.forEachIndexed { i, b -> showRemote(b, i < 2) }
                return true
            }
            val content = root.findViewById<View>(R.id.content)
            fun show(b: Block, on: Boolean) {
                b.show.forEach { root.findViewById<View>(it)?.visibility = if (on) View.VISIBLE else View.GONE }
                b.hide.forEach { root.findViewById<View>(it)?.visibility = if (on) View.GONE else View.VISIBLE }
            }
            fun fits(): Boolean {
                content.measure(
                    View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
                )
                return content.measuredHeight <= heightPx
            }
            blocks.forEach { show(it, false) }
            val baseFits = fits()
            for (b in blocks) {
                show(b, true)
                val ok = baseFits && fits()
                if (!ok) show(b, false)
                showRemote(b, ok)
            }
            return baseFits
        }
    }
}
