# Social Scheduler (PC-unabhängig)

Veröffentlicht geplante Social-Media-Pakete nach Instagram, Facebook und YouTube sowie wahlweise in die TikTok-Inbox bzw. nach Audit per TikTok Direct Post. Die Ausführung läuft PC-unabhängig über GitHub Actions. Medien und Queue liegen in einem privaten Cloudflare-R2-Bucket, Tokens ausschließlich in GitHub Secrets.

## Ablauf

```
Paket freigeben (lokal, approve-and-schedule.mjs)
        ↓
automatisch: seed-cloud-queue.mjs --fingerprint <64-hex>  # frische QA, Medien → R2, Queue-Upsert
        ↓
GitHub Actions (cron */5 min)    # publish-cloud.mjs: fällige Zielkanäle veröffentlichen
```

Der PC wird nur für Produktion, Sichtung und Freigabe gebraucht. Alles Danach läuft in der Cloud.

## Komponenten

- `publish-cloud.mjs` — Provider-Runner für Instagram, Facebook, YouTube und TikTok. Jeder Zielkanal besitzt einen eigenen Zustand in `targetStates`; ein erfolgreicher Meta-Post wird durch einen späteren YouTube-/TikTok-Fehler nicht zurückgesetzt. Jeder Lauf hinterlässt ein bereinigtes Log in `scheduler/logs/`.
  - `node publish-cloud.mjs` — veröffentlichen (Workflow-Default)
  - `node publish-cloud.mjs --check` — Konnektivität, Medien und Tokens prüfen, ohne etwas zu veröffentlichen
  - `node publish-cloud.mjs --retry-waiting [--fingerprint <64-hex>]` — nach ergänzten Credentials gezielt `WAITING_CONFIGURATION` erneut prüfen
- `seed-cloud-queue.mjs` — lokal direkt nach der Freigabe ausführen. Mit `--fingerprint` wird ausschließlich das gerade freigegebene Item übernommen. Vor dem Upload ruft der Seeder die aktuelle QA des Upload-Skills erneut auf und verlangt denselben Fingerprint. Medien liegen inhaltadressiert unter `assets/<sha-prefix>/<sha>.<ext>`. Das YouTube-Custom-Thumbnail wird als eigenes privates R2-Asset gestaget und über Hash, Bytezahl, MIME-Typ, Identity-v2-Fingerprint und Kanal-Snapshot an genau dieses Paket gebunden.
- `queue-store.mjs` — v1-kompatible Normalisierung auf Queue-Schema v2, dynamisches Account-Register, `targets`/`targetStates` und ETag/CAS-Schreibzugriffe. Seeder, Publisher und Plan-Umverteilung können dadurch keine zwischenzeitlichen Statusänderungen mehr mit einer alten Queue-Kopie überschreiben.
- `provider-youtube.mjs` — OAuth-Refresh, Kanalbindung (`mine=true`), wiederaufnehmbare Block-Uploads und danach `thumbnails.set` mit der exakt QA-gebundenen Bilddatei. Die resumable Session-URL bleibt nur im internen Queue-State und wird vom Dashboard entfernt.
- `provider-tiktok.mjs` — standardmäßig Upload in die TikTok-Inbox (`ACTION_REQUIRED`); Direct Post nur mit App-Audit, aktueller paketgebundener Freigabe und erneut abgefragten Creator-Einstellungen.
- `confirm-tiktok-cloud.mjs` — verbucht nach der tatsächlichen Veröffentlichung in der TikTok-App die manuelle Inbox-Bestätigung idempotent und ETag/CAS-geschützt in der Cloud-Queue. Der Upload-Skill ruft diesen Rückkanal automatisch auf.
- `redistribute-plan.mjs` — verteilt die Queue um den Redaktionsplan: Die Ankerposts aus `v3-upload-plan.json` behalten ihre Zeiten, alle übrigen Items werden konfliktfrei in die je Account unter `slots` konfigurierten Zeiten eingewebt; Serien bleiben als Block zusammen. Vorschau ohne Argument, speichern mit `--apply`.
- `check-plan.mjs` — Tagesübersicht + Kollisionsprüfung der aktuellen Cloud-Queue.
- `cloud-lib.mjs` — R2-SigV4-Client einschließlich Conditional Writes und die unveränderten Meta-Publishing-Routen (Instagram Post/Story/Reel/Video/Carousel, Facebook Foto/Video/Reel/Carousel).
- Workflow `publish-due` mit drei Modi:
  - `loop` (manuell startbarer Selbst-Nachfolger): Der Job läuft 5,5 Stunden als Wachdienst (Prüflauf alle 2,5 Minuten) und startet vor Ablauf selbst den nächsten Loop-Lauf.
  - `run`: einmaliger Veröffentlichungslauf (auch als Cron-Bonus aktiv, falls GitHub den Zeitplan ausliefert).
  - `check`: Prüflauf ohne Mutationen.

## Sicherheitsregeln (unveränderlich)

- Kein Doppel-Posten: `PUBLISHING`-Claims mit Zeitstempel; `AMBIGUOUS`-Zustände werden nie automatisch wiederholt, sondern nur protokolliert und markiert.
- Kein doppeltes Thumbnail-Setzen: Vor `thumbnails.set` wird `thumbnailPhase=REQUESTING` dauerhaft gespeichert. Netzwerkfehler und HTTP 5xx danach sind `AMBIGUOUS`; ein bereits mit demselben SHA-256 bestätigtes Thumbnail wird nie erneut gesendet. HTTP 404/429 erhalten einen neuen `actionAt`, HTTP 403 bleibt als `WAITING_CONFIGURATION` stehen.
- Genau eine Publishing-Authority: Vor jedem R2-Zugriff beansprucht der Seeder das lokale Item atomar als `CLOUD_SYNC_PENDING`. Dieser Status und `CLOUD_SCHEDULED` duerfen vom lokalen `publish-due` nie verarbeitet werden. Bei einem Syncfehler bleibt das Item sicher auf `CLOUD_SYNC_PENDING`; erst ein erfolgreicher Queue-Upsert setzt `CLOUD_SCHEDULED`.
- Kein Lost Update: Alle Änderungen an `scheduler/queue.json` verwenden den R2-ETag mit `If-Match`/`If-None-Match` und wiederholen ausschließlich den konfliktfreien Merge.
- Netzwerk-/429/5xx-Fehler werden sicher wiederholt (max. 4 Versuche), echte Ablehnungen durch Meta führen zu `FAILED`.
- Tokens und R2-Zugangsdaten stehen nur in GitHub Secrets bzw. lokalen Umgebungsvariablen, nie im Repo oder Log.
- Das Dashboard liefert eine redigierte Queue ohne Access-/Refresh-Tokens, Upload-URLs oder YouTube-Session-Capabilities aus.

## Accounts und Provider-Credentials

Accounts kommen dynamisch aus `upload-config.json`. Werkstern und Massage-Zuhause bleiben vollständig kompatibel; Aeris, `Kanal 4 (Reserve)` und der fünfte Slot `Werbekanal` werden ausschließlich per Konfiguration ergänzt. `purpose: "advertising"` erlaubt organische Werbeposts mit den nötigen Kennzeichnungen. Bezahlte Kampagnen sind nicht Teil dieses Uploaders und gehören in die jeweiligen Ads-/Marketing-APIs.

Für beliebig viele Accounts kann ein einziges verschlüsseltes GitHub Secret `SOCIAL_PROVIDER_CREDENTIALS_JSON` verwendet werden:

```json
{
  "accounts": {
    "aeris": {
      "meta": { "accessToken": "..." },
      "youtube": { "clientId": "...", "clientSecret": "...", "refreshToken": "..." },
      "tiktok": { "accessToken": "..." }
    }
  }
}
```

Bereits konfigurierte Einzel-Accounts können alternativ über die in `upload-config.json` hinterlegten Umgebungsvariablennamen versorgt werden. Für Werkstern verwendet der Workflow die drei getrennten GitHub Secrets `YOUTUBE_WERKSTERN_CLIENT_ID`, `YOUTUBE_WERKSTERN_CLIENT_SECRET` und `YOUTUBE_WERKSTERN_REFRESH_TOKEN`. Diese dedizierten YouTube-Werte haben für den Account Vorrang vor gleichnamigen Feldern im kombinierten JSON. Die Variante ergänzt die bestehende Credential-Struktur, ohne `SOCIAL_PROVIDER_CREDENTIALS_JSON` zu ersetzen oder andere Provider-Zugänge zu gefährden. Im `check`-Job beschreibt `SOCIAL_YOUTUBE_CHECKS_JSON` die nicht geheimen Kanalbindungen deklarativ; der Prüflauf erneuert damit tatsächlich den OAuth-Token und vergleicht `channels?mine=true` exakt mit der hinterlegten Kanal-ID, ohne eine Upload-Session zu erzeugen.

Das JSON ist ausschließlich ein Secret, niemals eine Repo-Datei. Für TikTok erzeugt der Worker zur Fälligkeit eine HMAC-signierte URL aus `SOCIAL_R2_PUBLIC_BASE_URL` und `SOCIAL_R2_PUBLIC_SIGNING_SECRET`; die URL liegt ohne Redirect unter dem in der App verifizierten HTTPS-Prefix. Der OAuth-Token braucht zusätzlich `user.info.basic`: Vor jedem neuen Inbox-/Direct-Init muss TikTok User Info dieselbe `open_id` wie die Account-Konfiguration liefern. Ein kurzlebiger TikTok Access-Token benötigt weiterhin einen externen OAuth-Rotationsweg; ohne gültigen oder eindeutig zugeordneten Token bleibt nur das TikTok-Ziel fail-closed stehen.

Für YouTube verwendet der Autorisierungsflow `https://www.googleapis.com/auth/youtube.upload` für Upload und `thumbnails.set`, `https://www.googleapis.com/auth/youtube.readonly` für die Kanal-/Statusprüfung sowie `https://www.googleapis.com/auth/youtube.force-ssl` für das abschließende `videos.update`. Bestehende Refresh Tokens müssen einmal mit diesem erweiterten Scope neu autorisiert werden. Das Zielkonto muss Custom Thumbnails aktiviert haben; eine eindeutige HTTP-403-Ablehnung wird deshalb nicht blind wiederholt, sondern verlangt eine Konfigurationskorrektur.

## YouTube-Custom-Thumbnail

Jedes YouTube-Paket benötigt in `manifest.json` ein JPEG- oder PNG-Bild bis maximal 2 MiB:

```json
{
  "youtube": {
    "thumbnail": { "path": "thumbnail.jpg" }
  }
}
```

Die lokale QA prüft Bildtyp und Bytes und nimmt den Thumbnail-Hash in die Identity-v2-Paketidentität auf. Der Seeder speichert ausschließlich den privaten R2-Objektschlüssel und die Bindungsdaten in `youtubeThumbnail`; keine signierte Download-URL gelangt in die Queue. Der Provider lädt das Bild erst privat aus R2, nachdem YouTube eine `videoId` bestätigt und das Video über `videos.list` auffindbar ist. Erst danach wird `thumbnails.set` genau einmal ausgeführt. Jeder neue Upload wird zunächst `private` und ohne `publishAt` angelegt. Erst nach exakt bestätigtem Thumbnail und abgeschlossener Verarbeitung setzt ein separat gecheckpointetes `videos.update` die gebundene öffentliche, nicht gelistete oder geplante Sichtbarkeit; bei Thumbnailfehlern bleibt das Video privat. Ein offenes `REQUESTING` oder ein uneindeutiger Netzwerk-/5xx-Ausgang wird nie automatisch wiederholt.

Die übrigen validierten YouTube-Einstellungen werden beim Video-Insert ebenfalls übernommen: Titel, Beschreibung, Tags, Kategorie, Sprache, Sichtbarkeit/Terminierung, Abonnenten-Benachrichtigung, Made-for-Kids-/Synthetic-Media-Angaben sowie Lizenz, Einbettbarkeit und öffentliche Statistik-Sichtbarkeit.

Der Seeder nutzt derzeit R2 Single-PUT und blockiert einzelne Dateien über 5 GiB. Größere YouTube-Dateien benötigen vor der Produktivfreigabe einen R2-Multipart-Uploader.

## Neue Pakete veröffentlichen (nach der Sichtung)

```bash
node "D:\Bilder\MZM\approve-and-schedule.mjs" --package "<Paketordner>" --at "<ISO-Zeit>" --live
```

`approve-and-schedule.mjs` ruft den fingerprint-scoped Seeder im Live-Modus automatisch auf. Zur Reparatur eines abgebrochenen Syncs kann derselbe Seeder-Befehl manuell wiederholt werden. Ein Bulk-Lauf ist absichtlich nur mit `--all` moeglich. CLI-Fortschritt wird als `CLOUD_SYNC_PENDING <fp8> ...` und nach vollstaendiger Bestaetigung als `CLOUD_SCHEDULED <fp8> ...` ausgegeben. Sobald auch nur ein angeforderter Fingerprint nicht vollstaendig bestaetigt ist, endet der Seeder ungleich null.

Danach innerhalb von 5 Minuten in der Cloud geplant. Prüflauf: Workflow `publish-due` manuell mit `mode=check` dispatchen oder lokal `node publish-cloud.mjs --check`.

TikTok-Inbox nach der tatsächlichen Veröffentlichung in der App bestätigen:

```bash
node "C:\Users\aaron\.codex\skills\upload\scripts\confirm-tiktok.mjs" --config "D:\Kreativ\Social Media\upload-config.json" --fingerprint "<64-hex>" --live --confirm --post-id "<optional>"
```

Bei Cloud-Authority aktualisiert dieser Befehl automatisch `scheduler/queue.json`. Eine TikTok-Direct-Post-Freigabe synchronisiert der Upload-Skill ebenfalls automatisch erneut in die Cloud-Queue.

Lokale Regressionstests (ohne echte Provider-Mutationen):

```bash
node --test tests/*.test.mjs
```

## Hinweis

GitHub kann geplante Workflows nach längerer Repository-Inaktivität deaktivieren. Das wird nicht durch automatische Leer-Commits umgangen; Repository-Aktivität und Workflow-Status deshalb betrieblich überwachen.
