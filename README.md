# Social Scheduler (PC-unabhängig)

Veröffentlicht geplante Social-Media-Pakete über die Meta Graph API — **unabhängig vom eigenen PC**, ausgeführt als GitHub Actions Cron-Workflow alle 5 Minuten. Medien und Queue liegen in einer privaten Cloudflare-R2-Bucket, Tokens ausschließlich in GitHub Secrets.

## Ablauf

```
Paket freigeben (lokal, approve-and-schedule.mjs)
        ↓
node seed-cloud-queue.mjs        # Medien → R2, Queue-Eintrag → scheduler/queue.json
        ↓
GitHub Actions (cron */5 min)    # publish-cloud.mjs: fällige Items → Instagram/Facebook
```

Der PC wird nur für Produktion, Sichtung und Freigabe gebraucht. Alles Danach läuft in der Cloud.

## Komponenten

- `publish-cloud.mjs` — Cloud-Runner. Liest `scheduler/queue.json` aus R2, presigned die Medien-URL (SigV4), veröffentlicht fällige Items über die Meta Graph API und schreibt Status + Checkpoints zurück in die Queue. Jeder Lauf hinterlässt ein Log in `scheduler/logs/`.
  - `node publish-cloud.mjs` — veröffentlichen (Workflow-Default)
  - `node publish-cloud.mjs --check` — Konnektivität, Medien und Tokens prüfen, ohne etwas zu veröffentlichen
- `seed-cloud-queue.mjs` — lokal ausführen nach der Freigabe. Liest `.upload-state/items` (Status `SCHEDULED`, `liveIntent`), lädt Medien nach R2 und übernimmt die Termine in die Cloud-Queue. Idempotent: erneutes Ausführen aktualisiert bestehende Einträge, abgeschlossene Status bleiben erhalten.
- `cloud-lib.mjs` — R2-SigV4-Client und die Meta-Publishing-Routen (Instagram Post/Story/Reel/Video/Carousel, Facebook Foto/Video/Reel/Carousel), portiert aus dem upload-Skill.
- Workflow `publish-due` mit drei Modi:
  - `loop` (Standard, Selbst-Nachfolger): Der Job läuft 5,5 Stunden als Wachdienst (Prüflauf alle 2,5 Minuten) und startet vor Ablauf selbst den nächsten Loop-Lauf. Dadurch tickt der Scheduler garantiert ohne Cron-Abhängigkeit; ein täglicher Keepalive-Job bootet zusätzlich neu und hält den Workflow gegen die 60-Tage-Inaktivitäts-Abschaltung wach.
  - `run`: einmaliger Veröffentlichungslauf (auch als Cron-Bonus aktiv, falls GitHub den Zeitplan ausliefert).
  - `check`: Prüflauf ohne Mutationen.

## Sicherheitsregeln (unveränderlich)

- Kein Doppel-Posten: `PUBLISHING`-Claims mit Zeitstempel; `AMBIGUOUS`-Zustände werden nie automatisch wiederholt, sondern nur protokolliert und markiert.
- Netzwerk-/429/5xx-Fehler werden sicher wiederholt (max. 4 Versuche), echte Ablehnungen durch Meta führen zu `FAILED`.
- Tokens und R2-Zugangsdaten stehen nur in GitHub Secrets bzw. lokalen Umgebungsvariablen, nie im Repo oder Log.

## Neue Pakete veröffentlichen (nach der Sichtung)

```bash
node "D:\Bilder\MZM\approve-and-schedule.mjs" --package "<Paketordner>" --at "<ISO-Zeit>" --live
node "D:\Kreativ\Social-Scheduler\seed-cloud-queue.mjs"
```

Danach innerhalb von 5 Minuten in der Cloud geplant. Prüflauf: Workflow `publish-due` manuell mit `mode=check` dispatchen oder lokal `node publish-cloud.mjs --check`.

## Hinweis

GitHub deaktiviert Cron-Workflows nach 60 Tagen ohne Repo-Aktivität — der tägliche Keepalive-Commit (03:07 UTC) verhindert das automatisch.
