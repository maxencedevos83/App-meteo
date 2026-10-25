package fr.maxence.meteo

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import org.json.JSONArray

/** Graphe des 24 prochaines heures : barres de vent colorées, rafales, pluie et courbe de température. */
object ChartRenderer {

    fun render(chart: JSONArray?, widthPx: Int, heightPx: Int, density: Float): Bitmap? {
        if (chart == null || chart.length() < 2 || widthPx <= 0 || heightPx <= 0) return null
        val bmp = Bitmap.createBitmap(widthPx, heightPx, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val n = chart.length()
        val labelH = 12 * density
        val plotH = heightPx - labelH
        val slot = widthPx.toFloat() / n
        var maxWind = 20.0
        var minT = Double.MAX_VALUE
        var maxT = -Double.MAX_VALUE
        for (i in 0 until n) {
            val o = chart.getJSONObject(i)
            maxWind = maxOf(maxWind, o.optDouble("gust", 0.0))
            val t = o.optDouble("temp", Double.NaN)
            if (!t.isNaN()) { minT = minOf(minT, t); maxT = maxOf(maxT, t) }
        }

        val bar = Paint(Paint.ANTI_ALIAS_FLAG)
        val gustPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(200, 255, 255, 255); strokeWidth = 2 * density }
        val rain = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(230, 90, 170, 255) }
        val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(220, 255, 255, 255); textSize = 10 * density; textAlign = Paint.Align.CENTER }
        val tempPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(255, 200, 120); style = Paint.Style.STROKE; strokeWidth = 2 * density; strokeJoin = Paint.Join.ROUND
        }

        val tempPath = Path()
        for (i in 0 until n) {
            val o = chart.getJSONObject(i)
            val x0 = i * slot + slot * 0.15f
            val x1 = (i + 1) * slot - slot * 0.15f
            val wind = o.optDouble("wind", 0.0)
            val gust = o.optDouble("gust", wind)
            // Vent : barre colorée façon Windguru.
            val h = (wind / maxWind * plotH * 0.85).toFloat()
            bar.color = MeteoData.windColor(wind)
            c.drawRect(x0, plotH - h, x1, plotH, bar)
            val gy = (plotH - gust / maxWind * plotH * 0.85).toFloat()
            c.drawLine(x0, gy, x1, gy, gustPaint)
            // Pluie : barre bleue en bas, plus opaque si probable.
            val precip = o.optDouble("precip", 0.0)
            if (precip >= 0.1) {
                val rh = (minOf(precip, 5.0) / 5.0 * plotH * 0.5).toFloat().coerceAtLeast(3 * density)
                rain.alpha = (90 + 1.6 * o.optDouble("pop", 50.0)).toInt().coerceIn(60, 255)
                c.drawRect(x0, plotH - rh, x1, plotH, rain)
            }
            // Température.
            val t = o.optDouble("temp", Double.NaN)
            if (!t.isNaN() && maxT > minT) {
                val ty = (plotH * 0.08 + (1 - (t - minT) / (maxT - minT)) * plotH * 0.35).toFloat()
                val tx = i * slot + slot / 2
                if (tempPath.isEmpty) tempPath.moveTo(tx, ty) else tempPath.lineTo(tx, ty)
            }
            val hour = o.optInt("h", -1)
            if (hour % 6 == 0) c.drawText("${hour}h", i * slot + slot / 2, heightPx - 2 * density, text)
        }
        c.drawPath(tempPath, tempPaint)
        if (maxT > minT) {
            text.textAlign = Paint.Align.LEFT
            c.drawText("${Math.round(maxT)}°", 2 * density, plotH * 0.08f + 9 * density, text)
        }
        return bmp
    }
}
