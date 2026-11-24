using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace TravelMap
{
    public class MainForm : Form
    {
        private WebView2 web;
        private string baseDir;

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }

        public MainForm()
        {
            baseDir = Application.StartupPath;
            Text = "足迹地图";
            ClientSize = new Size(1380, 860);
            MinimumSize = new Size(1020, 660);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(7, 11, 17);
            string ico = Path.Combine(baseDir, "icon.ico");
            if (File.Exists(ico))
            {
                try { Icon = new Icon(ico); } catch { }
            }

            web = new WebView2();
            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = Color.FromArgb(7, 11, 17);
            Controls.Add(web);
            Load += OnLoad;
        }

        private async void OnLoad(object sender, EventArgs e)
        {
            try
            {
                string pages = Path.Combine(baseDir, "pages");
                string data = Path.Combine(baseDir, "data");
                string dataDir = Path.Combine(pages, "data");
                Directory.CreateDirectory(data);
                Directory.CreateDirectory(dataDir);
                var env = await CoreWebView2Environment.CreateAsync(null, data, null);
                await web.EnsureCoreWebView2Async(env);
                var s = web.CoreWebView2.Settings;
                s.AreDefaultContextMenusEnabled = false;
                s.IsStatusBarEnabled = false;
                s.AreDevToolsEnabled = true;
                s.IsZoomControlEnabled = true;
                s.IsPinchZoomEnabled = false;
                // 页面保存：DATA|json 写 data/travel.json；PHOTO|文件名|base64 写 data/photos/
                web.CoreWebView2.WebMessageReceived += (s2, args) =>
                {
                    try
                    {
                        string msg = args.TryGetWebMessageAsString();
                        if (string.IsNullOrEmpty(msg)) return;
                        if (msg.StartsWith("DATA|"))
                        {
                            string json = msg.Substring(5);
                            string tmp = Path.Combine(dataDir, "travel.json.tmp");
                            File.WriteAllText(tmp, json, new System.Text.UTF8Encoding(false));
                            File.Copy(tmp, Path.Combine(dataDir, "travel.json"), true);
                            File.Delete(tmp);
                        }
                        else if (msg.StartsWith("PHOTO|"))
                        {
                            var parts = msg.Split(new[] { '|' }, 3);
                            if (parts.Length == 3)
                            {
                                string name = Path.GetFileName(parts[1]);
                                if (string.IsNullOrEmpty(name) || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return;
                                string photoDir = Path.Combine(dataDir, "photos");
                                Directory.CreateDirectory(photoDir);
                                File.WriteAllBytes(Path.Combine(photoDir, name), Convert.FromBase64String(parts[2]));
                            }
                        }
                    }
                    catch { }
                };
                web.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "app.local", pages, CoreWebView2HostResourceAccessKind.Allow);
                web.CoreWebView2.Navigate("https://app.local/index.html");
            }
            catch (Exception ex)
            {
                MessageBox.Show("WebView2 初始化失败：\n" + ex.Message, "足迹地图",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }
}
