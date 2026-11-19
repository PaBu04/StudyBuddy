<p align="center"><img src="assets/icon-256.png" width="128" alt="StudyBuddy"></p>

# StudyBuddy

PDF-Viewer zum Lernen mit **Claude als Lernbegleiter**. Links ist ein Claude-Chat, rechts der Foliensatz. Basiert auf [SlimPDF](https://github.com/PaBu04/SlimPDF) (PDF.js + Microsoft Edge WebView2).

## Funktionen

**Lernen mit Claude**
- Chat links, PDF rechts (Splitview, Breite per Ziehen änderbar, `Strg+L` blendet den Chat ein/aus)
- Claude bekommt automatisch Dateiname, Pfad, aktuelle Seite und den Text dieser Seite mit
- Markierter Text im PDF wird mitgeschickt. Rechtsklick auf eine Markierung bietet *Erklären*, *Beispiel*, *Übersetzen* und *Quizfrage* an
- Claude kann die PDF selbst lesen (auch Diagramme und Formeln) und im Web recherchieren. Dateien ändern oder Befehle ausführen kann Claude nicht
- Formeln (LaTeX via KaTeX) und Markdown in den Antworten. Seitenverweise wie „S. 12“ sind anklickbar
- Ein Chat pro PDF: Öffnest du eine PDF, zu der es schon einen Chat gibt, wird er automatisch geöffnet und fortgesetzt

**Synchronisation zwischen Geräten**
- Im Chat-Menü (`⋯`) einen **Sync-Ordner** wählen, z. B. auf einem Netzlaufwerk oder in OneDrive/Nextcloud. Auf allen Geräten denselben Ordner wählen
- Synchronisiert werden Chatverlauf, Leseposition und Gelesen-Status
- PDFs werden am Inhalt (PDF-Fingerprint) erkannt, nicht am Pfad. Die Datei darf auf jedem Gerät woanders liegen
- Ist der Sync-Ordner nicht erreichbar, wird lokal gespeichert und später nachgetragen

**Vom PDF-Viewer (SlimPDF)**
- Randloses Fenster, Tabs und Tab-Gruppen, Sitzung wird wiederhergestellt
- Suche, Zoom, Einzelseiten-Modus, Vollbild, Drag & Drop, Gelesen-Markierung

## Voraussetzungen

- Windows 10/11 (x64) mit der Microsoft Edge WebView2 Runtime (unter Windows 11 vorinstalliert)
- **[Claude Code](https://claude.com/claude-code)**, einmal im Terminal mit `claude` angemeldet. StudyBuddy findet `claude.exe` im `PATH`, unter `%USERPROFILE%\.local\bin`, als npm-Installation oder in der VS-Code-Extension. Sonst den Pfad in `%LOCALAPPDATA%\StudyBuddy\settings.ini` als `claudePath=…` eintragen

## Wie Claude eingebunden ist

StudyBuddy startet für jede Nachricht `claude -p` (Claude Code im Print-Modus) mit Streaming-Ausgabe:

- Erlaubte Tools: nur `Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`. Alles andere wird automatisch abgelehnt
- Arbeitsverzeichnis: `%LOCALAPPDATA%\StudyBuddy\claude`. Die `CLAUDE.md` dort enthält die Tutor-Anweisungen. Der Ordner der PDF wird per `--add-dir` freigegeben
- Pro PDF und Gerät gibt es eine Claude-Code-Session, die mit `--resume` fortgesetzt wird. Wurde der Chat auf einem anderen Gerät begonnen, startet eine neue Session und bekommt den bisherigen Verlauf als Kontext
- Das Modell lässt sich im Chat-Menü wählen (Standard = Claude-Code-Voreinstellung)

## Daten

| Ort | Inhalt |
|---|---|
| `%LOCALAPPDATA%\StudyBuddy\settings.ini` | Sync-Ordner, Modell, Geräte-ID, optional `claudePath` |
| `%LOCALAPPDATA%\StudyBuddy\docs\` | lokale Kopie aller Datensätze (eine JSON-Datei pro PDF) |
| `<Sync-Ordner>\docs\` | synchronisierte Datensätze |

## Selbst bauen

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

Das Skript lädt beim ersten Lauf das WebView2 SDK (NuGet), PDF.js und KaTeX (npm) nach `_deps\`. Kompiliert wird mit dem `csc.exe` aus dem .NET Framework 4.x, das bei Windows dabei ist. Das Ergebnis landet in `dist\`. Installieren mit `dist\Install.cmd`.

## Debugging

| Umgebungsvariable | Wirkung |
|---|---|
| `STUDYBUDDY_DEBUG=1` | DevTools aktivieren, Log nach `%LOCALAPPDATA%\StudyBuddy\debug.log` |
| `STUDYBUDDY_PROFILE=name` | Getrenntes Profil/Instanz (eigene Einstellungen und Daten), z. B. zum Testen |
| `STUDYBUDDY_TEST=ask:<Frage>` | nur mit Debug: stellt nach dem Öffnen automatisch eine Frage an Claude |

## Lizenz

[MIT](LICENSE). Mitgelieferte Drittkomponenten siehe [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
