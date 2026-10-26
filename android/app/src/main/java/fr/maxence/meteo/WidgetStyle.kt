package fr.maxence.meteo

import android.content.Context
import android.graphics.Color
import android.util.TypedValue
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.RemoteViews
import android.widget.TextView

/** Apparence du widget réglée dans l'appli : fond, transparence, texte, taille, horloge. */
object WidgetStyle {
    private const val PREFS = "meteo"

    const val CLOCK_BIG = 0
    const val CLOCK_SMALL = 1
    const val CLOCK_HIDDEN = 2

    /** Fond aux couleurs du ciel (valeur réservée, jamais une couleur choisie : celles-ci sont opaques). */
    const val WEATHER = 1

    /** bgColor = 0 garde le dégradé bleu d'origine, WEATHER suit le ciel ; opacity et textScale en %. */
    data class Style(
        val bgColor: Int = WEATHER,
        val opacity: Int = 100,
        val textColor: Int = Color.WHITE,
        val textScale: Int = 100,
        val clock: Int = CLOCK_BIG,
        val showDate: Boolean = true,
        // Prévision du widget par jour (sinon par heure).
        val daily: Boolean = true,
        // Icône animée (sinon image fixe).
        val animated: Boolean = true,
    )

    val BACKGROUNDS = listOf(
        "Selon la météo" to WEATHER,
        "Bleu (d'origine)" to 0,
        "Noir" to Color.BLACK,
        "Anthracite" to Color.rgb(43, 47, 54),
        "Bleu nuit" to Color.rgb(15, 30, 61),
        "Bleu mer" to Color.rgb(11, 110, 153),
        "Turquoise" to Color.rgb(0, 140, 140),
        "Vert" to Color.rgb(30, 107, 79),
        "Violet" to Color.rgb(75, 42, 123),
        "Corail" to Color.rgb(214, 90, 70),
        "Blanc" to Color.WHITE,
    )

    val TEXT_COLORS = listOf(
        "Blanc" to Color.WHITE,
        "Noir" to Color.rgb(17, 17, 17),
        "Gris clair" to Color.rgb(220, 220, 220),
        "Jaune" to Color.rgb(255, 226, 122),
        "Bleu clair" to Color.rgb(184, 225, 255),
        "Orange" to Color.rgb(255, 176, 90),
    )

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(context: Context): Style {
        val p = prefs(context)
        val d = Style()
        return Style(
            bgColor = p.getInt("style_bg", d.bgColor),
            opacity = p.getInt("style_opacity", d.opacity),
            textColor = p.getInt("style_text", d.textColor),
            textScale = p.getInt("style_scale", d.textScale),
            clock = p.getInt("style_clock", d.clock),
            showDate = p.getBoolean("style_date", d.showDate),
            daily = p.getBoolean("style_daily", d.daily),
            animated = p.getBoolean("style_anim", d.animated),
        )
    }

    fun save(context: Context, s: Style) {
        prefs(context).edit()
            .putInt("style_bg", s.bgColor)
            .putInt("style_opacity", s.opacity)
            .putInt("style_text", s.textColor)
            .putInt("style_scale", s.textScale)
            .putInt("style_clock", s.clock)
            .putBoolean("style_date", s.showDate)
            .putBoolean("style_daily", s.daily)
            .putBoolean("style_anim", s.animated)
            .apply()
    }

    fun reset(context: Context) = save(context, Style())

    /** Lit "#RRGGBB" ou "#AARRGGBB" ; null si invalide. */
    fun parseColor(text: String): Int? {
        val t = text.trim().let { if (it.startsWith("#")) it else "#$it" }
        return runCatching { Color.parseColor(t) }.getOrNull()
    }

    fun hex(color: Int) = String.format("#%06X", color and 0xFFFFFF)

    // Textes d'une mise en page : taille d'origine, opacité d'origine, et s'ils prennent la couleur choisie.
    private class TextInfo(val id: Int, val sizePx: Float, val alpha: Int, val recolor: Boolean)

    private val cache = HashMap<Int, List<TextInfo>>()

    // Les tailles et couleurs d'origine sont lues dans la mise en page elle-même, pour ne pas les dupliquer ici.
    @Synchronized
    private fun texts(context: Context, layout: Int): List<TextInfo> = cache.getOrPut(layout) {
        val app = context.applicationContext
        val out = mutableListOf<TextInfo>()
        fun walk(view: View) {
            if (view is TextView && view.id != View.NO_ID) {
                val name = app.resources.getResourceEntryName(view.id)
                // Les pastilles de vent (texte foncé sur couleur) et le bandeau d'alerte gardent leurs couleurs.
                val fixed = name == "alert" || name == "icon" || Regex("[hd]\\d_(wind|icon)").matches(name)
                out.add(TextInfo(view.id, view.textSize, Color.alpha(view.currentTextColor), !fixed))
            }
            if (view is ViewGroup) for (i in 0 until view.childCount) walk(view.getChildAt(i))
        }
        walk(LayoutInflater.from(app).inflate(layout, null))
        out
    }

    fun apply(context: Context, v: RemoteViews, layout: Int, s: Style) {
        // Filtre de couleur sur le fond arrondi : transparent (0) = dégradé d'origine conservé.
        // Le fond « selon la météo » est posé ensuite par le widget, une fois la prévision connue.
        v.setImageViewResource(R.id.bg, R.drawable.widget_bg)
        v.setInt(R.id.bg, "setColorFilter", if (s.bgColor == WEATHER) 0 else s.bgColor)
        v.setInt(R.id.bg, "setImageAlpha", (s.opacity.coerceIn(0, 100) * 255) / 100)
        val scale = s.textScale.coerceIn(50, 200) / 100f
        for (t in texts(context, layout)) {
            v.setTextViewTextSize(t.id, TypedValue.COMPLEX_UNIT_PX, t.sizePx * scale)
            if (t.recolor) v.setTextColor(t.id, (s.textColor and 0xFFFFFF) or (t.alpha shl 24))
        }
    }
}
