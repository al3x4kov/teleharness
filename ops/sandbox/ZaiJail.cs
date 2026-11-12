// zai-jail — запускает команду внутри Windows AppContainer тенанта (FEAT-04.9, 2026-11-04).
//
//   zai-jail.exe --name zai-t-<tenant> --dir <папка тенанта> [--cwd <папка внутри --dir>]
//                [--net] [--cafile <cacert.pem>] [--path-prepend <dir>] --b64 <командная строка>
//
// --b64: base64 (или base64url без '=') UTF-8 командной строки процесса, например
//        `cmd.exe /d /s /c "python x.py"`. Строка уходит в CreateProcess как есть.
// Контейнер: свой SID (Modify — только на --dir), loopback и LAN закрыты; --net даёт
// capability internetClient. Окружение — короткий allowlist без секретов (TEMP, HOME,
// APPDATA — внутри --dir). Дети живут в job object (KILL_ON_JOB_CLOSE): смерть
// запускателя (таймаут opencode) убивает всё дерево команды.
//
// Коды выхода: код команды; 2 — неверные аргументы; 125 — ошибка подготовки
// контейнера; 126 — команду не удалось запустить.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;

static class ZaiJail {
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, int capCount, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSid(string s, out IntPtr sid);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSidToStringSid(IntPtr sid, out string s);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr val, IntPtr size, IntPtr prev, IntPtr retSize);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);

  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint tid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("advapi32.dll", SetLastError = true)] static extern uint GetSecurityInfo(IntPtr h, int type, uint info, IntPtr o, IntPtr g, out IntPtr dacl, IntPtr sacl, out IntPtr sd);
  [DllImport("advapi32.dll", SetLastError = true)] static extern uint SetSecurityInfo(IntPtr h, int type, uint info, IntPtr o, IntPtr g, IntPtr dacl, IntPtr sacl);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint SetEntriesInAcl(int count, ref EXPLICIT_ACCESS ea, IntPtr oldAcl, out IntPtr newAcl);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct TRUSTEE { public IntPtr pMultiple; public int op; public int form; public int type; public IntPtr name; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct EXPLICIT_ACCESS { public uint perms; public int mode; public uint inherit; public TRUSTEE trustee; }
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int cb; public string r; public string d; public string t; public int x, y, w, h, cx, cy, fill, flags; public short show, r2; public IntPtr r3, hIn, hOut, hErr; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO si; public IntPtr attrs; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long a, b; public uint LimitFlags; public UIntPtr c, d; public uint e; public UIntPtr f; public uint g, h; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION basic; public IO_COUNTERS io; public UIntPtr a, b, c, d; }

  const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000, CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_NO_WINDOW = 0x08000000;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = (IntPtr)0x20009;
  static readonly Regex NAME = new Regex("^zai-t-[A-Za-z0-9_-]{1,40}$");
  // Переменные окружения, которые получает команда. Всё прочее (токены, ключи,
  // OPENCODE_*, ZAI_*, профиль владельца) в контейнер не попадает.
  static readonly string[] ENV_KEEP = { "SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "OS",
    "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION",
    "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "ProgramData", "TZ" };

  class UsageError : Exception { public UsageError(string m) : base(m) { } }

  static void GrantUserObject(IntPtr h, IntPtr sid, uint rights) {
    // user32/oleaut32 DllMain needs the window station + desktop: grant them to the container SID (as Chromium does).
    IntPtr dacl, sd; if (GetSecurityInfo(h, 7 /*SE_WINDOW_OBJECT*/, 4 /*DACL*/, IntPtr.Zero, IntPtr.Zero, out dacl, IntPtr.Zero, out sd) != 0) return;
    var ea = new EXPLICIT_ACCESS { perms = rights, mode = 1 /*GRANT*/, inherit = 0, trustee = new TRUSTEE { form = 0 /*SID*/, type = 0, name = sid } };
    IntPtr nd; if (SetEntriesInAcl(1, ref ea, dacl, out nd) == 0) SetSecurityInfo(h, 7, 4, IntPtr.Zero, IntPtr.Zero, nd, IntPtr.Zero);
  }

  static readonly HashSet<string> FLAGS = new HashSet<string> { "--net" };
  static readonly HashSet<string> OPTS = new HashSet<string> { "--name", "--dir", "--cwd", "--cafile", "--path-prepend", "--b64" };

  static Dictionary<string, string> Parse(string[] a) {
    var o = new Dictionary<string, string>();
    for (int i = 0; i < a.Length; i++) {
      if (FLAGS.Contains(a[i])) { o[a[i]] = "1"; continue; }
      if (!OPTS.Contains(a[i])) throw new UsageError("неизвестный аргумент: " + a[i]);
      if (i + 1 >= a.Length) throw new UsageError("нет значения у " + a[i]);
      if (o.ContainsKey(a[i])) throw new UsageError("аргумент повторён: " + a[i]);
      o[a[i]] = a[++i];
    }
    return o;
  }

  static string Full(string p) { return Path.GetFullPath(p).TrimEnd('\\', '/'); }
  static bool Within(string p, string root) {
    return string.Equals(p, root, StringComparison.OrdinalIgnoreCase) || p.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase);
  }

  static string DecodeB64(string s) {
    s = s.Replace('-', '+').Replace('_', '/');
    switch (s.Length % 4) { case 2: s += "=="; break; case 3: s += "="; break; case 1: throw new UsageError("--b64: некорректный base64"); }
    try { return Encoding.UTF8.GetString(Convert.FromBase64String(s)); }
    catch (FormatException) { throw new UsageError("--b64: некорректный base64"); }
  }

  static int Main(string[] args) {
    // stderr — UTF-8 без BOM: opencode читает вывод как UTF-8, OEM-кодировка консоли превратила бы русский в мусор.
    Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
    string stage = "аргументы";
    try {
      var o = Parse(args);
      string name, dirArg, b64;
      if (!o.TryGetValue("--name", out name) || !o.TryGetValue("--dir", out dirArg) || !o.TryGetValue("--b64", out b64))
        throw new UsageError("нужны --name, --dir и --b64");
      if (!NAME.IsMatch(name)) throw new UsageError("имя контейнера должно соответствовать ^zai-t-[A-Za-z0-9_-]{1,40}$: " + name);
      string dir = Full(dirArg);
      if (!Path.IsPathRooted(dirArg) || !Directory.Exists(dir)) throw new UsageError("--dir: нет такой папки: " + dirArg);
      if (dir.Length <= 3) throw new UsageError("--dir: корень диска нельзя: " + dirArg);
      string cwd = dir;
      string cwdArg; if (o.TryGetValue("--cwd", out cwdArg)) {
        cwd = Full(Path.IsPathRooted(cwdArg) ? cwdArg : Path.Combine(dir, cwdArg));
        if (!Within(cwd, dir)) throw new UsageError("--cwd вне папки тенанта: " + cwdArg);
        if (!Directory.Exists(cwd)) throw new UsageError("--cwd: нет такой папки: " + cwdArg);
      }
      string cmdline = DecodeB64(b64);
      if (cmdline.Trim().Length == 0) throw new UsageError("пустая команда");
      if (cmdline.IndexOf('\0') >= 0) throw new UsageError("в команде символ NUL");
      string cafile = null; if (o.TryGetValue("--cafile", out cafile)) cafile = Full(cafile);
      string prepend = null; if (o.TryGetValue("--path-prepend", out prepend)) prepend = Full(prepend);
      bool net = o.ContainsKey("--net");

      stage = "AppContainer";
      IntPtr acSid;
      int hr = CreateAppContainerProfile(name, name, "zai tenant sandbox", IntPtr.Zero, 0, out acSid);
      if (hr != 0) { int hr2 = DeriveAppContainerSidFromAppContainerName(name, out acSid); if (hr2 != 0) throw new Exception("SID контейнера: 0x" + hr.ToString("x") + "/0x" + hr2.ToString("x")); }
      string acSidStr; if (!ConvertSidToStringSid(acSid, out acSidStr)) throw new Win32Exception();

      stage = "ACL папки тенанта";
      var di = new DirectoryInfo(dir); var acl = di.GetAccessControl();
      acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(acSidStr), FileSystemRights.Modify, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      di.SetAccessControl(acl); // идемпотентно: одинаковое правило сливается
      GrantUserObject(GetProcessWindowStation(), acSid, 0x0237 /*WINSTA read+access*/);
      GrantUserObject(GetThreadDesktop(GetCurrentThreadId()), acSid, 0x01CF /*DESKTOP read+write objects*/);
      // CreateProcess для AppContainer сам переписывает LOCALAPPDATA/TEMP/TMP в
      // %LOCALAPPDATA%\Packages\<имя>\AC[\Temp]; эти папки должны существовать.
      string appdata = Path.Combine(dir, ".appdata");
      string tmp = Path.Combine(appdata, "Packages", name, "AC", "Temp");
      Directory.CreateDirectory(tmp);

      stage = "атрибуты процесса";
      IntPtr capsPtr = IntPtr.Zero; uint capCount = 0;
      if (net) {
        IntPtr inet; if (!ConvertStringSidToSid("S-1-15-3-1", out inet)) throw new Win32Exception(); // internetClient
        var cap = new SID_AND_ATTRIBUTES { Sid = inet, Attributes = 4 /*SE_GROUP_ENABLED*/ };
        capsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)));
        Marshal.StructureToPtr(cap, capsPtr, false); capCount = 1;
      }
      var sc = new SECURITY_CAPABILITIES { AppContainerSid = acSid, Capabilities = capsPtr, CapabilityCount = capCount };
      IntPtr scPtr = Marshal.AllocHGlobal(Marshal.SizeOf(sc)); Marshal.StructureToPtr(sc, scPtr, false);
      IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      IntPtr list = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Win32Exception();
      if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, scPtr, (IntPtr)Marshal.SizeOf(sc), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();

      stage = "окружение";
      var vars = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      foreach (var k in ENV_KEEP) { var v = Environment.GetEnvironmentVariable(k); if (!string.IsNullOrEmpty(v)) vars[k] = v; }
      string sysRoot = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
      vars["PATH"] = (prepend != null ? prepend + ";" : "") + sysRoot + @"\System32;" + sysRoot + ";" + sysRoot + @"\System32\Wbem";
      vars["TEMP"] = tmp; vars["TMP"] = tmp;
      vars["USERPROFILE"] = dir; vars["HOME"] = dir;
      vars["APPDATA"] = appdata; vars["LOCALAPPDATA"] = appdata;
      vars["MPLCONFIGDIR"] = Path.Combine(appdata, "matplotlib");
      vars["PYTHONUTF8"] = "1"; vars["PYTHONIOENCODING"] = "utf-8"; vars["PYTHONDONTWRITEBYTECODE"] = "1";
      // TLS-корни — certifi: хранилище сертификатов Windows из AppContainer недоступно.
      if (cafile != null) { vars["SSL_CERT_FILE"] = cafile; vars["REQUESTS_CA_BUNDLE"] = cafile; vars["CURL_CA_BUNDLE"] = cafile; }
      var env = new StringBuilder();
      foreach (var kv in vars) env.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
      env.Append('\0');
      IntPtr envPtr = Marshal.StringToHGlobalUni(env.ToString());

      stage = "запуск команды";
      var si = new STARTUPINFOEX(); si.si.cb = Marshal.SizeOf(si); si.attrs = list;
      si.si.flags = 0x100 /*STARTF_USESTDHANDLES*/; si.si.hIn = GetStdHandle(-10); si.si.hOut = GetStdHandle(-11); si.si.hErr = GetStdHandle(-12);
      // Job создаётся до процесса: процесс стартует приостановленным и попадает в job до первой инструкции.
      IntPtr job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception();
      var lim = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); lim.basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref lim, Marshal.SizeOf(lim))) throw new Win32Exception();
      PROCESS_INFORMATION pi;
      if (!CreateProcess(null, new StringBuilder(cmdline), IntPtr.Zero, IntPtr.Zero, true, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, envPtr, cwd, ref si, out pi)) {
        var e = new Win32Exception();
        Console.Error.WriteLine("zai-jail: команду не удалось запустить: " + e.Message);
        return 126;
      }
      if (!AssignProcessToJobObject(job, pi.hProcess)) { var e = new Win32Exception(); TerminateProcess(pi.hProcess, 125); throw e; }
      ResumeThread(pi.hThread);
      WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
      uint code; GetExitCodeProcess(pi.hProcess, out code);
      return (int)code;
    } catch (UsageError e) {
      Console.Error.WriteLine("zai-jail: " + e.Message);
      Console.Error.WriteLine("usage: zai-jail --name zai-t-<tenant> --dir <папка> [--cwd <папка внутри --dir>] [--net] [--cafile <pem>] [--path-prepend <dir>] --b64 <base64 командной строки>");
      return 2;
    } catch (Exception e) {
      Console.Error.WriteLine("zai-jail: ошибка (" + stage + "): " + e.Message);
      return 125;
    }
  }
}
