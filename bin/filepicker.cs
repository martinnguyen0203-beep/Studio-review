using System;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace FilePicker {
    static class Program {
        [STAThread]
        static int Main(string[] args) {
            try {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                string mode = args.Length > 0 ? args[0] : "file";
                string title = args.Length > 1 ? args[1] : "Chọn file";
                string filter = args.Length > 2 ? args[2] : "All files (*.*)|*.*";
                string initialDir = args.Length > 3 ? args[3] : "";
                string outPath = args.Length > 4 ? args[4] : "";

                string safeFilter = "All files (*.*)|*.*";
                if (!string.IsNullOrEmpty(filter) && filter.Contains("|")) {
                    string[] parts = filter.Split('|');
                    if (parts.Length >= 2 && parts.Length % 2 == 0) {
                        safeFilter = filter;
                    }
                }

                string validDir = "";
                if (!string.IsNullOrEmpty(initialDir)) {
                    try {
                        if (Directory.Exists(initialDir)) {
                            validDir = initialDir;
                        } else if (File.Exists(initialDir)) {
                            validDir = Path.GetDirectoryName(initialDir);
                        } else {
                            string parent = Path.GetDirectoryName(initialDir);
                            if (!string.IsNullOrEmpty(parent) && Directory.Exists(parent)) {
                                validDir = parent;
                            }
                        }
                    } catch { }
                }

                string result = "";

                using (Form top = new Form()) {
                    top.Size = new System.Drawing.Size(0, 0);
                    top.StartPosition = FormStartPosition.Manual;
                    top.Location = new System.Drawing.Point(-2000, -2000);
                    top.ShowInTaskbar = false;
                    top.TopMost = true;
                    top.Show();
                    top.BringToFront();
                    top.Activate();

                    if (mode == "folder") {
                        using (var d = new FolderBrowserDialog()) {
                            d.Description = title;
                            d.ShowNewFolderButton = true;
                            if (!string.IsNullOrEmpty(validDir)) d.SelectedPath = validDir;
                            if (d.ShowDialog(top) == DialogResult.OK) {
                                result = d.SelectedPath;
                            }
                        }
                    } else if (mode == "save") {
                        using (var d = new SaveFileDialog()) {
                            d.Title = title;
                            d.Filter = safeFilter;
                            d.RestoreDirectory = true;
                            if (!string.IsNullOrEmpty(validDir)) d.InitialDirectory = validDir;
                            if (!string.IsNullOrEmpty(initialDir) && !Directory.Exists(initialDir)) {
                                d.FileName = Path.GetFileName(initialDir);
                            }
                            if (d.ShowDialog(top) == DialogResult.OK) {
                                result = d.FileName;
                            }
                        }
                    } else {
                        using (var d = new OpenFileDialog()) {
                            d.Title = title;
                            d.Filter = safeFilter;
                            d.RestoreDirectory = true;
                            d.Multiselect = false;
                            if (!string.IsNullOrEmpty(validDir)) d.InitialDirectory = validDir;
                            if (d.ShowDialog(top) == DialogResult.OK) {
                                result = d.FileName;
                            }
                        }
                    }
                    top.Close();
                }

                if (!string.IsNullOrEmpty(result)) {
                    if (!string.IsNullOrEmpty(outPath)) {
                        try {
                            File.WriteAllText(outPath, result, Encoding.UTF8);
                        } catch { }
                    }
                    try {
                        Console.WriteLine(result);
                    } catch { }
                    return 0;
                }
                return 1;
            } catch (Exception ex) {
                try {
                    File.WriteAllText("D:\\10 Obsidian\\4 Code\\picker_err.log", ex.ToString());
                } catch { }
                return 2;
            }
        }
    }
}
