package fr.maxence.meteo

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.util.Log
import android.view.View
import android.widget.FrameLayout
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * Aperçus du widget à plusieurs tailles et réglages, enregistrés en PNG pour l'essai sur émulateur
 * (scripts/android/smoke.sh les récupère). Lancés seulement avec l'option « apercus » de MainActivity.
 */
object WidgetPreviews {
    private class Case(val name: String, val w: Int, val h: Int, val style: WidgetStyle.Style)

    fun render(activity: Activity) {
        val dir = File(activity.getExternalFilesDir(null), "apercus").apply { mkdirs() }
        val cached = MeteoData.cached(activity) ?: run { Log.w("Meteo", "Aperçus : pas encore de prévision"); return }
        // Cas le plus chargé : une alerte et la mer, comme au Lavandou (valeurs d'exemple si absentes).
        val d = JSONObject(cached.toString())
        if ((d.optJSONArray("alerts")?.length() ?: 0) == 0) {
            d.put("alerts", JSONArray().put(JSONObject().put("type", "vent").put("level", 3).put("title", "Coup de vent : rafales 69 km/h")))
        }
        if (d.isNull("sea") || !d.has("sea")) d.put("sea", 17).put("wave", 0.6)

        val base = WidgetStyle.Style()
        val cases = listOf(
            Case("4x2", 360, 180, base),
            Case("4x3", 360, 270, base),
            Case("4x4", 360, 360, base),
            Case("4x5", 360, 450, base),
            Case("4x2-texte130", 360, 180, base.copy(textScale = 130)),
            Case("4x4-texte130", 360, 360, base.copy(textScale = 130)),
            Case("4x4-petite-horloge-par-heure-opacite60", 360, 340, base.copy(clock = WidgetStyle.CLOCK_SMALL, daily = false, opacity = 60)),
            Case("4x3-sans-horloge-texte120", 360, 280, base.copy(clock = WidgetStyle.CLOCK_HIDDEN, textScale = 120)),
            Case("3x2", 270, 180, base),
            Case("2x2", 180, 180, base),
            Case("4x1", 360, 90, base),
            Case("2x1", 170, 80, base),
        )
        val density = activity.resources.displayMetrics.density
        val shots = mutableListOf<Pair<String, Bitmap>>()
        for (c in cases) {
            val w = (c.w * density).toInt()
            val h = (c.h * density).toInt()
            val view = MeteoWidget.build(activity, d, c.w, c.h, c.style).apply(activity, FrameLayout(activity))
            view.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
            view.layout(0, 0, w, h)
            val pad = (16 * density).toInt()
            val bmp = Bitmap.createBitmap(w + 2 * pad, h + 2 * pad, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bmp)
            // Fond d'écran clair et chargé (le cas le plus difficile à lire).
            canvas.drawPaint(Paint().apply {
                shader = LinearGradient(0f, 0f, bmp.width * 0.3f, bmp.height.toFloat(), Color.rgb(214, 218, 222), Color.rgb(150, 130, 105), Shader.TileMode.CLAMP)
            })
            canvas.translate(pad.toFloat(), pad.toFloat())
            view.draw(canvas)
            FileOutputStream(File(dir, "${c.name}.png")).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
            shots += c.name to bmp
            // Ce qui est affiché, et la hauteur du contenu par rapport à la place (jamais plus grande).
            val content = view.findViewById<View>(R.id.content)
            content.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
            val shown = listOf("clock_row", "header", "hero", "cond_line", "wind", "wind_side", "alert", "tiles", "strip_a", "strip_b", "sky", "sessions").filter { name ->
                val id = activity.resources.getIdentifier(name, "id", activity.packageName)
                id != 0 && view.findViewById<View>(id)?.visibility == View.VISIBLE
            }
            Log.i("Meteo", "Aperçu ${c.name} (${c.w}×${c.h} dp) : contenu ${(content.measuredHeight / density).toInt()} dp, affiché : ${shown.joinToString(", ")}")
        }
        // Planche de tous les aperçus, en petit, pour les regarder d'un coup.
        val scale = 1.3f / density
        val cell = shots.maxOf { it.second.width } * scale
        val rowH = shots.maxOf { it.second.height } * scale
        val perRow = 3
        val rows = (shots.size + perRow - 1) / perRow
        val sheet = Bitmap.createBitmap((cell * perRow).toInt(), (rowH * rows).toInt(), Bitmap.Config.ARGB_8888)
        val sc = Canvas(sheet)
        sc.drawColor(Color.rgb(40, 40, 40))
        val label = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 12f }
        shots.forEachIndexed { i, (name, bmp) ->
            sc.save()
            sc.translate((i % perRow) * cell, (i / perRow) * rowH)
            sc.scale(scale, scale)
            sc.drawBitmap(bmp, 0f, 0f, null)
            sc.restore()
            sc.drawText(name, (i % perRow) * cell + 4, (i / perRow) * rowH + 12, label)
        }
        FileOutputStream(File(dir, "planche.jpg")).use { sheet.compress(Bitmap.CompressFormat.JPEG, 72, it) }
        Log.i("Meteo", "Aperçus du widget prêts : ${cases.size}")
    }
}
