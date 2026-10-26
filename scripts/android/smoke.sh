#!/usr/bin/env bash
# Essai sur émulateur : installe l'APK, ouvre l'appli, lance la vérification des alertes, puis affiche les plantages.
set -u
APK=${1:-meteo-widget.apk}
PKG=fr.maxence.meteo
adb install -r "$APK"
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS || true
# Position fictive à Paris : le widget doit calculer la prévision de la ville sur le téléphone.
adb shell pm grant $PKG android.permission.ACCESS_COARSE_LOCATION || true
adb shell pm grant $PKG android.permission.ACCESS_BACKGROUND_LOCATION || true
adb shell cmd location set-location-enabled true || true
adb emu geo fix 2.3522 48.8566 || true
adb logcat -c
adb shell am start -W -n $PKG/.MainActivity
sleep 15
adb shell am start -W -n $PKG/.MainActivity
adb emu geo fix 2.3522 48.8566 || true
adb shell cmd jobscheduler run -f $PKG 4242 || true
sleep 20
adb shell input keyevent KEYCODE_HOME
sleep 3
echo "===== Plantages ====="
adb logcat -d -b crash | tee crash.txt
echo "===== Journal de l'appli ====="
adb logcat -d | grep -E "AndroidRuntime|$PKG|MeteoWidget|AlertJob| Meteo" | tail -150
adb shell dumpsys activity processes | grep -c "$PKG" || true
adb exec-out screencap -p > screen.png || true
echo "===== Position ====="
adb logcat -d -s Meteo:I | tee position.txt
echo "===== Erreurs de l'appli ====="
adb logcat -d -s Meteo:E | tee errors.txt
if [ -s crash.txt ]; then echo "PLANTAGE DÉTECTÉ"; exit 1; fi
if grep -q " E Meteo" errors.txt; then echo "ERREUR DANS L'APPLI"; exit 1; fi
if ! grep -q "Prévision locale" position.txt; then echo "PRÉVISION LOCALE ABSENTE"; exit 1; fi
echo "Aucun plantage."
