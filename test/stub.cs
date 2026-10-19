// stub yt-dlp สำหรับทดสอบ: จำลอง output ของ yt-dlp จริงแล้วเขียนไฟล์ mp3 ปลอมที่ปลายทาง
// ใช้เฉพาะใน test/ เท่านั้น — ไม่เกี่ยวกับโปรแกรมหลัก
using System;
using System.IO;
using System.Threading;

class Stub {
    static void Main(string[] args) {
        foreach (string a in args) {
            if (a == "--version") { Console.WriteLine("2025.99.99-stub"); return; }
        }
        string url = null, outArg = null;
        for (int i = 0; i < args.Length; i++) {
            if (args[i] == "-o" && i + 1 < args.Length) outArg = args[i + 1];
        }
        url = args.Length > 0 ? args[args.Length - 1] : "https://unknown";
        if (url.StartsWith("-")) url = "https://unknown";
        string id = "stubvid" + Math.Abs(url.GetHashCode()).ToString();
        string title = "Stub Song " + id;
        string dir = "";
        string template = "%(title)s [%(id)s].%(ext)s";
        if (outArg != null) {
            dir = Path.GetDirectoryName(outArg);
            template = Path.GetFileName(outArg);
        }
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

        Console.WriteLine("[youtube] " + id + ": Downloading webpage");
        Console.WriteLine("[youtube] " + id + ": Downloading ios player API JSON");
        Console.WriteLine("[info] Downloading 1 format(s) of " + id);
        Console.WriteLine("[download] Destination: " + dir + "\\" + title + " [" + id + "].webm");

        for (int p = 0; p <= 100; p += 10) {
            Console.WriteLine("[download]  " + p + ".0% of    2.00MiB at    1.00MiB/s ETA 00:" + (10 - p / 10).ToString("D2"));
            Thread.Sleep(60);
        }
        string webm = Path.Combine(dir, title + " [" + id + "].webm");
        File.WriteAllText(webm, "fake audio data " + id);

        Console.WriteLine("[ExtractAudio] Destination: " + dir + "\\" + title + " [" + id + "].mp3");
        Thread.Sleep(300);
        string mp3 = Path.Combine(dir, title + " [" + id + "].mp3");
        File.WriteAllText(mp3, "fake mp3 " + id);

        Console.WriteLine("[download] " + title + " [" + id + "].webm has already been downloaded");
        Console.WriteLine("Deleting original file " + dir + "\\" + title + " [" + id + "].webm (pass -k to keep)");
    }
}
