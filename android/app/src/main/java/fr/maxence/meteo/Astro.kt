package fr.maxence.meteo

import java.util.Calendar
import java.util.TimeZone
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.roundToLong
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * Lever et coucher du soleil et de la lune, phase de la lune (formules de SunCalc, précision ~1 min),
 * calculés sur le téléphone : toujours justes, même quand la prévision publiée date un peu.
 * Mêmes calculs que web/js/astro.js.
 */
object Astro {
    private const val RAD = PI / 180
    private const val DAY_MS = 86_400_000.0
    private const val J1970 = 2440588.0
    private const val J2000 = 2451545.0
    private const val J0 = 0.0009
    private val E = RAD * 23.4397

    class Day(val sunrise: Long?, val sunset: Long?, val moonrise: Long?, val moonset: Long?, val phase: Double, val lit: Int) {
        val moonEmoji get() = phaseOf(phase).first
        val moonName get() = phaseOf(phase).second
    }

    private fun toDays(ms: Long) = ms / DAY_MS - 0.5 + J1970 - J2000
    private fun fromJulian(j: Double) = ((j + 0.5 - J1970) * DAY_MS).roundToLong()
    private fun rightAscension(l: Double, b: Double) = atan2(sin(l) * cos(E) - tan(b) * sin(E), cos(l))
    private fun declination(l: Double, b: Double) = asin(sin(b) * cos(E) + cos(b) * sin(E) * sin(l))
    private fun altitude(h: Double, phi: Double, dec: Double) = asin(sin(phi) * sin(dec) + cos(phi) * cos(dec) * cos(h))
    private fun siderealTime(d: Double, lw: Double) = RAD * (280.16 + 360.9856235 * d) - lw
    private fun solarMeanAnomaly(d: Double) = RAD * (357.5291 + 0.98560028 * d)
    private fun eclipticLongitude(m: Double) =
        m + RAD * (1.9148 * sin(m) + 0.02 * sin(2 * m) + 0.0003 * sin(3 * m)) + RAD * 102.9372 + PI

    private class Coords(val ra: Double, val dec: Double, val dist: Double = 0.0)

    private fun sunCoords(d: Double): Coords {
        val l = eclipticLongitude(solarMeanAnomaly(d))
        return Coords(rightAscension(l, 0.0), declination(l, 0.0))
    }

    private fun moonCoords(d: Double): Coords {
        val l0 = RAD * (218.316 + 13.176396 * d)
        val m = RAD * (134.963 + 13.064993 * d)
        val f = RAD * (93.272 + 13.22935 * d)
        val l = l0 + RAD * 6.289 * sin(m)
        val b = RAD * 5.128 * sin(f)
        return Coords(rightAscension(l, b), declination(l, b), 385001 - 20905 * cos(m))
    }

    /** Lever et coucher du soleil (ms) autour de l'instant donné. */
    fun sunTimes(ms: Long, lat: Double, lon: Double): Pair<Long?, Long?> {
        val lw = RAD * -lon
        val phi = RAD * lat
        val d = toDays(ms)
        val n = Math.round(d - J0 - lw / (2 * PI)).toDouble()
        val ds = J0 + lw / (2 * PI) + n
        val m = solarMeanAnomaly(ds)
        val l = eclipticLongitude(m)
        val dec = declination(l, 0.0)
        fun transit(a: Double) = J2000 + a + 0.0053 * sin(m) - 0.0069 * sin(2 * l)
        val noon = transit(ds)
        val w = acos((sin(-0.833 * RAD) - sin(phi) * sin(dec)) / (cos(phi) * cos(dec)))
        if (w.isNaN()) return null to null
        val set = transit(J0 + (w + lw) / (2 * PI) + n)
        return fromJulian(noon - (set - noon)) to fromJulian(set)
    }

    private fun moonAltitude(ms: Long, lat: Double, lon: Double): Double {
        val lw = RAD * -lon
        val d = toDays(ms)
        val c = moonCoords(d)
        val h = altitude(siderealTime(d, lw) - c.ra, RAD * lat, c.dec)
        val hh = max(h, 0.0)
        return h + 0.0002967 / tan(hh + 0.00312536 / (hh + 0.08901179)) // réfraction
    }

    /** Lever et coucher de la lune (ms) pendant les 24 h qui suivent t0 (minuit local). */
    fun moonTimes(t0: Long, lat: Double, lon: Double): Pair<Long?, Long?> {
        val hc = 0.133 * RAD
        fun at(hours: Int) = moonAltitude(t0 + hours * 3_600_000L, lat, lon) - hc
        var h0 = at(0)
        var rise: Double? = null
        var set: Double? = null
        var i = 1
        while (i <= 24) {
            val h1 = at(i)
            val h2 = at(i + 1)
            val a = (h0 + h2) / 2 - h1
            val b = (h2 - h0) / 2
            val xe = -b / (2 * a)
            val ye = (a * xe + b) * xe + h1
            val disc = b * b - 4 * a * h1
            var roots = 0
            var x1 = 0.0
            var x2 = 0.0
            if (disc >= 0) {
                val dx = sqrt(disc) / (abs(a) * 2)
                x1 = xe - dx
                x2 = xe + dx
                if (abs(x1) <= 1) roots++
                if (abs(x2) <= 1) roots++
                if (x1 < -1) x1 = x2
            }
            if (roots == 1) {
                if (h0 < 0) rise = i + x1 else set = i + x1
            } else if (roots == 2) {
                rise = i + if (ye < 0) x2 else x1
                set = i + if (ye < 0) x1 else x2
            }
            if (rise != null && set != null) break
            h0 = h2
            i += 2
        }
        fun toMs(h: Double?) = h?.let { t0 + (it * 3_600_000).roundToLong() }
        return toMs(rise) to toMs(set)
    }

    /** Phase de la lune (0 = nouvelle, 0,5 = pleine) et part éclairée en %. */
    fun moonPhase(ms: Long): Pair<Double, Int> {
        val d = toDays(ms)
        val s = sunCoords(d)
        val m = moonCoords(d)
        val sdist = 149598000.0
        val phi = acos(sin(s.dec) * sin(m.dec) + cos(s.dec) * cos(m.dec) * cos(s.ra - m.ra))
        val inc = atan2(sdist * sin(phi), m.dist - sdist * cos(phi))
        val angle = atan2(cos(s.dec) * sin(s.ra - m.ra), sin(s.dec) * cos(m.dec) - cos(s.dec) * sin(m.dec) * cos(s.ra - m.ra))
        val phase = 0.5 + 0.5 * inc * (if (angle < 0) -1 else 1) / PI
        return phase to Math.round((1 + cos(inc)) / 2 * 100).toInt()
    }

    private val PHASES = listOf(
        0.02 to ("🌑" to "Nouvelle lune"), 0.23 to ("🌒" to "Premier croissant"), 0.27 to ("🌓" to "Premier quartier"),
        0.48 to ("🌔" to "Gibbeuse croissante"), 0.52 to ("🌕" to "Pleine lune"), 0.73 to ("🌖" to "Gibbeuse décroissante"),
        0.77 to ("🌗" to "Dernier quartier"), 0.98 to ("🌘" to "Dernier croissant"), 1.01 to ("🌑" to "Nouvelle lune"),
    )

    fun phaseOf(phase: Double) = PHASES.first { phase < it.first }.second

    /** Soleil et lune de la journée locale (fuseau du téléphone) qui contient l'instant donné. */
    fun day(ms: Long, lat: Double, lon: Double): Day {
        val c = Calendar.getInstance(TimeZone.getDefault()).apply {
            timeInMillis = ms
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }
        val t0 = c.timeInMillis
        val (sunrise, sunset) = sunTimes(t0 + 12 * 3_600_000L, lat, lon)
        val (moonrise, moonset) = moonTimes(t0, lat, lon)
        val (phase, lit) = moonPhase(t0 + 12 * 3_600_000L)
        return Day(sunrise, sunset, moonrise, moonset, phase, lit)
    }

    /** Il fait jour à cet instant (entre le lever et le coucher du soleil). */
    fun isDay(ms: Long, lat: Double, lon: Double): Boolean {
        val d = day(ms, lat, lon)
        return d.sunrise != null && d.sunset != null && ms >= d.sunrise && ms < d.sunset
    }

    /** « 7h03 » à l'heure du téléphone. */
    fun hm(ms: Long?): String {
        if (ms == null) return "–"
        val c = Calendar.getInstance().apply { timeInMillis = ms }
        return String.format(java.util.Locale.ROOT, "%dh%02d", c.get(Calendar.HOUR_OF_DAY), c.get(Calendar.MINUTE))
    }
}
