using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SAI2PoseStudio
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Studio(args.Length == 2 && args[0] == "--smoke-test" ? args[1] : null));
        }
    }

    internal sealed class Studio : Form
    {
        private const string HostName = "studio.sai2.local";
        private readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill };
        private readonly string smokeProfile;
        private bool smokeExport;

        internal Studio(string smokeProfile)
        {
            this.smokeProfile = smokeProfile;
            Text = "SAI2 工具包 · 3D 人偶";
            ClientSize = new Size(1000, 690);
            MinimumSize = new Size(420, 510);
            StartPosition = FormStartPosition.CenterScreen;
            Controls.Add(web);
            if (smokeProfile != null)
            {
                Environment.ExitCode = 1;
                ShowInTaskbar = false;
                WindowState = FormWindowState.Minimized;
                var timeout = new Timer { Interval = 25000 };
                timeout.Tick += (_, __) => Close();
                FormClosed += (_, __) => timeout.Dispose();
                timeout.Start();
            }
            Shown += LoadStudio;
        }

        private async void LoadStudio(object sender, EventArgs args)
        {
            try
            {
                var content = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "web");
                if (!File.Exists(Path.Combine(content, "index.html")))
                    throw new FileNotFoundException("3D 页面不完整，请重新解压完整验收包。");
                var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "SAI2CanvasRecorder", "PoseStudio-WebView");
                var environment = await CoreWebView2Environment.CreateAsync(
                    userDataFolder: smokeProfile == null ? data : Path.GetFullPath(smokeProfile));
                if (IsDisposed) return;
                await web.EnsureCoreWebView2Async(environment);
                if (IsDisposed) return;
                var view = web.CoreWebView2;
                view.Settings.AreDefaultContextMenusEnabled = false;
                view.Settings.AreDevToolsEnabled = false;
                view.Settings.IsWebMessageEnabled = false;
                view.Settings.IsPasswordAutosaveEnabled = false;
                view.Settings.IsGeneralAutofillEnabled = false;
                view.SetVirtualHostNameToFolderMapping(HostName, content, CoreWebView2HostResourceAccessKind.Deny);
                view.NavigationStarting += (_, e) => e.Cancel = !Allowed(e.Uri);
                view.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
                view.WebResourceRequested += (_, e) =>
                {
                    var url = e.Request.Uri;
                    if (!Allowed(url) && !url.StartsWith("blob:https://" + HostName + "/", StringComparison.Ordinal) &&
                        !url.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
                        e.Response = view.Environment.CreateWebResourceResponse(null, 403, "Forbidden", "");
                };
                view.NewWindowRequested += (_, e) => e.Handled = true;
                view.DownloadStarting += SaveReference;
                if (smokeProfile != null)
                {
                    var ready = new Timer { Interval = 300 };
                    ready.Tick += async (_, __) =>
                    {
                        ready.Stop();
                        try
                        {
                            var result = await view.ExecuteScriptAsync(
                                "(() => { const button = document.querySelector('#export:enabled'); " +
                                "if (!button || !document.querySelector('canvas')) return false;" +
                                "button.click(); return true; })()");
                            if (IsDisposed) return;
                            if (result != "true") ready.Start();
                        }
                        catch (InvalidOperationException) { if (!IsDisposed) Close(); }
                    };
                    FormClosed += (_, __) => ready.Dispose();
                    ready.Start();
                }
                view.Navigate("https://" + HostName + "/index.html");
            }
            catch (WebView2RuntimeNotFoundException)
            {
                if (IsDisposed) return;
                if (smokeProfile != null) { Close(); return; }
                if (MessageBox.Show(this, "未安装 WebView2 Runtime。是否打开微软下载页？",
                    Text, MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                    Process.Start(new ProcessStartInfo("https://developer.microsoft.com/microsoft-edge/webview2/") { UseShellExecute = true });
                Close();
            }
            catch (Exception error)
            {
                if (IsDisposed) return;
                if (smokeProfile != null) { Close(); return; }
                MessageBox.Show(this, "3D 组件无法启动：" + error.Message,
                    Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }

        private static bool Allowed(string url) =>
            Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == "https" && uri.Host == HostName;

        private void SaveReference(object sender, CoreWebView2DownloadStartingEventArgs args)
        {
            var deferral = args.GetDeferral();
            args.Handled = true;
            BeginInvoke((Action)(() =>
            {
                try
                {
                    if (!args.DownloadOperation.Uri.StartsWith("blob:https://" + HostName + "/", StringComparison.Ordinal))
                    {
                        args.Cancel = true;
                        return;
                    }
                    if (smokeProfile != null && !smokeExport)
                    {
                        smokeExport = true;
                        var operation = args.DownloadOperation;
                        args.ResultFilePath = Path.Combine(Path.GetFullPath(smokeProfile),
                            "native-" + Guid.NewGuid().ToString("N") + ".png");
                        operation.StateChanged += (_, __) =>
                        {
                            if (IsDisposed || operation.State == CoreWebView2DownloadState.InProgress) return;
                            if (operation.State == CoreWebView2DownloadState.Completed) Environment.ExitCode = 0;
                            BeginInvoke((Action)Close);
                        };
                        return;
                    }
                    using (var file = new SaveFileDialog { Filter = "PNG (*.png)|*.png", DefaultExt = "png",
                        AddExtension = true, FileName = "sai2-pose.png", Title = "导出透明 PNG" })
                    {
                        args.Cancel = file.ShowDialog(this) != DialogResult.OK;
                        if (!args.Cancel) args.ResultFilePath = file.FileName;
                    }
                }
                finally { deferral.Complete(); }
            }));
        }
    }
}
