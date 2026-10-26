#!/usr/bin/env bash
# Essai sur émulateur : installe l'APK, ouvre l'appli, lance la vérification des alertes, puis affiche les plantages.
set -u
APK=${1:-meteo-widget.apk}
PKG=fr.maxence.meteo
adb install -r "$APK"
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS || true
adb logcat -c
adb shell am start -W -n $PKG/.MainActivity
sleep 15
adb shell am start -W -n $PKG/.MainActivity
adb shell cmd jobscheduler run -f $PKG 4242 || true
sleep 20
adb shell input keyevent KEYCODE_HOME
sleep 3
echo "===== Plantages ====="
adb logcat -d -b crash | tee crash.txt
echo "===== Journal de l'appli ====="
adb logcat -d | grep -E "AndroidRuntime|$PKG|MeteoWidget|AlertJob" | tail -150
adb shell dumpsys activity processes | grep -c "$PKG" || true
adb exec-out screencap -p > screen.png || true
if [ -s crash.txt ]; then echo "PLANTAGE DÉTECTÉ"; exit 1; fi
echo "Aucun plantage."
