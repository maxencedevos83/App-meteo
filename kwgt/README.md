# Widget KWGT

Si tu préfères garder KWGT plutôt que le widget Android natif, toutes les données combinées sont publiées dans un petit fichier JSON, mis à jour toutes les 30 minutes :

```
https://maxencedevos83.github.io/App-meteo/data/widget.json
```

## Mise en place

1. Dans KWGT, crée un widget vide (4×2 conseillé).
2. Ajoute un **Global** de type *Texte* nommé `url` avec l'adresse ci-dessus.
3. Ajoute les éléments ci-dessous, chacun avec la formule indiquée (bouton « calculatrice » → texte).
4. Dans *Paramètres du widget* → *Rafraîchissement*, garde la mise à jour automatique : KWGT relit l'URL au plus toutes les 30 min (`$wg$` met en cache).

## Formules

| Élément | Formule |
|---|---|
| Lieu | `$wg(gv(url), json, ".place")$` |
| Température | `$wg(gv(url), json, ".temp")$°` |
| Icône (emoji) | `$wg(gv(url), json, ".icon")$` |
| Ciel | `$wg(gv(url), json, ".cond")$` |
| Min / max | `$wg(gv(url), json, ".min")$° / $wg(gv(url), json, ".max")$°` |
| Vent | `$wg(gv(url), json, ".wind")$ kn raf. $wg(gv(url), json, ".gust")$ $wg(gv(url), json, ".dir")$` |
| Pluie dans l'heure | `$wg(gv(url), json, ".rain")$` |
| Probabilité de pluie | `$wg(gv(url), json, ".pop")$ %` |
| Fiabilité | `$wg(gv(url), json, ".confidence")$ %` |
| Eau de mer | `$wg(gv(url), json, ".sea")$°` |
| Mise à jour | `$wg(gv(url), json, ".updated")$` |

Prochaines heures (de 2 h en 2 h, `0` à `5`) :

| Élément | Formule |
|---|---|
| Heure | `$wg(gv(url), json, ".h[0].t")$` |
| Icône | `$wg(gv(url), json, ".h[0].icon")$` |
| Température | `$wg(gv(url), json, ".h[0].temp")$°` |
| Vent | `$wg(gv(url), json, ".h[0].wind")$` |
| Pluie | `$wg(gv(url), json, ".h[0].pop")$ %` |

Jours suivants (`0` = aujourd'hui, jusqu'à `4`) : `.d[1].day`, `.d[1].icon`, `.d[1].min`, `.d[1].max`, `.d[1].pop`, `.d[1].wind`.

## Flèche de vent

Pour faire pivoter une flèche selon le vent : ajoute une forme ou une icône « flèche vers le haut », puis dans *Rotation* → *Manuelle*, formule :

```
$wg(gv(url), json, ".dirDeg") + 180$
```

## Couleur du vent façon Windguru

Sur le fond d'une case de vent, couleur en formule :

```
$if(wg(gv(url), json, ".wind") < 5, #FFFFFF, wg(gv(url), json, ".wind") < 10, #A0F0C8, wg(gv(url), json, ".wind") < 15, #AAF046, wg(gv(url), json, ".wind") < 20, #FFF03C, wg(gv(url), json, ".wind") < 25, #FFAA28, #FF503C)$
```

## Contenu complet du fichier

```json
{
  "place": "Le Lavandou", "updated": "21h37", "temp": 14, "feels": 12,
  "icon": "🌤️", "cond": "Peu nuageux", "code": 1,
  "wind": 12, "gust": 19, "dir": "E", "dirDeg": 95,
  "pop": 10, "rain": "Pas de pluie dans l'heure",
  "min": 11, "max": 18, "confidence": 86, "sea": 19, "wave": 0.6, "sources": 14,
  "h": [{ "t": "23h", "temp": 13, "icon": "🌙", "pop": 0, "wind": 11, "gust": 17, "dir": "E", "dirDeg": 92 }],
  "d": [{ "day": "Auj.", "min": 11, "max": 18, "icon": "🌤️", "pop": 10, "wind": 14, "gust": 22 }]
}
```
