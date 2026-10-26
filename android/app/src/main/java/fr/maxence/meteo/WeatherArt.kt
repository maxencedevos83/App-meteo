package fr.maxence.meteo

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/**
 * Dessins météo du widget, image par image : le widget les fait défiler en boucle (ViewFlipper),
 * ce qui anime le soleil, la pluie, la neige, les éclairs et le vent sans rien installer.
 * Tout est dessiné dans un carré de 100 × 100 unités, mis à l'échelle de l'image.
 */
object WeatherArt {
    const val FRAMES = 8

    enum class Kind { CLEAR, PARTLY, CLOUDY, FOG, DRIZZLE, RAIN, SNOW, STORM }

    fun kind(code: Int): Kind = when (code) {
        0, 1 -> Kind.CLEAR
        2 -> Kind.PARTLY
        45, 48 -> Kind.FOG
        in 51..57 -> Kind.DRIZZLE
        in 61..67, in 80..82 -> Kind.RAIN
        in 71..77, 85, 86 -> Kind.SNOW
        in 95..99 -> Kind.STORM
        else -> Kind.CLOUDY
    }

    private val TAU = (2 * PI).toFloat()
    private fun p(color: Int, style: Paint.Style = Paint.Style.FILL) = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color; this.style = style }

    /** Image n° [frame] (0 à FRAMES-1) de l'icône animée. */
    fun icon(code: Int, isDay: Boolean, windy: Boolean, sizePx: Int, frame: Int): Bitmap {
        val bmp = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.scale(sizePx / 100f, sizePx / 100f)
        val t = (frame % FRAMES).toFloat() / FRAMES
        when (kind(code)) {
            Kind.CLEAR -> if (isDay) sun(c, 50f, 50f, 22f, t) else night(c, 50f, 50f, t)
            Kind.PARTLY -> {
                if (isDay) sun(c, 62f, 36f, 17f, t) else moon(c, 64f, 34f, 15f)
                cloud(c, 44f + 2.5f * sin(TAU * t), 62f, 1f, Color.WHITE)
            }
            Kind.CLOUDY -> {
                cloud(c, 62f - 3f * sin(TAU * t), 40f, 0.8f, Color.rgb(176, 186, 198))
                cloud(c, 42f + 3f * sin(TAU * t), 62f, 1f, Color.rgb(236, 240, 245))
            }
            Kind.FOG -> fog(c, t)
            Kind.DRIZZLE -> {
                if (isDay) sun(c, 66f, 30f, 14f, t)
                cloud(c, 48f, 44f, 1f, Color.rgb(222, 228, 236))
                drops(c, t, count = 4, length = 5f, speed = 1f, color = Color.rgb(120, 190, 255), slant = if (windy) 6f else 2f)
            }
            Kind.RAIN -> {
                cloud(c, 50f, 40f, 1.05f, Color.rgb(160, 172, 188))
                drops(c, t, count = 6, length = 9f, speed = 1f, color = Color.rgb(90, 170, 255), slant = if (windy) 10f else 3f)
            }
            Kind.SNOW -> {
                cloud(c, 50f, 40f, 1.05f, Color.rgb(226, 232, 240))
                flakes(c, t)
            }
            Kind.STORM -> storm(c, t)
        }
        if (windy && kind(code) != Kind.FOG) wind(c, t)
        return bmp
    }

    // --- Éléments ---

    private fun sun(c: Canvas, cx: Float, cy: Float, r: Float, t: Float) {
        // Halo qui respire.
        val glow = 1f + 0.12f * sin(TAU * t)
        val halo = p(0).apply {
            shader = RadialGradient(cx, cy, r * 2.1f * glow, Color.argb(120, 255, 210, 80), Color.argb(0, 255, 210, 80), Shader.TileMode.CLAMP)
        }
        c.drawCircle(cx, cy, r * 2.1f * glow, halo)
        // Rayons qui tournent : 12 rayons, un tour de 30° par boucle pour un enchaînement sans saut.
        val ray = p(Color.rgb(255, 196, 40)).apply { strokeWidth = r * 0.16f; strokeCap = Paint.Cap.ROUND }
        for (i in 0 until 12) {
            val a = TAU * i / 12 + TAU / 12 * t
            val inner = r * 1.3f
            val outer = r * (if (i % 2 == 0) 1.75f else 1.55f)
            c.drawLine(cx + inner * cos(a), cy + inner * sin(a), cx + outer * cos(a), cy + outer * sin(a), ray)
        }
        val body = p(0).apply {
            shader = RadialGradient(cx - r * 0.3f, cy - r * 0.3f, r * 1.3f, Color.rgb(255, 236, 120), Color.rgb(255, 160, 20), Shader.TileMode.CLAMP)
        }
        c.drawCircle(cx, cy, r, body)
    }

    private fun moon(c: Canvas, cx: Float, cy: Float, r: Float) {
        val layer = c.saveLayer(null, null)
        c.drawCircle(cx, cy, r * 1.6f, p(Color.argb(40, 255, 245, 200)))
        c.drawCircle(cx, cy, r, p(Color.rgb(250, 240, 200)))
        c.drawCircle(cx + r * 0.55f, cy - r * 0.35f, r * 0.85f, p(0).apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR) })
        c.restoreToCount(layer)
    }

    private fun night(c: Canvas, cx: Float, cy: Float, t: Float) {
        moon(c, cx - 4f, cy, 24f)
        // Étoiles qui scintillent chacune à leur rythme.
        val stars = listOf(Triple(80f, 22f, 0f), Triple(18f, 20f, 0.3f), Triple(86f, 62f, 0.55f), Triple(22f, 78f, 0.8f), Triple(62f, 88f, 0.15f))
        for ((x, y, phase) in stars) {
            val a = 0.25f + 0.75f * abs(sin(PI.toFloat() * (t + phase)))
            star(c, x, y, 4.5f, Color.argb((255 * a).toInt(), 255, 250, 220))
        }
    }

    private fun star(c: Canvas, x: Float, y: Float, r: Float, color: Int) {
        val path = Path()
        for (i in 0 until 8) {
            val a = TAU * i / 8 - TAU / 4
            val rr = if (i % 2 == 0) r else r * 0.35f
            if (i == 0) path.moveTo(x + rr * cos(a), y + rr * sin(a)) else path.lineTo(x + rr * cos(a), y + rr * sin(a))
        }
        path.close()
        c.drawPath(path, p(color))
    }

    private fun cloud(c: Canvas, cx: Float, cy: Float, s: Float, color: Int) {
        val shadow = p(Color.argb(45, 0, 20, 50))
        val body = p(color)
        val shade = p(0).apply {
            shader = LinearGradient(0f, cy - 22f * s, 0f, cy + 14f * s, color, darker(color, 0.82f), Shader.TileMode.CLAMP)
        }
        fun shape(dx: Float, dy: Float, paint: Paint) {
            c.drawCircle(cx - 16f * s + dx, cy + 2f * s + dy, 12f * s, paint)
            c.drawCircle(cx + dx, cy - 6f * s + dy, 17f * s, paint)
            c.drawCircle(cx + 17f * s + dx, cy + 1f * s + dy, 13f * s, paint)
            c.drawRoundRect(RectF(cx - 28f * s + dx, cy + 1f * s + dy, cx + 30f * s + dx, cy + 14f * s + dy), 7f * s, 7f * s, paint)
        }
        shape(1.5f * s, 2.5f * s, shadow)
        shape(0f, 0f, body)
        shape(0f, 0f, shade)
    }

    private fun darker(color: Int, f: Float) =
        Color.rgb((Color.red(color) * f).toInt(), (Color.green(color) * f).toInt(), (Color.blue(color) * f).toInt())

    private fun drops(c: Canvas, t: Float, count: Int, length: Float, speed: Float, color: Int, slant: Float) {
        val paint = p(color).apply { strokeWidth = 2.6f; strokeCap = Paint.Cap.ROUND }
        val top = 56f
        val fall = 40f
        for (i in 0 until count) {
            val x = 28f + i * (46f / (count - 1).coerceAtLeast(1))
            // Chaque goutte a son décalage ; la position boucle exactement sur un cycle.
            val phase = ((t * speed + i * 0.37f) % 1f)
            val y = top + phase * fall
            paint.alpha = (255 * (1f - phase * 0.7f)).toInt()
            c.drawLine(x - slant * phase, y, x - slant * phase - slant * 0.3f, y + length, paint)
        }
    }

    private fun flakes(c: Canvas, t: Float) {
        val paint = p(Color.WHITE)
        for (i in 0 until 6) {
            val phase = (t + i * 0.29f) % 1f
            val x = 26f + i * 10f + 3f * sin(TAU * (phase + i * 0.2f))
            val y = 56f + phase * 38f
            paint.alpha = (255 * (1f - phase * 0.5f)).toInt()
            c.drawCircle(x, y, 2.6f, paint)
        }
    }

    private fun storm(c: Canvas, t: Float) {
        val frame = Math.round(t * FRAMES)
        // Éclair sur deux images de la boucle, avec un nuage illuminé.
        val flash = frame == 2 || frame == 3 || frame == 6
        if (flash) c.drawCircle(50f, 44f, 42f, p(0).apply {
            shader = RadialGradient(50f, 44f, 42f, Color.argb(110, 255, 250, 200), Color.argb(0, 255, 250, 200), Shader.TileMode.CLAMP)
        })
        drops(c, t, count = 5, length = 8f, speed = 1.2f, color = Color.rgb(120, 150, 220), slant = 5f)
        cloud(c, 50f, 38f, 1.08f, if (flash) Color.rgb(150, 150, 175) else Color.rgb(95, 100, 125))
        if (flash) {
            val bolt = Path().apply {
                moveTo(54f, 46f); lineTo(42f, 68f); lineTo(51f, 68f); lineTo(44f, 92f); lineTo(64f, 62f); lineTo(54f, 62f); lineTo(61f, 46f); close()
            }
            c.drawPath(bolt, p(Color.rgb(255, 222, 60)))
            c.drawPath(bolt, p(Color.rgb(255, 255, 220), Paint.Style.STROKE).apply { strokeWidth = 1.5f })
        }
    }

    private fun fog(c: Canvas, t: Float) {
        cloud(c, 50f, 34f, 0.85f, Color.rgb(210, 216, 224))
        val paint = p(Color.argb(210, 230, 235, 240)).apply { strokeWidth = 5f; strokeCap = Paint.Cap.ROUND }
        for (i in 0 until 3) {
            val dx = 6f * sin(TAU * (t + i * 0.33f))
            val y = 60f + i * 12f
            c.drawLine(18f + dx + i * 4, y, 82f + dx - i * 4, y, paint)
        }
    }

    private fun wind(c: Canvas, t: Float) {
        // Traits de vent en pointillés qui défilent.
        val period = 40f
        val paint = p(Color.argb(220, 255, 255, 255), Paint.Style.STROKE).apply {
            strokeWidth = 2.4f; strokeCap = Paint.Cap.ROUND
            pathEffect = DashPathEffect(floatArrayOf(22f, 18f), -t * period)
        }
        for ((y, w) in listOf(20f to 1f, 80f to 0.8f, 92f to 0.6f)) {
            val path = Path().apply {
                moveTo(4f, y)
                cubicTo(30f, y - 6f * w, 60f, y + 6f * w, 96f, y - 2f)
            }
            c.drawPath(path, paint)
        }
    }

    // --- Fond selon le ciel ---

    private fun sky(kind: Kind, isDay: Boolean): IntArray = when (kind) {
        Kind.CLEAR -> if (isDay) intArrayOf(Color.rgb(36, 120, 220), Color.rgb(90, 190, 245)) else intArrayOf(Color.rgb(10, 16, 40), Color.rgb(40, 56, 104))
        Kind.PARTLY -> if (isDay) intArrayOf(Color.rgb(52, 112, 196), Color.rgb(120, 176, 226)) else intArrayOf(Color.rgb(20, 30, 48), Color.rgb(44, 64, 92))
        Kind.CLOUDY, Kind.FOG -> if (isDay) intArrayOf(Color.rgb(84, 102, 122), Color.rgb(138, 154, 172)) else intArrayOf(Color.rgb(36, 46, 60), Color.rgb(66, 78, 94))
        Kind.DRIZZLE, Kind.RAIN -> if (isDay) intArrayOf(Color.rgb(48, 66, 84), Color.rgb(88, 112, 130)) else intArrayOf(Color.rgb(22, 30, 42), Color.rgb(48, 60, 76))
        Kind.SNOW -> if (isDay) intArrayOf(Color.rgb(98, 124, 170), Color.rgb(176, 194, 222)) else intArrayOf(Color.rgb(40, 50, 80), Color.rgb(84, 98, 130))
        Kind.STORM -> intArrayOf(Color.rgb(34, 22, 54), Color.rgb(74, 58, 104))
    }

    /** Fond arrondi aux couleurs du ciel, dessiné à la taille du widget (divisée par 2 pour la mémoire). */
    fun background(code: Int, isDay: Boolean, widthPx: Int, heightPx: Int, radiusPx: Float): Bitmap {
        val w = (widthPx / 2).coerceIn(40, 800)
        val h = (heightPx / 2).coerceIn(40, 800)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        val colors = sky(kind(code), isDay)
        val paint = p(0).apply { shader = LinearGradient(0f, 0f, w * 0.4f, h.toFloat(), colors[0], colors[1], Shader.TileMode.CLAMP) }
        val r = radiusPx / 2
        c.drawRoundRect(RectF(0f, 0f, w.toFloat(), h.toFloat()), r, r, paint)
        // Lueur douce du soleil ou de la lune dans le coin.
        if (kind(code) == Kind.CLEAR || kind(code) == Kind.PARTLY) {
            val glow = if (isDay) Color.argb(90, 255, 230, 150) else Color.argb(50, 200, 210, 255)
            c.save()
            c.clipRect(0f, 0f, w.toFloat(), h.toFloat())
            c.drawCircle(w * 0.12f, h * 0.15f, h * 0.9f, p(0).apply {
                shader = RadialGradient(w * 0.12f, h * 0.15f, h * 0.9f, glow, Color.argb(0, 255, 255, 255), Shader.TileMode.CLAMP)
            })
            c.restore()
        }
        return bmp
    }
}
