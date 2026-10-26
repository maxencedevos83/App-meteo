# Météo fiable

Appli météo qui combine plusieurs modèles de prévision au lieu d'en croire un seul, puis apprend lesquels se trompent le moins **chez toi**. Réglée sur Le Lavandou.

- **Appli** (installable sur le téléphone) : https://maxencedevos83.github.io/App-meteo/
- **Widget Android** : APK dans les [Releases](../../releases) (`meteo-widget.apk`)
- **Widget KWGT** : voir [kwgt/README.md](kwgt/README.md)

## Sources

| Source | Ce qu'elle apporte |
|---|---|
| Météo-France AROME HD 1,5 km et AROME 2,5 km | Le plus précis à courte échéance (0 à 42 h) sur la France, relief et brises côtières compris |
| Météo-France ARPEGE | Relais jusqu'à 4 jours |
| ECMWF IFS et AIFS (IA) | Référence mondiale à moyenne échéance (jusqu'à 15 jours) |
| ECMWF ensemble (51 membres) | Probabilité de pluie réaliste |
| DWD ICON-EU / ICON-D2, KNMI HARMONIE, Met Office, NOAA GFS | Avis complémentaires pour mesurer l'accord entre modèles |
| Windguru (tous les modèles du spot) | Vent local, poids renforcé pour le vent |
| Open-Meteo 15 min (AROME) | Pluie dans l'heure |
| RainViewer | Radar de pluie animé |
| Open-Meteo Marine | Vagues et température de l'eau |
| Stations Météo-France du Var (open data, data.gouv.fr) | Mesures horaires des stations les plus proches du Lavandou pour vérifier les modèles (température, vent, rafales, pluie) |
| METAR Toulon-Hyères (LFTH) | Mesures en temps réel de l'aéroport, en complément |

## Comment la prévision est calculée

1. **Moyenne pondérée** de tous les modèles, heure par heure. Chaque modèle a un poids de départ par grandeur (température, vent, pluie, nuages) : AROME pèse le plus à courte échéance, ECMWF à plus long terme, les modèles Windguru (une vingtaine sur ton spot) se partagent un poids de groupe, environ 40 % du total pour le vent.
2. **Poids selon l'échéance** : un modèle à maille fine garde son plein poids sur sa période de validité, puis s'efface progressivement.
3. **Vérification locale** : toutes les 3 h, la prévision de chaque modèle est archivée, puis comparée aux mesures des stations Météo-France les plus proches (moyenne pondérée par la distance), complétées par l'aéroport de Toulon-Hyères. Par défaut, seules les stations côtières de Bormes-les-Mimosas et de l'île du Levant sont retenues (`stations.only` dans `config.json`), car Collobrières et Cogolin, dans les terres, sont bien plus froides la nuit. Un modèle plus juste que la moyenne gagne jusqu'à ×3 en poids, un modèle moins juste descend jusqu'à ×0,3. Les biais (trop chaud, trop venté…) sont corrigés à moitié, car la station n'est pas exactement au Lavandou. L'effet monte progressivement avec le nombre de comparaisons (plein effet après ~150).
   - Les corrections sont aussi apprises **par régime de vent** (secteur nord, est, sud, ouest du vent prévu) : un modèle peut sous-estimer le mistral mais surestimer le vent d'est.
   - Les **rafales** ont leur propre correction, et la **pluie** est vérifiée heure par heure (pluie / pas de pluie) pour pondérer les modèles sur la pluie.
   - La prévision combinée est elle-même archivée : l'écran « Prévu vs réel » montre son erreur réelle face au meilleur modèle.
4. **Pluie** : probabilité = part des modèles qui prévoient de la pluie, mélangée à l'ensemble ECMWF.
5. **Fiabilité** : indice de 0 à 100 % selon l'accord entre modèles (température, vent, pluie) et l'échéance. Une fiabilité basse signifie que les modèles divergent : à vérifier plus tard.

L'onglet « Sources et fiabilité » de l'appli montre le poids réel de chaque modèle et son erreur moyenne mesurée.

## Alertes, sorties et mer

- **Alertes** (bandeau de l'appli, et notifications du widget Android, réglables dans l'appli du widget) : vigilance Météo-France du Var (flux public MeteoAlarm), pluie dans l'heure, orage, coup de vent (rafales ≥ 30 kn sur 12 h, réglable dans `config.json` → `alerts.gustKn`), bons créneaux de sortie.
- **Sorties** : score heure par heure sur 5 jours et meilleurs créneaux pour kite/wing, voile, paddle/kayak, baignade et balade. Le score tient compte du vent, des rafales, de l'orientation de la plage (`shoreFacing`, 150° pour Le Lavandou : un vent de terre est pénalisé pour le kite et le paddle), des vagues, de la température de l'eau, de la pluie et de la nuit. Les seuils sont dans `web/js/activities.js`.
- **Mer** : vagues, houle (hauteur, période, direction) et température de l'eau sur 6 jours.
- **Vent par modèle** : tableau façon Windguru qui compare les modèles toutes les 3 h.

## Widget Android

Le widget s'adapte à sa taille : **petit** (température, vent, pluie), **moyen** (prochaines heures et alerte principale), **grand** (en plus : graphe vent/rafales/pluie/température sur 24 h, 5 jours et prochains créneaux de sortie). Redimensionne-le par appui long.

- **Heure et date** : grande horloge, petite ou masquée. Un appui sur l'heure ouvre l'horloge du téléphone.
- **Apparence** (dans l'appli « Météo fiable », avec aperçu) : couleur du fond (palette ou code #RRGGBB), opacité de 0 à 100 %, couleur du texte, taille du texte de 70 à 150 %.
- **Alertes** : le téléphone vérifie toutes les 15 min en arrière-plan, même si le widget n'est pas affiché. Vigilance Météo-France (dès le jaune ou dès l'orange), orages, vent violent (seuil de rafales réglable), pluie dans l'heure lue en direct sur AROME et pluie probable dans les 6 h. Les alertes orange, rouge, orage et tempête passent par un canal prioritaire. Bouton « Tester une notification » ; pour des alertes à l'heure, autorise l'appli à ne pas être restreinte par l'économie de batterie.

## Fonctionnement technique

- `scripts/update.mjs` tourne toutes les 30 min dans GitHub Actions (`.github/workflows/update.yml`). Il récupère toutes les sources, calcule la prévision, met à jour l'état de vérification (branche `data`) et publie le site sur GitHub Pages avec `data/forecast.json` et `data/widget.json`.
- `web/` : l'appli (HTML/JS sans dépendance, hors ligne grâce au service worker). Elle peut aussi calculer la prévision d'un autre lieu directement dans le navigateur (sans Windguru ni vérification locale).
- `android/` : widget natif Kotlin, compilé par `.github/workflows/android.yml` et publié en Release.

### Changer de lieu

Modifier `config.json` : `latitude`, `longitude`, `windguru.spotId` (le numéro dans l'adresse `windguru.cz/123456` ; sinon le spot le plus proche est cherché avec `windguru.search`) et `metar` (code OACI de l'aéroport le plus proche).

### En local

```bash
npm test                 # tests du moteur
node scripts/update.mjs  # vraie prévision (réseau nécessaire)
node scripts/demo.mjs    # ou données fictives
node scripts/build-site.mjs && node scripts/serve.mjs   # http://localhost:8080
```

## Installer le widget Android

1. Sur le téléphone, ouvre la dernière [Release](../../releases), télécharge `meteo-widget.apk` et installe-le (autoriser l'installation depuis le navigateur si Android le demande).
2. Appui long sur l'écran d'accueil → Widgets → **Météo fiable**.
3. Touche le widget pour ouvrir l'appli complète, ⟳ pour actualiser.

Les APK sont signés avec la clé `android/app/meteo.keystore` du dépôt, ce qui permet d'installer chaque nouvelle version par-dessus la précédente. Pour utiliser ta propre clé, ajoute les secrets `ANDROID_KEYSTORE_B64` et `ANDROID_KEYSTORE_PASSWORD`.

> Windguru n'a pas d'API publique : l'appli utilise celle de son site, qui peut changer sans prévenir. Si elle casse, la prévision continue sans Windguru et l'erreur s'affiche dans « Sources et fiabilité ».
