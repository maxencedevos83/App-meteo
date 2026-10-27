package fr.maxence.meteo

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import kotlin.concurrent.thread

/** Réglages : apparence du widget (avec aperçu), alertes, adresse du site qui publie la prévision. */
class MainActivity : Activity() {

    private lateinit var status: TextView
    private lateinit var placeInfo: TextView
    private lateinit var backgroundButton: Button
    private lateinit var preview: FrameLayout
    private lateinit var column: LinearLayout
    private var style = WidgetStyle.Style()
    private val dp by lazy { resources.displayMetrics.density }
    private val refreshers = mutableListOf<() -> Unit>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        style = WidgetStyle.load(this)
        val pad = (20 * dp).toInt()
        column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.TOP
            setPadding(pad, pad * 2, pad, pad)
        }

        add(TextView(this).apply { text = "Météo fiable"; textSize = 24f })
        add(TextView(this).apply {
            text = "Ajoutez le widget depuis l'écran d'accueil (appui long → Widgets → Météo fiable), " +
                "puis agrandissez-le par appui long pour voir plus d'informations."
            setPadding(0, pad / 2, 0, pad / 2)
        })

        // Aperçu du widget, mis à jour à chaque réglage.
        preview = FrameLayout(this).apply {
            background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(Color.rgb(120, 140, 160), Color.rgb(60, 70, 85)))
                .apply { cornerRadius = 16 * dp }
            setPadding((10 * dp).toInt(), (10 * dp).toInt(), (10 * dp).toInt(), (10 * dp).toInt())
        }
        column.addView(preview, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, (230 * dp).toInt()))

        section("Apparence")
        label("Couleur du fond")
        add(swatches(WidgetStyle.BACKGROUNDS, { style.bgColor }) { update(style.copy(bgColor = it)) })
        val customBg = EditText(this).apply {
            hint = "Couleur perso, ex. #1D5FA8"
            inputType = InputType.TYPE_CLASS_TEXT
            if (style.bgColor != 0 && WidgetStyle.BACKGROUNDS.none { it.second == style.bgColor }) setText(WidgetStyle.hex(style.bgColor))
        }
        add(row(customBg, Button(this).apply {
            text = "Appliquer"
            setOnClickListener {
                val c = WidgetStyle.parseColor(customBg.text.toString())
                if (c == null) toast("Couleur invalide : utilisez le format #RRGGBB")
                else update(style.copy(bgColor = c or (0xFF shl 24)))
            }
        }))
        slider("Opacité du fond", 0, 100, { style.opacity }, { "$it %" }) { update(style.copy(opacity = it)) }

        label("Couleur du texte")
        add(swatches(WidgetStyle.TEXT_COLORS, { style.textColor }) { update(style.copy(textColor = it)) })
        val customText = EditText(this).apply { hint = "Couleur perso, ex. #FFE27A"; inputType = InputType.TYPE_CLASS_TEXT }
        add(row(customText, Button(this).apply {
            text = "Appliquer"
            setOnClickListener {
                val c = WidgetStyle.parseColor(customText.text.toString())
                if (c == null) toast("Couleur invalide : utilisez le format #RRGGBB")
                else update(style.copy(textColor = c or (0xFF shl 24)))
            }
        }))
        slider("Taille du texte", 70, 150, { style.textScale }, { "$it %" }) { update(style.copy(textScale = it)) }

        label("Prévision dans le widget")
        add(radios(listOf("Par jour" to 1, "Par heure" to 0), { if (style.daily) 1 else 0 }) { update(style.copy(daily = it == 1)) })

        add(CheckBox(this).apply {
            text = "Icône animée (soleil, pluie, éclairs, vent…)"
            isChecked = style.animated
            setOnCheckedChangeListener { _, on -> update(style.copy(animated = on)) }
        })

        label("Heure")
        val clockChoices = listOf("Grande horloge" to WidgetStyle.CLOCK_BIG, "Petite" to WidgetStyle.CLOCK_SMALL, "Masquée" to WidgetStyle.CLOCK_HIDDEN)
        add(radios(clockChoices, { style.clock }) { update(style.copy(clock = it)) })
        add(CheckBox(this).apply {
            text = "Afficher la date sous la grande horloge"
            isChecked = style.showDate
            setOnCheckedChangeListener { _, on -> update(style.copy(showDate = on)) }
        })
        add(Button(this).apply {
            text = "Apparence d'origine"
            setOnClickListener { update(WidgetStyle.Style()) }
        })

        section("Alertes")
        add(TextView(this).apply {
            text = "Le téléphone vérifie toutes les 15 min, même sans ouvrir l'appli. La pluie dans l'heure est lue en direct."
        })
        Notifier.TYPES.forEach { (key, labelText, _) ->
            add(CheckBox(this).apply {
                text = labelText
                isChecked = Notifier.enabled(this@MainActivity, key)
                setOnCheckedChangeListener { _, on -> Notifier.setEnabled(this@MainActivity, key, on) }
            })
        }
        slider("Vent violent à partir de rafales de", 30, 100, { Notifier.gustThresholdKmh(this) }, { "$it km/h" }) {
            Notifier.setGustThresholdKmh(this, it)
        }
        label("Vigilance Météo-France à partir de")
        add(radios(listOf("Jaune" to 2, "Orange" to 3), { Notifier.vigilanceMin(this) }) { Notifier.setVigilanceMin(this, it) })
        add(Button(this).apply {
            text = "Tester une notification"
            setOnClickListener {
                if (!Notifier.test(this@MainActivity)) {
                    toast("Notifications bloquées : autorisez-les pour Météo fiable")
                    askNotificationPermission(force = true)
                }
            }
        })
        val power = getSystemService(PowerManager::class.java)
        if (!power.isIgnoringBatteryOptimizations(packageName)) {
            add(Button(this).apply {
                text = "Alertes plus fiables : ne pas restreindre la batterie"
                setOnClickListener {
                    runCatching {
                        startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
                    }
                    visibility = View.GONE
                }
            })
        }

        section("Lieu")
        add(CheckBox(this).apply {
            text = "Suivre ma position (ville)"
            isChecked = Position.follow(this@MainActivity)
            setOnCheckedChangeListener { _, on ->
                Position.setFollow(this@MainActivity, on)
                if (on && !Position.granted(this@MainActivity)) askLocation() else refresh()
                updatePlaceInfo()
            }
        })
        placeInfo = TextView(this).apply { setPadding(0, (4 * dp).toInt(), 0, (4 * dp).toInt()) }
        add(placeInfo)
        backgroundButton = Button(this).apply {
            text = "Actualiser aussi en arrière-plan (« Toujours autoriser »)"
            setOnClickListener { requestPermissions(arrayOf(android.Manifest.permission.ACCESS_BACKGROUND_LOCATION), 3) }
        }
        add(backgroundButton)

        section("Prévision")
        label("Adresse de l'appli")
        val url = EditText(this).apply {
            setText(MeteoData.siteUrl(this@MainActivity))
            inputType = InputType.TYPE_TEXT_VARIATION_URI
        }
        add(url)
        add(Button(this).apply {
            text = "Enregistrer et actualiser"
            setOnClickListener {
                MeteoData.setSiteUrl(this@MainActivity, url.text.toString())
                refresh()
            }
        })
        add(Button(this).apply {
            text = "Ouvrir l'appli complète"
            setOnClickListener { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(MeteoData.siteUrl(this@MainActivity)))) }
        })
        status = TextView(this).apply { setPadding(0, pad, 0, 0) }
        add(status)

        setContentView(ScrollView(this).apply { addView(column) })

        askNotificationPermission(force = false)
        if (Position.follow(this) && !Position.granted(this)) askLocation()
        updatePlaceInfo()
        AlertJob.schedule(this)

        // Ouvert depuis l'ajout d'un widget : on valide tout de suite la configuration.
        val widgetId = intent?.extras?.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            ?: AppWidgetManager.INVALID_APPWIDGET_ID
        if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) {
            setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
        }
        updatePreview()
        refresh()
    }

    // Android 13+ : autorisation nécessaire pour afficher les notifications.
    private fun askNotificationPermission(force: Boolean) {
        if (Build.VERSION.SDK_INT < 33) return
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED) return
        if (force && !shouldShowRequestPermissionRationale(android.Manifest.permission.POST_NOTIFICATIONS) &&
            getSharedPreferences("meteo", MODE_PRIVATE).getBoolean("notif_asked", false)
        ) {
            // Refusée deux fois : Android ne redemande plus, il faut passer par les réglages.
            startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
            return
        }
        getSharedPreferences("meteo", MODE_PRIVATE).edit().putBoolean("notif_asked", true).apply()
        requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
    }

    private fun askLocation() {
        val perms = mutableListOf(android.Manifest.permission.ACCESS_COARSE_LOCATION)
        // Android 10 accepte les deux d'un coup ; à partir d'Android 11, « toujours » se demande à part.
        if (Build.VERSION.SDK_INT == 29) perms.add(android.Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        requestPermissions(perms.toTypedArray(), 2)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 2 || requestCode == 3) {
            updatePlaceInfo()
            refresh()
        }
    }

    override fun onResume() {
        super.onResume()
        if (::placeInfo.isInitialized) updatePlaceInfo()
    }

    private fun updatePlaceInfo() {
        val follow = Position.follow(this)
        val granted = Position.granted(this)
        val city = getSharedPreferences("meteo", MODE_PRIVATE).getString("pos_name", null)
        placeInfo.text = when {
            !follow -> "Le widget affiche toujours le lieu principal (Le Lavandou)."
            !granted -> "Autorisez la localisation pour que le widget suive la ville où vous êtes."
            else -> (city?.let { "Dernière position : $it. " } ?: "") +
                "Près du Lavandou, prévision complète avec Windguru ; ailleurs, Météo-France, ECMWF et ICON pour la ville où vous êtes."
        }
        backgroundButton.visibility = if (follow && granted && !Position.backgroundGranted(this)) View.VISIBLE else View.GONE
    }

    private fun update(next: WidgetStyle.Style) {
        style = next
        WidgetStyle.save(this, next)
        refreshers.forEach { it() }
        updatePreview()
        runCatching { MeteoWidget.render(this, MeteoData.cached(this)) }
    }

    private fun updatePreview() {
        runCatching {
            val views = MeteoWidget.build(this, MeteoData.cached(this), MeteoWidget.Size.MEDIUM, 320, 210)
            preview.removeAllViews()
            preview.addView(views.apply(this, preview))
        }.onFailure { Log.e("Meteo", "Aperçu du widget impossible", it) }
        // Vérifie aussi les deux autres tailles : un élément refusé par l'écran d'accueil y afficherait une erreur.
        for ((size, w, h) in listOf(Triple(MeteoWidget.Size.SMALL, 180, 90), Triple(MeteoWidget.Size.LARGE, 360, 420))) {
            runCatching { MeteoWidget.build(this, MeteoData.cached(this), size, w, h).apply(this, FrameLayout(this)) }
                .onFailure { Log.e("Meteo", "Widget $size impossible à afficher", it) }
        }
    }

    private fun refresh() {
        status.text = "Actualisation…"
        thread {
            val data = MeteoData.refresh(this)
            runCatching { MeteoWidget.render(this, data) }.onFailure { Log.e("Meteo", "Widget", it) }
            val error = MeteoData.lastError(this)
            if (error == null) runCatching { Notifier.notifyNew(this, data) }.onFailure { Log.e("Meteo", "Alertes", it) }
            runOnUiThread {
                updatePreview()
                updatePlaceInfo()
                status.text = when {
                    data == null -> "Impossible de récupérer la prévision : $error"
                    error != null -> "Hors ligne ($error). Dernière prévision : ${data.optString("updated")}"
                    else -> "${data.optString("place")} : ${data.optString("temp")}° ${data.optString("cond")}, " +
                        "vent ${MeteoData.kmh(data.optDouble("wind"))} km/h (raf. ${MeteoData.kmh(data.optDouble("gust"))}). Mise à jour ${data.optString("updated")}."
                }
            }
        }
    }

    // --- Petits éléments d'interface ---

    private fun add(view: View) = column.addView(view)

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    private fun section(title: String) = add(TextView(this).apply {
        text = title
        textSize = 20f
        setPadding(0, (24 * dp).toInt(), 0, (6 * dp).toInt())
    })

    private fun label(text: String) = add(TextView(this).apply {
        this.text = text
        setPadding(0, (10 * dp).toInt(), 0, (4 * dp).toInt())
    })

    private fun row(field: EditText, button: Button) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(field, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        addView(button)
    }

    private fun slider(title: String, min: Int, max: Int, current: () -> Int, format: (Int) -> String, onChange: (Int) -> Unit) {
        val text = TextView(this).apply { setPadding(0, (10 * dp).toInt(), 0, 0) }
        val bar = SeekBar(this).apply { this.max = max - min }
        val sync = {
            val v = current().coerceIn(min, max)
            text.text = "$title : ${format(v)}"
            bar.progress = v - min
        }
        bar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar, progress: Int, fromUser: Boolean) {
                if (fromUser) text.text = "$title : ${format(progress + min)}"
            }
            override fun onStartTrackingTouch(seekBar: SeekBar) {}
            override fun onStopTrackingTouch(seekBar: SeekBar) = onChange(seekBar.progress + min)
        })
        sync()
        refreshers.add(sync)
        add(text)
        add(bar)
    }

    private fun radios(choices: List<Pair<String, Int>>, current: () -> Int, onPick: (Int) -> Unit) = RadioGroup(this).apply {
        orientation = RadioGroup.HORIZONTAL
        val buttons = choices.map { (name, value) ->
            RadioButton(this@MainActivity).apply { text = name; id = View.generateViewId(); tag = value }
        }
        buttons.forEach { addView(it) }
        val sync = { buttons.firstOrNull { it.tag == current() }?.let { check(it.id) } }
        sync()
        refreshers.add { sync() }
        setOnCheckedChangeListener { _, checkedId ->
            val value = buttons.firstOrNull { it.id == checkedId }?.tag as? Int ?: return@setOnCheckedChangeListener
            if (value != current()) onPick(value)
        }
    }

    private fun swatches(items: List<Pair<String, Int>>, current: () -> Int, onPick: (Int) -> Unit): View {
        val size = (40 * dp).toInt()
        val strip = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val views = items.map { (name, color) ->
            View(this).apply {
                contentDescription = name
                setOnClickListener { onPick(color); toast(name) }
            }.also { v ->
                strip.addView(v, LinearLayout.LayoutParams(size, size).apply { marginEnd = (10 * dp).toInt() })
            } to color
        }
        val sync = {
            for ((v, color) in views) {
                v.background = (if (color == WidgetStyle.WEATHER) {
                    GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(Color.rgb(255, 200, 60), Color.rgb(36, 120, 220), Color.rgb(74, 58, 104)))
                } else if (color == 0) {
                    GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(Color.rgb(29, 95, 168), Color.rgb(61, 139, 216)))
                } else {
                    GradientDrawable().apply { setColor(color) }
                }).apply {
                    shape = GradientDrawable.OVAL
                    val selected = color == current()
                    setStroke(((if (selected) 4 else 1) * dp).toInt(), if (selected) Color.rgb(255, 140, 0) else Color.GRAY)
                }
            }
        }
        sync()
        refreshers.add(sync)
        return HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false
            addView(strip)
        }
    }
}
