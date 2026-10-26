package fr.maxence.meteo

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Geocoder
import android.location.Location
import android.location.LocationManager
import android.os.Build
import org.json.JSONObject
import java.net.URL
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Position approximative du téléphone (précision de la ville, sans GPS fin) et nom de la ville.
 * La dernière position connue est gardée : sans autorisation « toujours », le widget utilise
 * celle relevée à la dernière ouverture de l'appli.
 */
object Position {
    private const val PREFS = "meteo"

    class Place(val lat: Double, val lon: Double, val name: String)

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Le widget suit la position du téléphone (sinon, toujours le lieu principal). */
    fun follow(context: Context) = prefs(context).getBoolean("follow_gps", true)
    fun setFollow(context: Context, on: Boolean) = prefs(context).edit().putBoolean("follow_gps", on).apply()

    fun granted(context: Context) =
        context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

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
            // On ne redemande le nom de la ville qu'après un déplacement de plus de 3 km.
            val name = if (known != null && !lastLat.isNaN() && LocalForecast.distanceKm(lastLat, lastLon, fresh.latitude, fresh.longitude) < 3) known
            else cityName(context, fresh.latitude, fresh.longitude) ?: known ?: "Ma position"
            p.edit().putFloat("pos_lat", fresh.latitude.toFloat()).putFloat("pos_lon", fresh.longitude.toFloat()).putString("pos_name", name).apply()
            return Place(round3(fresh.latitude), round3(fresh.longitude), name)
        }
        val lat = p.getFloat("pos_lat", Float.NaN)
        if (lat.isNaN()) return null
        return Place(round3(lat.toDouble()), round3(p.getFloat("pos_lon", 0f).toDouble()), p.getString("pos_name", null) ?: "Ma position")
    }

    private fun round3(v: Double) = Math.round(v * 1000) / 1000.0

    @SuppressLint("MissingPermission") // autorisation vérifiée par granted()
    private fun locate(context: Context): Location? {
        if (!granted(context)) return null
        val lm = context.getSystemService(LocationManager::class.java) ?: return null
        val providers = lm.getProviders(true)
        // Dernière position connue la plus récente, tous fournisseurs confondus.
        val last = providers.mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }.maxByOrNull { it.time }
        if (last != null && System.currentTimeMillis() - last.time < 30 * 60_000) return last
        // Sinon une position neuve, par le réseau (rapide et économe), 10 s au plus.
        if (Build.VERSION.SDK_INT >= 30) {
            val provider = when {
                LocationManager.NETWORK_PROVIDER in providers -> LocationManager.NETWORK_PROVIDER
                LocationManager.FUSED_PROVIDER in providers -> LocationManager.FUSED_PROVIDER
                providers.isNotEmpty() -> providers.first()
                else -> return last
            }
            val latch = CountDownLatch(1)
            var got: Location? = null
            lm.getCurrentLocation(provider, null, context.mainExecutor) { got = it; latch.countDown() }
            latch.await(10, TimeUnit.SECONDS)
            return got ?: last
        }
        return last
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
