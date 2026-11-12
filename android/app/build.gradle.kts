plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Clé de signature stable, pour pouvoir installer les mises à jour par-dessus l'ancienne version.
// Par défaut la clé du dépôt (meteo.keystore) ; la CI peut la remplacer par un secret ANDROID_KEYSTORE_B64.
val customKeystore = System.getenv("ANDROID_KEYSTORE_FILE")?.let { file(it) }?.takeIf { it.exists() }

android {
    namespace = "fr.maxence.meteo"
    compileSdk = 35

    defaultConfig {
        applicationId = "fr.maxence.meteo"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = "1.${System.getenv("VERSION_CODE") ?: "0"}"
    }

    signingConfigs {
        create("stable") {
            storeFile = customKeystore ?: file("meteo.keystore")
            storePassword = if (customKeystore != null) System.getenv("ANDROID_KEYSTORE_PASSWORD") else "meteo-widget"
            keyAlias = System.getenv("ANDROID_KEY_ALIAS") ?: "meteo"
            keyPassword = storePassword
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("stable")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

// L'interface de l'appli (dossier web/ du dépôt) est embarquée dans l'APK : assets/web/.
val webAssets = layout.buildDirectory.dir("generated/webassets")
val copyWeb by tasks.registering(Sync::class) {
    from(rootProject.file("../web")) { exclude("sw.js", "manifest.webmanifest") }
    into(webAssets.map { it.dir("web") })
}
android.sourceSets["main"].assets.srcDir(webAssets)
tasks.named("preBuild") { dependsOn(copyWeb) }
