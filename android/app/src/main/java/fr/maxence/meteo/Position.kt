package fr.maxence.meteo

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Geocoder
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import android.util.Log
import org.json.JSONObject
import java.net.URL
import java.util.Collections
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Position du téléphone (exacte si l'utilisateur l'autorise, à quelques dizaines de mètres près) et nom de la commune.
 * La dernière position connue est gardée : sans autorisation « toujours », le widget utilise
 * celle relevée à la dernière ouverture de l'appli.
 */
object Position {
    private const val PREFS = "meteo"

    // Une position plus précise que ça suffit : inutile d'attendre davantage le GPS.
    private const val GOOD_M = 50f
    // On redemande le nom de la commune dès qu'on a bougé de 500 m (les communes du littoral sont petites).
    private const val RENAME_KM = 0.5
    // Déplacement à partir duquel le widget change de prévision sans attendre son passage suivant.
    private const val MOVED_KM = 1.0

    class Place(val lat: Double, val lon: Double, val name: String)

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Le widget suit la position du téléphone (sinon, toujours le lieu principal). */
    fun follow(context: Context) = prefs(context).getBoolean("follow_gps", true)
    fun setFollow(context: Context, on: Boolean) {
        prefs(context).edit().putBoolean("follow_gps", on).apply()
        watch(context)
    }

    /** Autorisations à demander ensemble : Android propose alors « exacte » ou « approximative ». */
    val PERMISSIONS = arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)

    fun granted(context: Context) = precise(context) ||
        context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** Position exacte autorisée (sinon Android la brouille à ~2 km près, d'où une mauvaise commune). */
    fun precise(context: Context) =
        context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    fun backgroundGranted(context: Context) = Build.VERSION.SDK_INT < 29 ||
        context.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED

    /** Position actuelle, ou la dernière enregistrée ; null si jamais connue. */
    fun current(context: Context): Place? {
        val fresh = runCatching { locate(context) }.getOrNull()
        val p = prefs(context)
        if (fresh != null) {
            val lastLat = p.getFloat("pos_lat", Float.NaN).toDouble()
            val lastLon = p.getFloat("pos_lon", Float.NaN).toDouble()
            val known = p.getString("pos_name", null)
            val moved = if (lastLat.isNaN()) Double.MAX_VALUE else LocalForecast.distanceKm(lastLat, lastLon, fresh.latitude, fresh.longitude)
            val name = if (known != null && moved < RENAME_KM) known
            else cityName(context, fresh.latitude, fresh.longitude) ?: known?.takeIf { moved < 5 } ?: "Ma position"
            p.edit().putFloat("pos_lat", fresh.latitude.toFloat()).putFloat("pos_lon", fresh.longitude.toFloat())
                .putFloat("pos_acc", if (fresh.hasAccuracy()) fresh.accuracy else -1f).putLong("pos_time", fresh.time)
                .putString("pos_name", name).apply()
            Log.i("Meteo", "Position : ${fresh.provider} à ${if (fresh.hasAccuracy()) Math.round(fresh.accuracy) else "?"} m près, $name")
            return Place(round4(fresh.latitude), round4(fresh.longitude), name)
        }
        val lat = p.getFloat("pos_lat", Float.NaN)
        if (lat.isNaN()) return null
        return Place(round4(lat.toDouble()), round4(p.getFloat("pos_lon", 0f).toDouble()), p.getString("pos_name", null) ?: "Ma position")
    }

    /** Précision de la dernière position, en mètres (null si inconnue). */
    fun lastAccuracy(context: Context): Int? = prefs(context).getFloat("pos_acc", -1f).takeIf { it >= 0 }?.let { Math.round(it) }

    private fun round4(v: Double) = Math.round(v * 10_000) / 10_000.0

    /** Parmi des positions, la plus précise de celles relevées dans les 2 minutes de la plus récente. */
    private fun best(locs: List<Location>): Location? {
        val newest = locs.maxOfOrNull { it.time } ?: return null
        return locs.filter { newest - it.time < 2 * 60_000 }.minByOrNull { if (it.hasAccuracy()) it.accuracy else 10_000f }
    }

    @SuppressLint("MissingPermission") // autorisation vérifiée par granted()
    private fun locate(context: Context): Location? {
        if (!granted(context)) return null
        val lm = context.getSystemService(LocationManager::class.java) ?: return null
        val providers = lm.getProviders(true)
        val now = System.currentTimeMillis()
        val known = providers.mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }
        // Une position toute récente et précise suffit (GPS d'une autre appli, navigation…).
        val recent = best(known.filter { now - it.time < 2 * 60_000 })
        if (recent != null && recent.hasAccuracy() && recent.accuracy <= GOOD_M) return recent
        // Sinon une position neuve : on interroge en même temps tous les fournisseurs (fusionné, GPS, réseau)
        // et on garde la plus précise. Avant, la première réponse l'emportait : souvent la position
        // « réseau » (antenne, à quelques km près), d'où une commune voisine au lieu de la bonne.
        val fresh = if (Build.VERSION.SDK_INT >= 30) currentFix(context, lm, providers) else null
        // Pas de position neuve (appli en arrière-plan sans « Toujours autoriser », localisation coupée…) :
        // la plus récente connue du téléphone, si elle a moins d'une heure.
        return fresh ?: best(known.filter { now - it.time < 60 * 60_000 })
    }

    @SuppressLint("MissingPermission")
    private fun currentFix(context: Context, lm: LocationManager, providers: List<String>): Location? {
        if (Build.VERSION.SDK_INT < 30) return null
        val wanted = listOf(LocationManager.FUSED_PROVIDER, LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { it in providers }
        if (wanted.isEmpty()) return null
        val got = Collections.synchronizedList(mutableListOf<Location>())
        val waiting = AtomicInteger(wanted.size)
        val done = CountDownLatch(1)
        val cancel = CancellationSignal()
        for (provider in wanted) {
            runCatching {
                lm.getCurrentLocation(provider, cancel, context.mainExecutor) { loc ->
                    if (loc != null) got.add(loc)
                    // Fini dès qu'une position est assez précise, ou quand tous les fournisseurs ont répondu.
                    if ((loc != null && loc.hasAccuracy() && loc.accuracy <= GOOD_M) || waiting.decrementAndGet() == 0) done.countDown()
                }
            }.onFailure { if (waiting.decrementAndGet() == 0) done.countDown() }
        }
        // Le GPS peut mettre quelques secondes à se caler ; au-delà, la meilleure position reçue.
        done.await(15, TimeUnit.SECONDS)
        runCatching { cancel.cancel() }
        return best(got.toList())
    }

    /**
     * Le widget est prévenu des déplacements du téléphone (positions déjà relevées par le système ou d'autres
     * applis, sans dépense de batterie) : il change de prévision dès qu'on a bougé d'un kilomètre,
     * sans attendre son passage suivant. Demande l'autorisation « Toujours autoriser ».
     */
    @SuppressLint("MissingPermission")
    fun watch(context: Context) {
        runCatching {
            val lm = context.getSystemService(LocationManager::class.java) ?: return
            val pending = movedIntent(context)
            if (!follow(context) || !granted(context) || !backgroundGranted(context)) {
                lm.removeUpdates(pending)
                return
            }
            lm.requestLocationUpdates(LocationManager.PASSIVE_PROVIDER, 5 * 60_000L, (MOVED_KM * 1000).toFloat(), pending)
        }.onFailure { Log.w("Meteo", "Suivi des déplacements impossible : $it") }
    }

    private fun movedIntent(context: Context): PendingIntent {
        val intent = Intent(context, MeteoWidget::class.java).setAction(MeteoWidget.ACTION_MOVED)
        val mutable = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        return PendingIntent.getBroadcast(context, 5, intent, PendingIntent.FLAG_UPDATE_CURRENT or mutable)
    }

    /** Vrai si cette position est à plus d'un kilomètre de celle de la prévision affichée. */
    fun movedFar(context: Context, loc: Location): Boolean {
        val p = prefs(context)
        val lat = p.getFloat("pos_lat", Float.NaN).toDouble()
        if (lat.isNaN()) return true
        return LocalForecast.distanceKm(lat, p.getFloat("pos_lon", 0f).toDouble(), loc.latitude, loc.longitude) >= MOVED_KM
    }

    private fun cityName(context: Context, lat: Double, lon: Double): String? {
        @Suppress("DEPRECATION")
        val fromPhone = runCatching {
            if (!Geocoder.isPresent()) null
            else Geocoder(context, Locale.FRANCE).getFromLocation(lat, lon, 1)?.firstOrNull()?.let { it.locality ?: it.subAdminArea }
        }.getOrNull()
        if (fromPhone != null) return fromPhone
        return runCatching {
            val json = JSONObject(URL("https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=$lat&longitude=$lon&localityLanguage=fr").readText())
            json.optString("city").ifEmpty { json.optString("locality") }.ifEmpty { null }
        }.getOrNull()
    }
}
