using System;
using System.IO;
using System.Windows.Forms;

namespace FilePicker {
    static class Program {
        [STAThread]
        static int Main(string[] args) {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            string mode = args.Length > 0 ? args[0] : "file";
            string title = args.Length > 1 ? args[1] : "Chọn file";
            string filter = args.Length > 2 ? args[2] : "All files (*.*)|*.*";
            string initialDir = args.Length > 3 ? args[3] : "";

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

            using (Form topForm = new Form()) {
                topForm.Size = new System.Drawing.Size(1, 1);
                topForm.StartPosition = FormStartPosition.Manual;
                topForm.Location = new System.Drawing.Point(-2000, -2000);
                topForm.ShowInTaskbar = false;
                topForm.TopMost = true;
                topForm.Show();
                topForm.BringToFront();

                if (mode == "folder") {
                    using (var d = new FolderBrowserDialog()) {
                        d.Description = title;
                        d.ShowNewFolderButton = true;
                        if (!string.IsNullOrEmpty(validDir)) d.SelectedPath = validDir;
                        if (d.ShowDialog(topForm) == DialogResult.OK) {
                            Console.Write(d.SelectedPath);
                            return 0;
                        }
                    }
                } else if (mode == "save") {
                    using (var d = new SaveFileDialog()) {
                        d.Title = title;
                        d.Filter = filter;
                        d.RestoreDirectory = true;
                        if (!string.IsNullOrEmpty(validDir)) d.InitialDirectory = validDir;
                        if (!string.IsNullOrEmpty(initialDir) && !Directory.Exists(initialDir)) {
                            d.FileName = Path.GetFileName(initialDir);
                        }
                        if (d.ShowDialog(topForm) == DialogResult.OK) {
                            Console.Write(d.FileName);
                            return 0;
                        }
                    }
                } else {
                    using (var d = new OpenFileDialog()) {
                        d.Title = title;
                        d.Filter = filter;
                        d.RestoreDirectory = true;
                        d.Multiselect = false;
                        if (!string.IsNullOrEmpty(validDir)) d.InitialDirectory = validDir;
                        if (d.ShowDialog(topForm) == DialogResult.OK) {
                            Console.Write(d.FileName);
                            return 0;
                        }
                    }
                }
            }
            return 1;
        }
    }
}
