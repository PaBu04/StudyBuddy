using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

namespace StudyBuddy
{
    // Findet die Claude-Code-CLI und baut Kommandozeilen.
    static class ClaudeCli
    {
        public static string Resolve(string configured)
        {
            if (!string.IsNullOrEmpty(configured) && File.Exists(configured)) return configured;

            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (string name in new[] { "claude.exe", "claude.cmd" })
                foreach (string dir in path.Split(';'))
                {
                    try
                    {
                        if (dir.Trim().Length == 0) continue;
                        string f = Path.Combine(dir.Trim(), name);
                        if (File.Exists(f)) return f;
                    }
                    catch { }
                }

            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            foreach (string f in new[] {
                Path.Combine(home, @".local\bin\claude.exe"),
                Path.Combine(appData, @"npm\claude.cmd") })
                if (File.Exists(f)) return f;

            // Claude Code aus der VS-Code-Extension (neueste Version)
            string best = null;
            DateTime bestT = DateTime.MinValue;
            foreach (string ed in new[] { ".vscode", ".vscode-insiders", ".cursor", ".windsurf" })
            {
                string ext = Path.Combine(home, ed, "extensions");
                try
                {
                    if (!Directory.Exists(ext)) continue;
                    foreach (string d in Directory.GetDirectories(ext, "anthropic.claude-code-*"))
                    {
                        string f = Path.Combine(d, @"resources\native-binary\claude.exe");
                        if (!File.Exists(f)) continue;
                        DateTime t = File.GetLastWriteTimeUtc(f);
                        if (t > bestT) { best = f; bestT = t; }
                    }
                }
                catch { }
            }
            return best;
        }

        // Windows-Argumentregeln (CommandLineToArgvW)
        public static string Quote(string a)
        {
            if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
            var sb = new StringBuilder("\"");
            int bs = 0;
            foreach (char c in a)
            {
                if (c == '\\') { bs++; continue; }
                if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
                sb.Append('\\', bs); bs = 0;
                sb.Append(c);
            }
            sb.Append('\\', bs * 2);
            sb.Append('"');
            return sb.ToString();
        }
    }

    partial class ViewerForm
    {
        readonly Dictionary<string, Process> claudeRuns = new Dictionary<string, Process>();

        const string Instructions =
@"# StudyBuddy – Lernbegleiter

Du bist in **StudyBuddy** eingebettet, einem PDF-Viewer zum Lernen. Links im Fenster ist dieser Chat,
rechts liest die Nutzerin bzw. der Nutzer Vorlesungsfolien oder Skripte.

## Kontext
- Jede Nachricht beginnt mit einem Block `[StudyBuddy-Kontext] … [/StudyBuddy-Kontext]`. Er enthält Dateiname,
  absoluten Pfad, die gerade angezeigte Seite und den automatisch extrahierten Text dieser Seite.
  Ggf. auch markierten Text. Dieser Block wird automatisch erzeugt – erwähne ihn nicht ausdrücklich.
- Bezieht sich eine Frage auf „diese Folie“, „hier“ o. ä., ist die aktuelle Seite gemeint.
- Reicht der extrahierte Text nicht (Diagramme, Formeln, Bilder, andere Seiten), lies die PDF selbst mit dem
  Read-Tool (Parameter `pages`, z. B. ""12"" oder ""10-14""; max. 20 Seiten pro Aufruf).
- Du darfst im Web recherchieren (WebSearch/WebFetch), wenn es dem Verständnis hilft. Nenne dann die Quelle.
- Du kannst keine Dateien verändern und keine Befehle ausführen.

## Skills
- Die Skills der Nutzerin bzw. des Nutzers stehen dir über das Skill-Tool zur Verfügung. Wird ein Skill genannt
  (z. B. „vorlesung-erklaeren“ bzw. „Nutze den Skill …“), rufe ihn auf und folge seinen Anweisungen.
- Für `vorlesung-erklaeren`: „Hochgeladene Folien“ ist der Foliensatz aus dem Kontext-Block. Lies ihn mit Read
  (in Blöcken von max. 20 Seiten). Die Anweisungen des Skills haben Vorrang vor dem Stil unten.
- Läuft ein Skill (z. B. schrittweises Erklären), bleib dabei: „weiter“ heißt nächster Schritt, auch wenn die
  aktuelle Seite im Kontext-Block eine andere ist. Zwischenfragen beantworten und danach an derselben Stelle fortsetzen.

## Stil
- Antworte auf Deutsch (außer es wird anders gewünscht), klar und kompakt, wie ein guter Tutor.
- Erkläre verständlich, mit Intuition und Beispielen. Nicht einfach die Folie vorlesen.
- Formeln in LaTeX: inline `$…$`, abgesetzt `$$…$$`. Markdown ist erlaubt (Überschriften, Listen, Tabellen, Code).
- Beim Abfragen (Quiz): stelle eine Frage nach der anderen und warte auf die Antwort, bevor du auflöst.
- Verweise auf Seiten mit „S. 12“, damit man im Foliensatz nachschlagen kann.
";

        string Workspace
        {
            get
            {
                string ws = Path.Combine(DataDir, "claude");
                try
                {
                    Directory.CreateDirectory(ws);
                    string md = Path.Combine(ws, "CLAUDE.md");
                    if (!File.Exists(md) || File.ReadAllText(md, Encoding.UTF8) != Instructions)
                        File.WriteAllText(md, Instructions, new UTF8Encoding(false));
                }
                catch { }
                return ws;
            }
        }

        // ask:<reqId>\n<resume|new>\n<sessionId>\n<PDF-Ordner>\n<Prompt …>
        // Antworten: cc\n<reqId>\n<JSON-Zeile> | ccerr\n<reqId>\n<Text> | ccend\n<reqId>\n<Exitcode>
        void ClaudeAsk(string arg)
        {
            string[] p = arg.Split(new[] { '\n' }, 5);
            if (p.Length < 5) return;
            string req = p[0], mode = p[1], sid = p[2], pdfDir = p[3], prompt = p[4];
            Guid g;
            if (!Guid.TryParse(sid, out g)) { Post("ccerr\n" + req + "\nUngültige Session-ID"); Post("ccend\n" + req + "\n1"); return; }

            string exe = ClaudeCli.Resolve(Get("claudePath"));
            if (exe == null)
            {
                Post("ccerr\n" + req + "\nClaude Code wurde nicht gefunden. Bitte Claude Code installieren " +
                     "(https://claude.com/claude-code) und einmal im Terminal mit „claude“ anmelden – " +
                     "oder in settings.ini „claudePath=…“ setzen.");
                Post("ccend\n" + req + "\n127");
                return;
            }

            var args = new List<string> {
                "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                "--tools", "Read,Glob,Grep,WebSearch,WebFetch,Skill",
                "--allowedTools", "Read,Glob,Grep,WebSearch,WebFetch,Skill",
                "--permission-prompts", "none",
                "--strict-mcp-config",
            };
            args.Add(mode == "resume" ? "--resume" : "--session-id");
            args.Add(sid);
            if (Get("model").Length > 0) { args.Add("--model"); args.Add(Get("model")); }
            if (pdfDir.Length > 0) { args.Add("--add-dir"); args.Add(pdfDir); }

            var sb = new StringBuilder();
            foreach (string a in args) { if (sb.Length > 0) sb.Append(' '); sb.Append(ClaudeCli.Quote(a)); }

            var psi = new ProcessStartInfo
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                WorkingDirectory = Workspace,
            };
            if (exe.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase))
            {
                psi.FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe");
                psi.Arguments = "/d /s /c \"" + ClaudeCli.Quote(exe) + " " + sb + "\"";
            }
            else
            {
                psi.FileName = exe;
                psi.Arguments = sb.ToString();
            }
            psi.EnvironmentVariables.Remove("CLAUDECODE"); // falls StudyBuddy aus einer Claude-Code-Sitzung gestartet wurde

            Process proc;
            try { proc = Process.Start(psi); }
            catch (Exception ex)
            {
                Post("ccerr\n" + req + "\nClaude Code konnte nicht gestartet werden: " + ex.Message);
                Post("ccend\n" + req + "\n1");
                return;
            }
            claudeRuns[req] = proc;

            // Prompt über stdin (UTF-8, ohne BOM) – vermeidet Probleme mit Anführungszeichen und Längenlimits
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    byte[] data = new UTF8Encoding(false).GetBytes(prompt);
                    proc.StandardInput.BaseStream.Write(data, 0, data.Length);
                    proc.StandardInput.BaseStream.Flush();
                    proc.StandardInput.Close();
                }
                catch { }
            });

            var errBuf = new StringBuilder();
            var errThread = new Thread(() =>
            {
                try { string l; while ((l = proc.StandardError.ReadLine()) != null) lock (errBuf) errBuf.AppendLine(l); } catch { }
            });
            errThread.IsBackground = true;
            errThread.Start();

            var outThread = new Thread(() =>
            {
                try
                {
                    string line;
                    while ((line = proc.StandardOutput.ReadLine()) != null)
                        if (line.Length > 0) UiPost("cc\n" + req + "\n" + line);
                }
                catch { }
                errThread.Join(2000);
                int code = -1;
                try { proc.WaitForExit(5000); code = proc.ExitCode; } catch { }
                string err;
                lock (errBuf) err = errBuf.ToString().Trim();
                try
                {
                    BeginInvoke((Action)(() =>
                    {
                        claudeRuns.Remove(req);
                        if (err.Length > 0) Post("ccerr\n" + req + "\n" + err);
                        Post("ccend\n" + req + "\n" + code);
                    }));
                }
                catch { }
            });
            outThread.IsBackground = true;
            outThread.Start();
        }

        // Skills aus ~/.claude/skills (inkl. von claude.ai synchronisierter) für die "/"-Autovervollständigung
        // -> skills\n<name>\t<Beschreibung>\n…
        void ListSkills()
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                var sb = new StringBuilder("skills");
                string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), @".claude\skills");
                try
                {
                    if (Directory.Exists(root))
                        foreach (string f in FindSkillFiles(root, 0))
                        {
                            string name = null, desc = "";
                            ParseSkill(f, ref name, ref desc);
                            if (string.IsNullOrEmpty(name)) name = Path.GetFileName(Path.GetDirectoryName(f));
                            if (!seen.Add(name)) continue;
                            sb.Append('\n').Append(name.Replace("\t", " ")).Append('\t').Append(desc.Replace("\t", " ").Replace("\n", " "));
                        }
                }
                catch { }
                UiPost(sb.ToString());
            });
        }

        static IEnumerable<string> FindSkillFiles(string dir, int depth)
        {
            var list = new List<string>();
            try
            {
                string f = Path.Combine(dir, "SKILL.md");
                if (File.Exists(f)) { list.Add(f); return list; }
                if (depth >= 3) return list;
                foreach (string d in Directory.GetDirectories(dir))
                {
                    string n = Path.GetFileName(d);
                    if (n.StartsWith(".")) continue; // .staging, .bucket-… usw.
                    list.AddRange(FindSkillFiles(d, depth + 1));
                }
            }
            catch { }
            return list;
        }

        static void ParseSkill(string file, ref string name, ref string desc)
        {
            string[] lines;
            try { lines = File.ReadAllLines(file, Encoding.UTF8); } catch { return; }
            if (lines.Length == 0 || lines[0].Trim() != "---") return;
            for (int i = 1; i < lines.Length && lines[i].Trim() != "---"; i++)
            {
                string l = lines[i];
                int c = l.IndexOf(':');
                if (c <= 0) continue;
                string k = l.Substring(0, c).Trim(), v = l.Substring(c + 1).Trim().Trim('"', '\'');
                if (k == "name") name = v;
                else if (k == "description") desc = v;
            }
        }

        void ClaudeStop(string req)
        {
            Process p;
            if (!claudeRuns.TryGetValue(req.Trim(), out p)) return;
            KillTree(p);
        }

        void StopAllClaude()
        {
            foreach (Process p in new List<Process>(claudeRuns.Values)) KillTree(p);
            claudeRuns.Clear();
        }

        static void KillTree(Process p)
        {
            try
            {
                if (p.HasExited) return;
                var k = Process.Start(new ProcessStartInfo("taskkill", "/T /F /PID " + p.Id) { CreateNoWindow = true, UseShellExecute = false });
                if (k != null) k.WaitForExit(3000);
            }
            catch { }
            try { if (!p.HasExited) p.Kill(); } catch { }
        }
    }
}
