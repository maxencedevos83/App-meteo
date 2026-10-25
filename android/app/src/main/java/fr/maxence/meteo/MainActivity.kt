package fr.maxence.meteo

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.concurrent.thread

/** Réglages du widget : adresse du site qui publie la prévision, actualisation, accès à l'appli complète. */
class MainActivity : Activity() {

    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (20 * resources.displayMetrics.density).toInt()

        val title = TextView(this).apply { text = "Météo fiable"; textSize = 24f }
        val help = TextView(this).apply {
            text = "Ajoutez le widget depuis l'écran d'accueil (appui long → Widgets → Météo fiable). " +
                "Il se met à jour toutes les 30 min avec la prévision combinée publiée par l'appli."
            setPadding(0, pad / 2, 0, pad)
        }
        val label = TextView(this).apply { text = "Adresse de l'appli" }
        val url = EditText(this).apply {
            setText(MeteoData.siteUrl(this@MainActivity))
            inputType = InputType.TYPE_TEXT_VARIATION_URI
        }
        val save = Button(this).apply {
            text = "Enregistrer et actualiser"
            setOnClickListener {
                MeteoData.setSiteUrl(this@MainActivity, url.text.toString())
                refresh()
            }
        }
        val open = Button(this).apply {
            text = "Ouvrir l'appli complète"
            setOnClickListener { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(MeteoData.siteUrl(this@MainActivity)))) }
        }
        status = TextView(this).apply { setPadding(0, pad, 0, 0) }

        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.TOP
            setPadding(pad, pad * 2, pad, pad)
            listOf(title, help, label, url, save, open, status).forEach { addView(it) }
        })

        // Ouvert depuis l'ajout d'un widget : on valide tout de suite la configuration.
        val widgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
        }
        refresh()
    }

    private fun refresh() {
        status.text = "Actualisation…"
        thread {
            val data = MeteoData.refresh(this)
            MeteoWidget.render(this, data)
            val error = MeteoData.lastError(this)
            runOnUiThread {
                status.text = when {
                    data == null -> "Impossible de récupérer la prévision : $error"
                    error != null -> "Hors ligne ($error). Dernière prévision : ${data.optString("updated")}"
                    else -> "${data.optString("place")} : ${data.optString("temp")}° ${data.optString("cond")}, " +
                        "vent ${data.optString("wind")} kn (raf. ${data.optString("gust")}). Mise à jour ${data.optString("updated")}."
                }
            }
        }
    }
}
