using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: System.Reflection.AssemblyTitle("StudyBuddy")]
[assembly: System.Reflection.AssemblyProduct("StudyBuddy")]
[assembly: System.Reflection.AssemblyDescription("PDF-Viewer mit Claude als Lernbegleiter")]
[assembly: System.Reflection.AssemblyVersion("0.1.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.1.0.0")]

namespace StudyBuddy
{
    static class Program
    {
        [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);

        // STUDYBUDDY_PROFILE (optional): getrenntes Profil, z. B. zum Testen
        public static readonly string Profile = Environment.GetEnvironmentVariable("STUDYBUDDY_PROFILE") ?? "";
        static readonly string PipeName = "StudyBuddy-" + Process.GetCurrentProcess().SessionId + "-" + Environment.UserName + Profile;

        [STAThread]
        static void Main(string[] args)
        {
            var files = new List<string>();
            foreach (string a in args)
                if (!string.IsNullOrEmpty(a) && File.Exists(a)) files.Add(Path.GetFullPath(a));

            bool isFirst;
            var mutex = new Mutex(true, "Local\\StudyBuddy.Instance" + Profile, out isFirst);

            // Läuft schon ein Fenster? Dann PDFs dort als Tabs öffnen.
            if (!isFirst && files.Count > 0 && SendToRunningInstance(files)) return;

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var form = new ViewerForm(files, isFirst);
            if (isFirst) form.Shown += delegate { StartPipeServer(form); };
            Application.Run(form);
            GC.KeepAlive(mutex);
        }

        static bool SendToRunningInstance(List<string> files)
        {
            AllowSetForegroundWindow(-1);
            byte[] data = Encoding.UTF8.GetBytes(string.Join("\n", files.ToArray()));
            for (int i = 0; i < 20; i++)
            {
                try
                {
                    using (var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out))
                    {
                        client.Connect(300);
                        client.Write(data, 0, data.Length);
                        client.Flush();
                        return true;
                    }
                }
                catch { Thread.Sleep(150); }
            }
            return false;
        }

        static void StartPipeServer(ViewerForm form)
        {
            var t = new Thread(() =>
            {
                while (true)
                {
                    try
                    {
                        using (var server = new NamedPipeServerStream(PipeName, PipeDirection.In, 1))
                        {
                            server.WaitForConnection();
                            string text;
                            using (var r = new StreamReader(server, Encoding.UTF8)) text = r.ReadToEnd();
                            string[] paths = text.Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
                            form.BeginInvoke((Action)(() => form.OpenFromOtherInstance(paths)));
                        }
                    }
                    catch { Thread.Sleep(200); }
                }
            });
            t.IsBackground = true;
            t.Start();
        }
    }

    partial class ViewerForm : Form
    {
        const string AppHost = "app.studybuddy";
        const string DocHost = "doc.studybuddy";

        const int WM_NCCALCSIZE = 0x0083;
        const int WM_NCLBUTTONDOWN = 0x00A1;
        const int HTCAPTION = 2;
        const int HTTOP = 12;

        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int left, top, right, bottom; }

        [StructLayout(LayoutKind.Sequential)]
        struct NCCALCSIZE_PARAMS { public RECT rgrc0, rgrc1, rgrc2; public IntPtr lppos; }

        [DllImport("user32.dll")] static extern bool ReleaseCapture();
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hWnd, int attr, ref int value, int size);

        readonly WebView2 web;
        readonly string appDir = AppDomain.CurrentDomain.BaseDirectory;
        readonly List<string> pendingFiles;
        readonly Dictionary<string, string> docs = new Dictionary<string, string>();
        int nextDocId;
        string lastDir;
        bool pageReady;
        bool fullscreen;
        FormWindowState stateBeforeFullscreen;

        readonly bool primary; // Hauptfenster: stellt Sitzung wieder her und speichert sie

        public ViewerForm(List<string> files, bool primary)
        {
            this.primary = primary;
            pendingFiles = new List<string>(files);
            Text = "StudyBuddy";
            BackColor = Color.FromArgb(59, 59, 59);
            try
            {
                string ico = Path.Combine(appDir, "app.ico");
                Icon = File.Exists(ico) ? new Icon(ico) : Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch { }
            StartPosition = FormStartPosition.WindowsDefaultLocation;

            float scale = DeviceDpi / 96f;
            Rectangle wa = Screen.FromPoint(Cursor.Position).WorkingArea;
            Size = new Size(Math.Min((int)(1400 * scale), wa.Width), Math.Min((int)(1000 * scale), (int)(wa.Height * 0.92)));
            MinimumSize = new Size((int)(320 * scale), (int)(200 * scale));

            web = new WebView2();
            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = BackColor;
            Controls.Add(web);

            Load += delegate { InitWeb(); };
            Resize += delegate { SendState(); };
            FormClosing += delegate { StopAllClaude(); };
            LoadSettings();
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            int on = 1;
            DwmSetWindowAttribute(Handle, 20, ref on, 4); // DWMWA_USE_IMMERSIVE_DARK_MODE
            SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020);
        }

        // Titelleiste entfernen, Systemrahmen (Snap, Schatten, Größenänderung) behalten
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCCALCSIZE && m.WParam != IntPtr.Zero)
            {
                var before = (NCCALCSIZE_PARAMS)Marshal.PtrToStructure(m.LParam, typeof(NCCALCSIZE_PARAMS));
                base.WndProc(ref m);
                var p = (NCCALCSIZE_PARAMS)Marshal.PtrToStructure(m.LParam, typeof(NCCALCSIZE_PARAMS));
                p.rgrc0.top = before.rgrc0.top;
                if (IsZoomed(Handle))
                    p.rgrc0.top += p.rgrc0.left - before.rgrc0.left;
                Marshal.StructureToPtr(p, m.LParam, false);
                m.Result = IntPtr.Zero;
                return;
            }
            base.WndProc(ref m);
        }

        async void InitWeb()
        {
            CoreWebView2Environment env;
            try
            {
                string udf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StudyBuddy", "WebView2" + Program.Profile);
                env = await CoreWebView2Environment.CreateAsync(null, udf, null);
                await web.EnsureCoreWebView2Async(env);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Microsoft Edge WebView2 konnte nicht gestartet werden.\n\n" + ex.Message, "StudyBuddy",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }

            CoreWebView2 cw = web.CoreWebView2;
            CoreWebView2Settings st = cw.Settings;
            st.AreDevToolsEnabled = Environment.GetEnvironmentVariable("STUDYBUDDY_DEBUG") != null;
            st.IsStatusBarEnabled = false;
            st.IsZoomControlEnabled = false;
            st.AreBrowserAcceleratorKeysEnabled = false;
            st.IsPasswordAutosaveEnabled = false;
            st.IsGeneralAutofillEnabled = false;
            st.IsNonClientRegionSupportEnabled = true; // CSS app-region: drag

            cw.SetVirtualHostNameToFolderMapping(AppHost, Path.Combine(appDir, "web"), CoreWebView2HostResourceAccessKind.Allow);
            cw.AddWebResourceRequestedFilter("https://" + DocHost + "/*", CoreWebView2WebResourceContext.All);
            cw.WebResourceRequested += (s, e) => ServeDocument(env, e);
            cw.WebMessageReceived += OnWebMessage;
            cw.NewWindowRequested += (s, e) => { e.Handled = true; OpenExternal(e.Uri); };
            cw.NavigationStarting += (s, e) =>
            {
                if (e.Uri.StartsWith("https://" + AppHost + "/")) return;
                e.Cancel = true;
                Uri u;
                if (Uri.TryCreate(e.Uri, UriKind.Absolute, out u) && u.IsFile)
                    OpenFile(u.LocalPath, "");
                else
                    OpenExternal(e.Uri);
            };
            cw.Navigate("https://" + AppHost + "/index.html");
        }

        // https://doc.studybuddy/<id>/<name>  ->  lokale Datei
        void ServeDocument(CoreWebView2Environment env, CoreWebView2WebResourceRequestedEventArgs e)
        {
            const string cors = "Access-Control-Allow-Origin: *";
            try
            {
                string[] seg = new Uri(e.Request.Uri).AbsolutePath.Split('/');
                string path;
                if (seg.Length < 2 || !docs.TryGetValue(seg[1], out path) || !File.Exists(path))
                {
                    e.Response = env.CreateWebResourceResponse(null, 404, "Not Found", cors);
                    return;
                }
                var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                e.Response = env.CreateWebResourceResponse(fs, 200, "OK",
                    "Content-Type: application/pdf\r\nContent-Length: " + fs.Length + "\r\n" + cors + "\r\nCache-Control: no-store");
            }
            catch (Exception ex)
            {
                e.Response = env.CreateWebResourceResponse(null, 500, "Error", cors);
                Post("error\n" + ex.Message);
            }
        }

        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string msg;
            try { msg = e.TryGetWebMessageAsString(); } catch { return; }
            string cmd = msg, arg = "";
            int i = msg.IndexOf(':');
            if (i >= 0) { cmd = msg.Substring(0, i); arg = msg.Substring(i + 1); }

            switch (cmd)
            {
                case "ready":
                    pageReady = true;
                    string testFind = Environment.GetEnvironmentVariable("STUDYBUDDY_DEBUG") != null
                        ? Environment.GetEnvironmentVariable("STUDYBUDDY_TEST") ?? "" : "";
                    Post("init\n" + (primary ? "primary" : "secondary") + "\n" + testFind);
                    SendState();
                    foreach (string f in pendingFiles) OpenFile(f, "");
                    pendingFiles.Clear();
                    break;
                case "drop":
                    if (e.AdditionalObjects != null)
                        foreach (object o in e.AdditionalObjects)
                        {
                            var f = o as CoreWebView2File;
                            if (f != null && File.Exists(f.Path)) OpenFile(f.Path, arg);
                        }
                    break;
                case "reg":   // Tab nachladen (Sitzung / "erneut prüfen")
                    CheckInBackground(arg, true);
                    break;
                case "probe": // nur prüfen, ob erreichbar (für Offline-Anzeige)
                    CheckInBackground(arg, false);
                    break;
                case "open": ShowOpenDialog(arg); break;
                case "min": WindowState = FormWindowState.Minimized; break;
                case "max":
                    if (fullscreen) ToggleFullscreen();
                    else WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                    break;
                case "close": Close(); break;
                case "fullscreen": ToggleFullscreen(); break;
                case "esc": if (fullscreen) ToggleFullscreen(); break;
                case "drag": NcMouseDown(HTCAPTION); break;
                case "resizeTop": if (!IsZoomed(Handle)) NcMouseDown(HTTOP); break;
                case "title": Text = arg.Length == 0 ? "StudyBuddy" : arg + " – StudyBuddy"; break;
                // ---- StudyBuddy: Einstellungen, Speicher/Sync, Claude ----
                case "settings": SendSettings(); break;
                case "pickSync": PickSyncFolder(); break;
                case "clearSync": SetSyncDir(""); break;
                case "setModel": settings["model"] = arg.Trim(); SaveSettings(); SendSettings(); break;
                case "recfind": RecFind(arg); break;
                case "recsave": RecSave(arg); break;
                case "ask": ClaudeAsk(arg); break;
                case "stop": ClaudeStop(arg); break;
                case "skills": ListSkills(); break;
                case "prepcheck": PrepCheck(arg); break;
                case "prepfile": PrepFile(arg); break;
                case "prepdone": PrepDone(arg); break;
                case "log": // nur mit STUDYBUDDY_DEBUG
                    if (Environment.GetEnvironmentVariable("STUDYBUDDY_DEBUG") != null)
                        try
                        {
                            File.AppendAllText(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                                "StudyBuddy", "debug" + Program.Profile + ".log"), DateTime.Now.ToString("HH:mm:ss ") + arg + Environment.NewLine);
                        }
                        catch { }
                    break;            }
        }

        // ---------- Offline-Dateien (z. B. Netzlaufwerk) ----------
        // Geprüft wird nur beim Start bzw. auf Wunsch ("erneut prüfen"), kein Dauer-Polling.
        // File.Exists kann bei getrennten Netzlaufwerken lange hängen -> nie im UI-Thread.
        static bool SafeExists(string path)
        {
            try { return File.Exists(path); } catch { return false; }
        }

        void CheckInBackground(string path, bool load)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                bool ok = SafeExists(path);
                try
                {
                    BeginInvoke((Action)(() =>
                    {
                        if (ok) { if (load) OpenFile(path, "restore"); else Post("online\n" + path); }
                        else Post("missing\n" + path);
                    }));
                }
                catch { }
            });
        }

        public void OpenFromOtherInstance(string[] paths)
        {
            foreach (string p in paths)
            {
                if (pageReady) OpenFile(p, "");
                else pendingFiles.Add(p);
            }
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            SetForegroundWindow(Handle);
        }

        void NcMouseDown(int hit)
        {
            ReleaseCapture();
            SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)hit, IntPtr.Zero);
        }

        void ToggleFullscreen()
        {
            if (!fullscreen)
            {
                stateBeforeFullscreen = WindowState;
                fullscreen = true;
                if (WindowState == FormWindowState.Maximized) WindowState = FormWindowState.Normal;
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Maximized;
            }
            else
            {
                fullscreen = false;
                WindowState = FormWindowState.Normal;
                FormBorderStyle = FormBorderStyle.Sizable;
                WindowState = stateBeforeFullscreen;
            }
            SendState();
        }

        void SendState()
        {
            if (!pageReady) return;
            Post("state\n" + (fullscreen ? "full" : WindowState == FormWindowState.Maximized ? "max" : "normal"));
        }

        void ShowOpenDialog(string tag)
        {
            using (var dlg = new OpenFileDialog())
            {
                dlg.Filter = "PDF-Dokumente (*.pdf)|*.pdf|Alle Dateien (*.*)|*.*";
                dlg.Title = "PDF öffnen";
                dlg.Multiselect = true;
                if (lastDir != null) dlg.InitialDirectory = lastDir;
                if (dlg.ShowDialog(this) == DialogResult.OK)
                    foreach (string f in dlg.FileNames) OpenFile(f, tag);
            }
        }

        // tag: Gruppen-ID, in die der Tab soll, oder "restore"
        void OpenFile(string path, string tag)
        {
            try
            {
                path = Path.GetFullPath(path);
                if (!SafeExists(path))
                {
                    if (tag == "restore") Post("missing\n" + path);
                    else Post("error\nDatei nicht gefunden:\n" + path);
                    return;
                }
                lastDir = Path.GetDirectoryName(path);
                string id = (++nextDocId).ToString();
                docs[id] = path;
                string name = Path.GetFileName(path);
                string url = "https://" + DocHost + "/" + id + "/" + Uri.EscapeDataString(name);
                Post("load\n" + url + "\n" + name + "\n" + path + "\n" + (tag ?? ""));
            }
            catch (Exception ex) { Post("error\n" + ex.Message); }
        }

        void Post(string msg)
        {
            if (pageReady && web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsString(msg);
        }

        static void OpenExternal(string uri)
        {
            Uri u;
            if (!Uri.TryCreate(uri, UriKind.Absolute, out u)) return;
            if (u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "mailto") return;
            try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch { }
        }
    }
}
