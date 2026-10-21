[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ProxyScript,
    [string]$Rules,
    [ValidateRange(1, 65535)][int]$ProxyPort = 8002,
    [string]$RouterExe,
    [string]$NodeExe,
    [string]$WorkingDirectory,
    [switch]$Remove,
    [switch]$Plan
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Resolve-StartupFile([string]$Value) {
    if (-not $Value -or -not (Test-Path -LiteralPath $Value -PathType Leaf)) { throw "Required file not found: $Value" }
    return (Resolve-Path -LiteralPath $Value).ProviderPath
}
function Quote-TaskArgument([string]$Value) {
    if ($Value -match '["\r\n]') { throw 'Paths cannot contain quotes or line breaks.' }
    return '"' + $Value + '"'
}
function Write-StartupConfig([string]$Path, [string]$Content) {
    $temporary = Join-Path (Split-Path -Parent $Path) ([guid]::NewGuid().ToString() + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, $Content, [Text.UTF8Encoding]::new($false))
        # Windows PowerShell 5 converts $null to an empty string for this .NET
        # string parameter. NullString supplies a real null backup filename.
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$startupSid = $identity.User.Value
$marker = 'MT5Router login startup v1'
$proxyTaskName = "MT5Router-$startupSid-Proxy"
$routerTaskName = "MT5Router-$startupSid-Router"
$taskNames = @($proxyTaskName, $routerTaskName)
$existing = @{}
foreach ($name in $taskNames) {
    $task = Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction SilentlyContinue
    if ($null -ne $task) {
        if (-not $task.Description.StartsWith($marker)) { throw "Refusing to replace an unrelated task: $name" }
        $existing[$name] = Export-ScheduledTask -TaskName $name -TaskPath '\'
    }
}
if ($Remove) {
    if ($Plan) {
        @{ operation = 'Remove'; tasks = $taskNames; stopsRunningApplications = $false } | ConvertTo-Json -Depth 3
        return
    }
    foreach ($name in $taskNames) {
        if ($existing.ContainsKey($name) -and $PSCmdlet.ShouldProcess($name, 'Remove login startup task')) {
            Unregister-ScheduledTask -TaskName $name -TaskPath '\' -Confirm:$false
        }
    }
    Write-Output 'Login startup removed. Currently running applications were left running.'
    return
}
$ProxyScript = Resolve-StartupFile $ProxyScript
$Rules = Resolve-StartupFile $Rules
if (-not $RouterExe) { $RouterExe = Join-Path $PSScriptRoot 'MT5Router.exe' }
$RouterExe = Resolve-StartupFile $RouterExe
$runner = Resolve-StartupFile (Join-Path $PSScriptRoot 'Start-Proxy.ps1')
if (-not $NodeExe) { $NodeExe = (Get-Command node.exe -ErrorAction Stop).Source }
$NodeExe = Resolve-StartupFile $NodeExe
if (-not $WorkingDirectory) { $WorkingDirectory = Split-Path -Parent $Rules }
if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) { throw 'Proxy working directory was not found.' }
$WorkingDirectory = (Resolve-Path -LiteralPath $WorkingDirectory).ProviderPath
$startupDirectory = Join-Path $env:LOCALAPPDATA 'MT5Router\startup'
$startupConfigPath = Join-Path $startupDirectory 'proxy-startup.json'
$proxyConfig = @{ node = $NodeExe; script = $ProxyScript; rules = $Rules; port = $ProxyPort;
    workingDirectory = $WorkingDirectory; log = (Join-Path $startupDirectory 'proxy.log') } | ConvertTo-Json
$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$proxyArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ' +
    (Quote-TaskArgument $runner) + ' -StartupConfigPath ' + (Quote-TaskArgument $startupConfigPath)
$routerArguments = '--start --wait-proxy-until-ready --proxy-host 127.0.0.1 --proxy-port ' + $ProxyPort +
    ' --log-file ' + (Quote-TaskArgument (Join-Path $startupDirectory 'router.log'))
$planData = [ordered]@{ user = $identity.Name; trigger = 'AtLogOn'; proxyPort = $ProxyPort;
    configuration = $startupConfigPath; logDirectory = $startupDirectory;
    tasks = @(
        @{ name = $proxyTaskName; executable = $powerShellExe; arguments = $proxyArguments; workingDirectory = $WorkingDirectory; runLevel = 'Limited' },
        @{ name = $routerTaskName; executable = $RouterExe; arguments = $routerArguments; workingDirectory = (Split-Path -Parent $RouterExe); runLevel = 'Highest' }
    ) }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$definitions = @{}
foreach ($item in $planData.tasks) {
    $action = New-ScheduledTaskAction -Execute $item.executable -Argument $item.arguments -WorkingDirectory $item.workingDirectory
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $startupSid
    $trigger.Delay = if ($item.runLevel -eq 'Highest') { 'PT10S' } else { 'PT5S' }
    $principal = New-ScheduledTaskPrincipal -UserId $startupSid -LogonType Interactive -RunLevel $item.runLevel
    $definitions[$item.name] = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description "$marker - $($item.name)"
    $item.principalSid = $principal.UserId
    $item.logonType = $principal.LogonType
    $item.delay = $trigger.Delay
}
$planData.settings = @{ executionTimeLimit = $settings.ExecutionTimeLimit;
    multipleInstances = $settings.MultipleInstances; restartCount = $settings.RestartCount }
if ($Plan) { $planData | ConvertTo-Json -Depth 5; return }
if (-not $PSCmdlet.ShouldProcess($identity.Name, 'Install proxy and elevated MT5Router login startup tasks')) { return }
$administrator = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $administrator.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this installer once from PowerShell opened as administrator, using the same Windows account as MT5.'
}
$registered = @()
$previousConfig = if (Test-Path -LiteralPath $startupConfigPath) { [IO.File]::ReadAllText($startupConfigPath) } else { $null }
try {
    New-Item -ItemType Directory -Path $startupDirectory -Force | Out-Null
    Write-StartupConfig $startupConfigPath $proxyConfig
    foreach ($item in $planData.tasks) {
        Register-ScheduledTask -TaskName $item.name -TaskPath '\' -InputObject $definitions[$item.name] -Force | Out-Null
        $registered += $item.name
    }
} catch {
    $failure = $_
    foreach ($name in $registered) {
        try {
            if ($existing.ContainsKey($name)) { Register-ScheduledTask -TaskName $name -TaskPath '\' -Xml $existing[$name] -Force | Out-Null }
            else { Unregister-ScheduledTask -TaskName $name -TaskPath '\' -Confirm:$false }
        } catch {
            Write-Warning "Rollback failed for task ${name}: $($_.Exception.Message)" -WarningAction Continue
        }
    }
    try {
        if ($null -ne $previousConfig) { Write-StartupConfig $startupConfigPath $previousConfig }
        elseif (Test-Path -LiteralPath $startupConfigPath) { Remove-Item -LiteralPath $startupConfigPath }
    } catch {
        Write-Warning "Rollback failed for startup configuration: $($_.Exception.Message)" -WarningAction Continue
    }
    throw $failure
}
Write-Output "Installed login startup for $($identity.Name), proxy port $ProxyPort."
Write-Output 'The tasks will run at your next login. They have not been started by this installer.'
Write-Output "Logs: $startupDirectory"
