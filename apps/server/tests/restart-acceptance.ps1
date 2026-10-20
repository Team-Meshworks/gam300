#Requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $ExpectedVolume,
    [string] $ContainerMetadataPath = '.artifacts/scrum45-postgres-container.json',
    [string] $ConnectionPath = '.artifacts/scrum45-postgres-connection.txt',
    [string] $DockerPath = "$env:LOCALAPPDATA/Programs/DeveloperCLIs/docker.exe",
    [string] $DotnetPath = "$env:ProgramFiles/dotnet/dotnet.exe"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$serverRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([IO.Path]::GetFullPath((Get-Location).Path) -ne $serverRoot) { throw 'Run this acceptance from apps/server.' }
$imageDigest = 'postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336'
if ($ExpectedVolume -notmatch '^[a-f0-9]{64}$') { throw 'Supply the recorded owned anonymous volume name.' }
$ContainerMetadataPath = [IO.Path]::GetFullPath($ContainerMetadataPath)
$ConnectionPath = [IO.Path]::GetFullPath($ConnectionPath)
$metadata = Get-Content -LiteralPath $ContainerMetadataPath -Raw | ConvertFrom-Json
$containerId = [string]$metadata.containerId
$containerName = [string]$metadata.containerName
if ($containerId -notmatch '^[a-f0-9]{64}$' -or $containerName -notmatch '^spatia-scrum45-postgres-[a-f0-9]{12,32}$' -or
    $metadata.host -ne '127.0.0.1' -or $metadata.database -ne 'spatia_scrum45_test' -or
    $metadata.username -ne 'spatia_test' -or $metadata.imageDigest -ne $imageDigest) {
    throw 'The ownership record is not the retained SCRUM-45 target.'
}
$baseConnection = [Data.Common.DbConnectionStringBuilder]::new()
$baseConnection.set_ConnectionString([IO.File]::ReadAllText($ConnectionPath).Trim())
if ($baseConnection['Host'] -ne '127.0.0.1' -or $baseConnection['Database'] -ne 'spatia_scrum45_test' -or
    $baseConnection['Username'] -ne 'spatia_test' -or [string]::IsNullOrWhiteSpace($baseConnection['Password'])) {
    throw 'The private connection must identify the exact loopback SCRUM-45 test database.'
}
$assembly = Join-Path $serverRoot 'Spatia.Server/bin/Release/net10.0/Spatia.Server.dll'
foreach ($required in @($DockerPath, $DotnetPath, $assembly, (Join-Path $PSScriptRoot 'restart-browser.check.mjs'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'A required prebuilt executable or acceptance file is missing.' }
}
if ($metadata.PSObject.Properties.Name -contains 'expectedVolume' -and $metadata.expectedVolume -ne $ExpectedVolume) { throw 'Recorded owned volume mismatch.' }
$runId = [Guid]::NewGuid().ToString('N')
$schema = 'spatia_scrum45_' + $runId
$adminName = 'restart-admin-' + $runId
$artifactsRoot = [IO.Path]::GetFullPath((Join-Path $serverRoot '.artifacts'))
$ownedDirectory = Join-Path $artifactsRoot ('restart-' + $runId)
$resultPath = Join-Path $artifactsRoot ('restart-acceptance-' + $runId + '.json')
$children = [Collections.Generic.List[object]]::new()
$schemaCreated = $false
$directoryCreated = $false
$certificate = $null
$stage = 'ownership validation'
$failure = $null
$cleanupFailures = [Collections.Generic.List[string]]::new()
$browserLines = [Collections.Generic.List[string]]::new()
$initialPid = $null
$restartedPid = $null
$postgresVersion = $null
$retainedPids = [Collections.Generic.List[int]]::new()
$allChildrenConfirmedStopped = $true
$startedAt = [DateTimeOffset]::UtcNow
$secrets = @([string]$baseConnection['Password'], 'Synthetic restart administrator password 1!',
    'Synthetic restart administrator password 2!', 'Synthetic restart creator password 3!',
    'Synthetic restart creator password 4!')

function Start-OwnedChild([string] $Executable, [string[]] $Arguments, [hashtable] $Configuration = @{}, [switch] $ReadLines) {
    $start = [Diagnostics.ProcessStartInfo]::new($Executable)
    $start.WorkingDirectory = $serverRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($key in @($start.Environment.Keys)) {
        if ($key -match '^(ConnectionStrings__|DataProtection__|Kestrel__|ASPNETCORE_|SPATIA_|DOTNET_ENVIRONMENT$|AllowedHosts$|TrustedProxies__)') { [void]$start.Environment.Remove($key) }
    }
    foreach ($key in $Configuration.Keys) { $start.Environment[$key] = $Configuration[$key] }
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::Start($start)
    $child = [pscustomobject]@{ Process = $process; Output = $null; Error = $process.StandardError.ReadToEndAsync(); Pending = $null }
    if (-not $ReadLines) { $child.Output = $process.StandardOutput.ReadToEndAsync() }
    $children.Add($child)
    return $child
}

function Stop-OwnedChild($Child) {
    try {
        if (-not $Child.Process.HasExited) { $Child.Process.Kill($true) }
        if (-not $Child.Process.WaitForExit(10000)) { throw 'An owned child did not exit after termination.' }
    }
    catch {
        if (-not $Child.Process.HasExited) {
            $script:allChildrenConfirmedStopped = $false
            if (-not $retainedPids.Contains($Child.Process.Id)) { $retainedPids.Add($Child.Process.Id) }
        }
        throw
    }
    try {
        if ($null -ne $Child.Pending) {
            [void]$Child.Pending.WaitAsync([TimeSpan]::FromSeconds(10)).GetAwaiter().GetResult()
            $Child.Pending = $null
        }
        if ($null -eq $Child.Output) { $Child.Output = $Child.Process.StandardOutput.ReadToEndAsync() }
        $output = $Child.Output.WaitAsync([TimeSpan]::FromSeconds(10)).GetAwaiter().GetResult()
        $errorOutput = $Child.Error.WaitAsync([TimeSpan]::FromSeconds(10)).GetAwaiter().GetResult()
    }
    catch {
        $script:allChildrenConfirmedStopped = $false
        if (-not $retainedPids.Contains($Child.Process.Id)) { $retainedPids.Add($Child.Process.Id) }
        throw 'An owned child output did not drain within its time budget.'
    }
    foreach ($secret in $secrets) {
        if ($output.Contains($secret, [StringComparison]::Ordinal) -or $errorOutput.Contains($secret, [StringComparison]::Ordinal)) {
            throw 'An owned child output contained a credential sentinel.'
        }
    }
}

function Invoke-Captured([string] $Executable, [string[]] $Arguments, [hashtable] $Configuration = @{}, [string] $InputText = '', [int] $Seconds = 30) {
    $child = Start-OwnedChild $Executable $Arguments $Configuration
    try {
        if ($InputText.Length -gt 0) { $child.Process.StandardInput.Write($InputText) }
        $child.Process.StandardInput.Close()
        if (-not $child.Process.WaitForExit($Seconds * 1000)) { throw 'An owned command exceeded its time budget.' }
        Stop-OwnedChild $child
        return [pscustomobject]@{ ExitCode = $child.Process.ExitCode; Output = $child.Output.WaitAsync([TimeSpan]::FromSeconds(10)).GetAwaiter().GetResult() }
    }
    finally {
        try { Stop-OwnedChild $child }
        finally {
            if ($child.Process.HasExited) { [void]$children.Remove($child); $child.Process.Dispose() }
        }
    }
}

function Get-OwnedTarget {
    $format = '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"ConfiguredImage":{{json .Config.Image}},"Labels":{{json .Config.Labels}},"Mounts":{{json .Mounts}},"Bindings":{{json .HostConfig.PortBindings}},"Ports":{{json .NetworkSettings.Ports}},"Running":{{json .State.Running}}}'
    $inspection = Invoke-Captured $DockerPath @('inspect', '--format', $format, $containerId)
    if ($inspection.ExitCode -ne 0) { throw 'Cannot inspect the exact retained container; start Docker Desktop separately if required.' }
    $target = $inspection.Output | ConvertFrom-Json -Depth 20
    if ($target.Id -ne $containerId -or $target.Name -ne ('/' + $containerName) -or $target.ConfiguredImage -ne 'postgres:18.6' -or
        $target.Labels.'spatia.task' -ne 'SCRUM-45' -or $target.Labels.'spatia.disposable' -ne 'true') { throw 'Container ownership mismatch.' }
    $mounts = @($target.Mounts)
    if ($mounts.Count -ne 1 -or $mounts[0].Type -ne 'volume' -or $mounts[0].Name -ne $ExpectedVolume -or
        $mounts[0].Destination -ne '/var/lib/postgresql' -or -not $mounts[0].RW) { throw 'Owned anonymous storage mismatch.' }
    $bindings = @($target.Bindings.PSObject.Properties)
    if ($bindings.Count -ne 1 -or $bindings[0].Name -ne '5432/tcp' -or @($bindings[0].Value).Count -ne 1 -or
        $bindings[0].Value[0].HostIp -ne '127.0.0.1') { throw 'Container must publish only loopback PostgreSQL.' }
    $image = Invoke-Captured $DockerPath @('image', 'inspect', '--format', '{{json .RepoDigests}}', $target.Image)
    if ($image.ExitCode -ne 0 -or $imageDigest -notin @($image.Output | ConvertFrom-Json)) { throw 'Official image digest mismatch.' }
    return $target
}

function Wait-OwnedPostgres {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(45)
    do {
        $ready = Invoke-Captured $DockerPath @('exec', $containerId, 'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'spatia_test', '-d', 'spatia_scrum45_test') -Seconds 5
        if ($ready.ExitCode -eq 0) {
            $target = Get-OwnedTarget
            $ports = @($target.Ports.'5432/tcp')
            if (-not $target.Running -or $ports.Count -ne 1 -or $ports[0].HostIp -ne '127.0.0.1' -or
                [int]$ports[0].HostPort -lt 1 -or [int]$ports[0].HostPort -gt 65535) { throw 'Invalid active loopback mapping.' }
            $baseConnection['Port'] = [int]$ports[0].HostPort
            [IO.File]::WriteAllText($ConnectionPath, $baseConnection.get_ConnectionString())
            $metadata.port = [int]$ports[0].HostPort
            $metadata | Add-Member -NotePropertyName expectedVolume -NotePropertyValue $ExpectedVolume -Force
            [IO.File]::WriteAllText($ContainerMetadataPath, ($metadata | ConvertTo-Json))
            $database = Invoke-Captured $DockerPath @('exec', $containerId, 'psql', '-X', '-U', 'spatia_test', '-d', 'spatia_scrum45_test', '-At', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT current_database() || ''|'' || version()')
            $identityParts = $database.Output.Trim() -split '\|', 2
            if ($database.ExitCode -ne 0 -or $identityParts.Count -ne 2 -or $identityParts[0] -ne 'spatia_scrum45_test' -or
                $identityParts[1] -notmatch '^PostgreSQL 18\.6\b') { throw 'Current database identity or version mismatch.' }
            $script:postgresVersion = $identityParts[1]
            return
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw 'Owned PostgreSQL did not become TCP-ready within 45 seconds.'
}

function Invoke-OwnedSql([string] $Sql) {
    [void](Get-OwnedTarget)
    $result = Invoke-Captured $DockerPath @('exec', $containerId, 'psql', '-X', '-U', 'spatia_test', '-d', 'spatia_scrum45_test', '-At', '-v', 'ON_ERROR_STOP=1', '-c', $Sql)
    if ($result.ExitCode -ne 0) { throw 'Owned-schema SQL did not complete.' }
    return $result.Output.Trim()
}

function Read-BrowserLine($Browser, [int] $Seconds) {
    $Browser.Pending = $Browser.Process.StandardOutput.ReadLineAsync()
    if (-not $Browser.Pending.Wait($Seconds * 1000)) { throw 'Browser checkpoint exceeded its time budget.' }
    $line = $Browser.Pending.GetAwaiter().GetResult()
    $Browser.Pending = $null
    if ($null -eq $line) { throw 'Browser exited before its expected checkpoint.' }
    if ($line -ne 'restart-ready' -and $line -notin @('restart retained session passed', 'restart fresh browser lifecycle passed', 'restart password durability passed') -and
        $line -notmatch '^node v[0-9.]+; playwright [0-9.]+; chromium [0-9.]+$') { throw 'Browser emitted unexpected output.' }
    $browserLines.Add($line)
    return $line
}

function Start-Api([hashtable] $Configuration) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { $port = $listener.LocalEndpoint.Port } finally { $listener.Stop() }
    $Configuration['Kestrel__Endpoints__Https__Url'] = 'https://127.0.0.1:' + $port
    $api = Start-OwnedChild $DotnetPath @($assembly) $Configuration
    $api.Process.StandardInput.Close()
    $origin = 'https://127.0.0.1:' + $port
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.ServerCertificateCustomValidationCallback = [Net.Http.HttpClientHandler]::DangerousAcceptAnyServerCertificateValidator
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(2)
    try {
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds(20)
        do {
            if ($api.Process.HasExited) { throw 'The production API exited during startup.' }
            try {
                $response = $client.GetAsync($origin + '/api/auth/csrf').GetAwaiter().GetResult()
                try { if ($response.IsSuccessStatusCode) { return [pscustomobject]@{ Child = $api; Origin = $origin } } }
                finally { $response.Dispose() }
            }
            catch [Net.Http.HttpRequestException] { }
            catch [Threading.Tasks.TaskCanceledException] { }
            Start-Sleep -Milliseconds 100
        } while ([DateTimeOffset]::UtcNow -lt $deadline)
        throw 'Production HTTPS startup exceeded 20 seconds.'
    }
    finally { $client.Dispose() }
}

try {
    $target = Get-OwnedTarget
    if (-not $target.Running) {
        [void](Get-OwnedTarget)
        $startResult = Invoke-Captured $DockerPath @('start', $containerId)
        if ($startResult.ExitCode -ne 0) { throw 'The owned container could not start.' }
    }
    Wait-OwnedPostgres
    $stage = 'owned schema migration'
    $existingSchema = Invoke-OwnedSql ("SELECT count(*) FROM pg_namespace WHERE nspname = '" + $schema + "'")
    if ($existingSchema -ne '0') { throw 'The generated schema already exists; refusing to take ownership.' }
    $schemaCreated = $true
    [void](Invoke-OwnedSql ('CREATE SCHEMA "' + $schema + '"'))
    if (Test-Path -LiteralPath $ownedDirectory) { throw 'The generated temporary directory already exists.' }
    [void][IO.Directory]::CreateDirectory($ownedDirectory)
    $directoryCreated = $true
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = Get-Acl -LiteralPath $ownedDirectory
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($identity)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $ownedDirectory -AclObject $acl
    $keyDirectory = Join-Path $ownedDirectory 'keys'
    [void][IO.Directory]::CreateDirectory($keyDirectory)
    $certificatePassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
    $secrets += $certificatePassword
    $rsa = [Security.Cryptography.RSA]::Create(2048)
    try {
        $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Spatia restart acceptance', $rsa,
            [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $names = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
        $names.AddIpAddress([Net.IPAddress]::Loopback)
        $request.CertificateExtensions.Add($names.Build())
        $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1), [DateTimeOffset]::UtcNow.AddHours(1))
        $certificatePath = Join-Path $ownedDirectory 'https.pfx'
        [IO.File]::WriteAllBytes($certificatePath, $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pkcs12, $certificatePassword))
    }
    finally { $rsa.Dispose() }
    $scopedConnection = [Data.Common.DbConnectionStringBuilder]::new()
    $scopedConnection.set_ConnectionString($baseConnection.get_ConnectionString())
    $scopedConnection['Search Path'] = $schema
    $scopedConnection['Pooling'] = $false
    $configuration = @{
        'ConnectionStrings__Spatia' = $scopedConnection.get_ConnectionString()
        'DataProtection__KeyDirectory' = $keyDirectory
        'AllowedHosts' = '127.0.0.1'
        'ASPNETCORE_ENVIRONMENT' = 'Testing'
        'DOTNET_ENVIRONMENT' = 'Testing'
        'Kestrel__Certificates__Default__Path' = $certificatePath
        'Kestrel__Certificates__Default__Password' = $certificatePassword
    }
    [void](Get-OwnedTarget)
    $migration = Invoke-Captured $DotnetPath @('ef', 'database', 'update', '--project', 'Spatia.Server', '--startup-project', 'tests', '--configuration', 'Release', '--no-build') $configuration -Seconds 60
    if ($migration.ExitCode -ne 0) { throw 'The reviewed schema migration did not complete.' }
    $stage = 'private administrator bootstrap'
    $bootstrapInput = @{ userName = $adminName; initialPassword = 'Synthetic restart administrator password 1!' } | ConvertTo-Json -Compress
    [void](Get-OwnedTarget)
    $bootstrap = Invoke-Captured $DotnetPath @($assembly, 'bootstrap-admin') $configuration -InputText $bootstrapInput
    if ($bootstrap.ExitCode -ne 0) { throw 'The real bootstrap command did not create the synthetic administrator.' }
    $stage = 'browser preparation'
    $first = Start-Api $configuration
    $initialPid = $first.Child.Process.Id
    $browser = Start-OwnedChild 'node' @((Join-Path $PSScriptRoot 'restart-browser.check.mjs'), $first.Origin, $adminName) -ReadLines
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(60)
    do {
        $line = Read-BrowserLine $browser ([Math]::Max(1, [int]($deadline - [DateTimeOffset]::UtcNow).TotalSeconds))
    } while ($line -ne 'restart-ready' -and [DateTimeOffset]::UtcNow -lt $deadline)
    if ($line -ne 'restart-ready') { throw 'Browser did not confirm pre-restart provisioning.' }
    $keysBefore = @(Get-ChildItem -LiteralPath $keyDirectory -Filter 'key-*.xml' -File | ForEach-Object { $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash })
    if ($keysBefore.Count -eq 0) { throw 'No retained Data Protection key was written.' }
    $stage = 'cold API and PostgreSQL restart'
    Stop-OwnedChild $first.Child
    [void](Get-OwnedTarget)
    $stopResult = Invoke-Captured $DockerPath @('stop', '--timeout', '10', $containerId)
    if ($stopResult.ExitCode -ne 0 -or (Get-OwnedTarget).Running) { throw 'The exact owned database did not stop.' }
    [void](Get-OwnedTarget)
    $restartResult = Invoke-Captured $DockerPath @('start', $containerId)
    if ($restartResult.ExitCode -ne 0) { throw 'The exact owned database did not restart.' }
    Wait-OwnedPostgres
    $scopedConnection['Port'] = $baseConnection['Port']
    $configuration['ConnectionStrings__Spatia'] = $scopedConnection.get_ConnectionString()
    $second = Start-Api $configuration
    $restartedPid = $second.Child.Process.Id
    if (-not $first.Child.Process.HasExited -or $restartedPid -eq $initialPid) { throw 'A distinct cold API process was not established.' }
    $keysAfter = @(Get-ChildItem -LiteralPath $keyDirectory -Filter 'key-*.xml' -File | ForEach-Object { $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash })
    if (@(Compare-Object $keysBefore $keysAfter).Count -ne 0) { throw 'The retained key ring changed during restart.' }
    $stage = 'post-restart browser acceptance'
    $browser.Process.StandardInput.WriteLine((@{ origin = $second.Origin } | ConvertTo-Json -Compress))
    $browser.Process.StandardInput.Close()
    foreach ($expected in @('restart retained session passed', 'restart fresh browser lifecycle passed', 'restart password durability passed')) {
        if ((Read-BrowserLine $browser 60) -ne $expected) { throw 'An expected restart acceptance marker was absent.' }
    }
    if (-not $browser.Process.WaitForExit(10000) -or $browser.Process.ExitCode -ne 0) { throw 'Browser acceptance did not exit successfully.' }
    Stop-OwnedChild $browser
    if (@($browserLines | Where-Object { $_ -match '^node v[0-9.]+; playwright [0-9.]+; chromium [0-9.]+$' }).Count -ne 1) { throw 'Browser version evidence is missing.' }
    $stage = 'complete'
}
catch { $failure = 'Restart acceptance failed during ' + $stage + ' (' + $_.Exception.GetType().Name + ').' }
finally {
    $remainingChildren = $children.ToArray()
    [array]::Reverse($remainingChildren)
    foreach ($child in $remainingChildren) {
        try { Stop-OwnedChild $child } catch { $cleanupFailures.Add('An owned child did not cleanly stop or pass output-safety checks.') }
        finally {
            if (-not $child.Process.HasExited) {
                $allChildrenConfirmedStopped = $false
                if (-not $retainedPids.Contains($child.Process.Id)) { $retainedPids.Add($child.Process.Id) }
            }
            $child.Process.Dispose()
        }
    }
    if ($schemaCreated -and -not $allChildrenConfirmedStopped) { $cleanupFailures.Add('An owned process remains; schema retained: ' + $schema) }
    if ($schemaCreated -and $allChildrenConfirmedStopped) {
        try {
            $target = Get-OwnedTarget
            if (-not $target.Running) {
                [void](Get-OwnedTarget)
                $recovery = Invoke-Captured $DockerPath @('start', $containerId)
                if ($recovery.ExitCode -ne 0) { throw 'Owned database recovery failed.' }
            }
            Wait-OwnedPostgres
            if ($schema -notmatch '^spatia_scrum45_[a-f0-9]{32}$') { throw 'Invalid owned schema.' }
            [void](Invoke-OwnedSql ('DROP SCHEMA IF EXISTS "' + $schema + '" CASCADE'))
            $remaining = Invoke-OwnedSql ("SELECT count(*) FROM pg_namespace WHERE nspname = '" + $schema + "'")
            if ($remaining -ne '0') { throw 'Owned schema remains.' }
            $schemaCreated = $false
        }
        catch { $cleanupFailures.Add('Owned schema cleanup failed; retained schema: ' + $schema) }
    }
    if ($null -ne $certificate) { $certificate.Dispose() }
    if ($directoryCreated -and (Test-Path -LiteralPath $ownedDirectory) -and -not $allChildrenConfirmedStopped) { $cleanupFailures.Add('An owned process remains; temporary directory retained: ' + $ownedDirectory) }
    if ($directoryCreated -and (Test-Path -LiteralPath $ownedDirectory) -and $allChildrenConfirmedStopped) {
        try {
            $resolved = [IO.Path]::GetFullPath($ownedDirectory)
            if ([IO.Path]::GetDirectoryName($resolved) -ne $artifactsRoot -or [IO.Path]::GetFileName($resolved) -ne ('restart-' + $runId) -or
                $runId -notmatch '^[a-f0-9]{32}$') { throw 'Invalid owned temporary directory.' }
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
        catch { $cleanupFailures.Add('Owned temporary directory cleanup failed: ' + $ownedDirectory) }
    }
    $result = [ordered]@{ completedAt = [DateTimeOffset]::UtcNow.ToString('o'); seconds = [Math]::Round(([DateTimeOffset]::UtcNow - $startedAt).TotalSeconds, 3)
        passed = ($null -eq $failure -and $cleanupFailures.Count -eq 0 -and $allChildrenConfirmedStopped); failure = $failure; cleanupFailures = @($cleanupFailures.ToArray())
        containerId = $containerId; database = 'spatia_scrum45_test'; postgresVersion = $postgresVersion; retainedChildPids = @($retainedPids.ToArray()); currentPort = $metadata.port; initialApiPid = $initialPid; restartedApiPid = $restartedPid
        ownedSchema = $schema; schemaRemoved = -not $schemaCreated; temporaryDirectory = $ownedDirectory; temporaryDirectoryRemoved = -not (Test-Path -LiteralPath $ownedDirectory)
        browser = @($browserLines.ToArray()) }
    [IO.File]::WriteAllText($resultPath, ($result | ConvertTo-Json -Depth 5))
}
if ($null -ne $failure -or $cleanupFailures.Count -gt 0 -or -not $allChildrenConfirmedStopped) { throw ('Restart acceptance did not pass. Fixed outcome and residue: ' + $resultPath) }
Write-Output ('Restart acceptance passed; nonsecret evidence: ' + $resultPath)
Write-Output ('Owned PostgreSQL remains running on 127.0.0.1:' + $metadata.port + ' for independent inspection.')
