using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace StudyBuddy
{
    // Einstellungen und Lern-Datensätze (Chat + Fortschritt pro PDF).
    //
    // Pro PDF gibt es genau eine JSON-Datei "<Name>__<Fingerprint>.json" im Ordner "docs".
    // Der Inhalt wird nur von der Web-Seite interpretiert, hier werden nur Dateien bewegt.
    // Gespeichert wird immer lokal (%LOCALAPPDATA%\StudyBuddy\docs) und zusätzlich im
    // Sync-Ordner, falls einer gewählt ist (Netzlaufwerk, OneDrive, Nextcloud …).
    // Beim Laden gewinnt die neuere Datei; ist die lokale neuer, wird sie in den
    // Sync-Ordner nachgetragen (z. B. nach einer Offline-Phase).
    partial class ViewerForm
    {
        static readonly string DataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StudyBuddy" + Program.Profile);

        readonly Dictionary<string, string> settings = new Dictionary<string, string>();
        readonly object fileLock = new object();

        string SettingsFile { get { return Path.Combine(DataDir, "settings.ini"); } }
        string LocalDocsDir { get { return Path.Combine(DataDir, "docs"); } }
        string SyncDir { get { return Get("syncDir"); } }

        string Get(string key)
        {
            string v;
            return settings.TryGetValue(key, out v) ? v : "";
        }

        void LoadSettings()
        {
            try
            {
                if (File.Exists(SettingsFile))
                    foreach (string line in File.ReadAllLines(SettingsFile, Encoding.UTF8))
                    {
                        int i = line.IndexOf('=');
                        if (i > 0) settings[line.Substring(0, i).Trim()] = line.Substring(i + 1).Trim();
                    }
            }
            catch { }
            if (Get("deviceId").Length == 0)
            {
                settings["deviceId"] = Environment.MachineName + "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
                SaveSettings();
            }
        }

        void SaveSettings()
        {
            try
            {
                Directory.CreateDirectory(DataDir);
                var sb = new StringBuilder();
                sb.AppendLine("# StudyBuddy-Einstellungen");
                sb.AppendLine("# claudePath = optionaler Pfad zu claude.exe, model = z. B. sonnet / opus (leer = Standard)");
                foreach (var kv in settings) sb.AppendLine(kv.Key + "=" + kv.Value);
                File.WriteAllText(SettingsFile, sb.ToString(), new UTF8Encoding(false));
            }
            catch { }
        }

        void SendSettings()
        {
            string exe = ClaudeCli.Resolve(Get("claudePath"));
            Post("settings\n" + SyncDir + "\n" + (exe ?? "") + "\n" + Get("model") + "\n" + Get("deviceId"));
        }

        void PickSyncFolder()
        {
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = "Ordner für die Synchronisation wählen (z. B. auf einem Netzlaufwerk oder in OneDrive). " +
                    "Auf allen Geräten denselben Ordner wählen.";
                dlg.ShowNewFolderButton = true;
                if (SyncDir.Length > 0 && SafeDirExists(SyncDir)) dlg.SelectedPath = SyncDir;
                if (dlg.ShowDialog(this) == DialogResult.OK) SetSyncDir(dlg.SelectedPath);
            }
        }

        void SetSyncDir(string dir)
        {
            settings["syncDir"] = dir;
            SaveSettings();
            SendSettings();
            if (dir.Length == 0) return;
            // vorhandene lokale Datensätze in den Sync-Ordner übernehmen (nur neuere/fehlende)
            ThreadPool.QueueUserWorkItem(_ =>
            {
                int n = 0;
                try
                {
                    string target = Path.Combine(dir, "docs");
                    Directory.CreateDirectory(target);
                    if (Directory.Exists(LocalDocsDir))
                        foreach (string f in Directory.GetFiles(LocalDocsDir, "*.json"))
                        {
                            string t = Path.Combine(target, Path.GetFileName(f));
                            if (!File.Exists(t) || File.GetLastWriteTimeUtc(f) > File.GetLastWriteTimeUtc(t)) { File.Copy(f, t, true); n++; }
                        }
                    UiPost("syncok\n" + n);
                }
                catch (Exception ex) { UiPost("error\nSync-Ordner nicht beschreibbar:\n" + ex.Message); }
            });
        }

        static bool SafeDirExists(string d)
        {
            try { return Directory.Exists(d); } catch { return false; }
        }

        // aus Hintergrund-Threads an die Seite schicken
        void UiPost(string msg)
        {
            try { BeginInvoke((Action)(() => Post(msg))); } catch { }
        }

        static readonly Regex FpRx = new Regex("^[0-9a-fA-F]{8,64}$");

        static bool ValidKey(string key)
        {
            return key.Length > 0 && key.Length < 200 && key.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 &&
                   !key.Contains("..") && Path.GetFileName(key) == key;
        }

        // recfind:<fingerprint>\n<Dateiname ohne Endung, bereinigt>
        // -> rec\n<fp>\n<fileKey>\n<exact|name|none>\n<json>
        void RecFind(string arg)
        {
            string[] p = arg.Split(new[] { '\n' }, 2);
            string fp = p[0].Trim();
            string name = p.Length > 1 ? p[1].Trim() : "";
            if (!FpRx.IsMatch(fp) || (name.Length > 0 && !ValidKey(name))) return;
            string sync = SyncDir;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                string match = "none", key = "", json = "";
                try
                {
                    string syncDocs = sync.Length > 0 ? Path.Combine(sync, "docs") : null;
                    if (syncDocs != null && !SafeDirExists(syncDocs))
                    {
                        if (SafeDirExists(sync)) Directory.CreateDirectory(syncDocs);
                        else { UiPost("syncoffline\n" + sync); syncDocs = null; }
                    }
                    // 1) exakt dieselbe PDF (Fingerprint)
                    string file = Newest(FindFiles("*__" + fp + ".json", syncDocs));
                    if (file != null) match = "exact";
                    // 2) gleicher Dateiname, aber andere Version (z. B. aktualisierte Folien)
                    else if (name.Length > 0)
                    {
                        file = Newest(FindFiles(name + "__*.json", syncDocs));
                        if (file != null) match = "name";
                    }
                    if (file != null)
                    {
                        key = Path.GetFileNameWithoutExtension(file);
                        json = ReadShared(file);
                        // lokale Kopie neuer als Sync? -> nachtragen
                        if (syncDocs != null && file.StartsWith(LocalDocsDir, StringComparison.OrdinalIgnoreCase))
                            try { File.Copy(file, Path.Combine(syncDocs, Path.GetFileName(file)), true); } catch { }
                    }
                }
                catch (Exception ex) { UiPost("log:recfind " + ex.Message); }
                UiPost("rec\n" + fp + "\n" + key + "\n" + match + "\n" + json.Replace("\r", "").Replace("\n", " "));
            });
        }

        List<string> FindFiles(string pattern, string syncDocs)
        {
            var list = new List<string>();
            foreach (string d in new[] { syncDocs, LocalDocsDir })
            {
                if (d == null) continue;
                try { if (Directory.Exists(d)) list.AddRange(Directory.GetFiles(d, pattern)); } catch { }
            }
            return list;
        }

        static string Newest(List<string> files)
        {
            string best = null;
            DateTime bt = DateTime.MinValue;
            foreach (string f in files)
            {
                DateTime t;
                try { t = File.GetLastWriteTimeUtc(f); } catch { continue; }
                if (best == null || t > bt) { best = f; bt = t; }
            }
            return best;
        }

        static string ReadShared(string file)
        {
            using (var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var r = new StreamReader(fs, Encoding.UTF8)) return r.ReadToEnd();
        }

        // recsave:<fileKey>\n<json>
        void RecSave(string arg)
        {
            int i = arg.IndexOf('\n');
            if (i <= 0) return;
            string key = arg.Substring(0, i).Trim();
            string json = arg.Substring(i + 1);
            if (!ValidKey(key)) return;
            string sync = SyncDir;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                lock (fileLock)
                {
                    try { WriteAtomic(Path.Combine(LocalDocsDir, key + ".json"), json); }
                    catch (Exception ex) { UiPost("error\nSpeichern fehlgeschlagen:\n" + ex.Message); }
                    if (sync.Length > 0)
                        try
                        {
                            if (!SafeDirExists(sync)) { UiPost("syncoffline\n" + sync); return; }
                            WriteAtomic(Path.Combine(sync, "docs", key + ".json"), json);
                        }
                        catch (Exception ex) { UiPost("syncoffline\n" + sync + "\n" + ex.Message); }
                }
            });
        }

        static void WriteAtomic(string path, string text)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            string tmp = path + ".tmp";
            File.WriteAllText(tmp, text, new UTF8Encoding(false));
            if (!File.Exists(path)) { File.Move(tmp, path); return; }
            try { File.Replace(tmp, path, null, true); }
            catch (IOException) { File.Copy(tmp, path, true); File.Delete(tmp); } // manche Netzlaufwerke können kein Replace
        }
    }
}
