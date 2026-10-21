param([Parameter(Mandatory = $true)][string]$StartupConfigPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-ProxyLog([string[]]$Messages) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $lines = [Text.StringBuilder]::new()
    foreach ($message in $Messages) { [void]$lines.AppendLine("$stamp $message") }
    if ((Test-Path -LiteralPath $proxyLog) -and (Get-Item -LiteralPath $proxyLog).Length -gt 2MB) {
        for ($index = 2; $index -ge 1; $index--) {
            $previous = "$proxyLog.$index"
            if (Test-Path -LiteralPath $previous) { Move-Item -LiteralPath $previous -Destination "$proxyLog.$($index + 1)" -Force }
        }
        Move-Item -LiteralPath $proxyLog -Destination "$proxyLog.1" -Force
    }
    [IO.File]::AppendAllText($proxyLog, $lines.ToString(), [Text.UTF8Encoding]::new($false))
}
function Quote-NativePath([string]$Value) {
    if ($Value -match '["\r\n]') { throw 'Invalid path in startup configuration.' }
    return '"' + $Value + '"'
}

$proxyProcess = $null
$startup = Get-Content -LiteralPath $StartupConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$proxyLog = [string]$startup.log
try {
    foreach ($file in @($startup.node, $startup.script, $startup.rules)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Startup file is missing: $file" }
    }
    if (-not (Test-Path -LiteralPath $startup.workingDirectory -PathType Container)) { throw 'Proxy working directory is missing.' }
    if ([int]$startup.port -lt 1 -or [int]$startup.port -gt 65535) { throw 'Invalid proxy port.' }
    # Join the job BEFORE starting Node, so even an immediate hard termination
    # cannot leave a child outside supervision. Children inherit job membership.
    # The non-inheritable job handle lives until this PowerShell process exits.
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ProxyLifetime {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long PerProcessTime, PerJobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static IntPtr lifetimeJob;
    public static void Initialize() {
        if (lifetimeJob != IntPtr.Zero) return;
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!AssignProcessToJobObject(job, GetCurrentProcess()))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            lifetimeJob = job;
        } catch { CloseHandle(job); throw; }
        // Intentionally keep this raw handle open: closing it kills this process
        // as well as Node. Windows closes it on normal exit or TerminateProcess.
    }
}
'@
    [ProxyLifetime]::Initialize()
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $startup.node
    $info.Arguments = (Quote-NativePath $startup.script) + ' --host 127.0.0.1 --port ' + [int]$startup.port +
        ' --rules ' + (Quote-NativePath $startup.rules) + ' --add-default-passthrough --log-level info'
    $info.WorkingDirectory = $startup.workingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $proxyProcess = [Diagnostics.Process]::Start($info)
    Write-ProxyLog "Proxy started as PID $($proxyProcess.Id), port $($startup.port)."
    $outputRead = $proxyProcess.StandardOutput.ReadLineAsync()
    $errorRead = $proxyProcess.StandardError.ReadLineAsync()
    # Read both pipes concurrently; waiting for one pipe alone can deadlock Node.
    while ($null -ne $outputRead -or $null -ne $errorRead) {
        $batch = [Collections.Generic.List[string]]::new()
        # Bound each stream's batch so sustained stdout cannot starve stderr.
        for ($count = 0; $count -lt 256 -and $null -ne $outputRead -and $outputRead.IsCompleted; $count++) {
            $line = $outputRead.GetAwaiter().GetResult()
            if ($null -eq $line) { $outputRead = $null }
            else { $batch.Add($line); $outputRead = $proxyProcess.StandardOutput.ReadLineAsync() }
        }
        for ($count = 0; $count -lt 256 -and $null -ne $errorRead -and $errorRead.IsCompleted; $count++) {
            $line = $errorRead.GetAwaiter().GetResult()
            if ($null -eq $line) { $errorRead = $null }
            else { $batch.Add("ERROR $line"); $errorRead = $proxyProcess.StandardError.ReadLineAsync() }
        }
        if ($batch.Count) { Write-ProxyLog $batch.ToArray() }
        elseif ($null -ne $outputRead -or $null -ne $errorRead) { Start-Sleep -Milliseconds 25 }
    }
    $proxyProcess.WaitForExit()
    $proxyExit = $proxyProcess.ExitCode
    Write-ProxyLog "Proxy exited with code $proxyExit."
} catch {
    Write-ProxyLog "Startup failed: $($_.Exception.Message)"
    $proxyExit = 1
} finally {
    if ($null -ne $proxyProcess) {
        if (-not $proxyProcess.HasExited) { $proxyProcess.Kill(); $proxyProcess.WaitForExit() }
        $proxyProcess.Dispose()
    }
}
exit $proxyExit
