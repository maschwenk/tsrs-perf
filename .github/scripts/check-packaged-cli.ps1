$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$arch = $env:EXPECTED_ARCH
if ((node -p process.arch) -ne $arch) { throw "Expected native Node for $arch" }
$version = node npm/build.mjs --print-version
$output = Join-Path $env:RUNNER_TEMP 'packed-cli'
$binaryDir = Join-Path $output 'native'
New-Item -ItemType Directory -Force $binaryDir | Out-Null
$archive = @(npm pack "@tsrs/win32-${arch}@$version" --json --ignore-scripts --registry=https://registry.npmjs.org --pack-destination $output | ConvertFrom-Json)[0]
$tarball = Join-Path $output $archive.filename
$hash = [Security.Cryptography.SHA512]::HashData([IO.File]::ReadAllBytes($tarball))
if (("sha512-" + [Convert]::ToBase64String($hash)) -ne $env:NATIVE_INTEGRITY) { throw 'Unexpected public platform package' }
tar -xf $tarball -C $binaryDir package/tsrs.exe
$native = Join-Path $binaryDir 'package/tsrs.exe'
$dist = Join-Path $output 'dist'
node npm/build.mjs --binary "$env:NATIVE_TARGET=$native" --out $dist --pack
$smokeArgs = @('npm/sdk/smoke-consumer.mjs', '--dist', $dist, '--noembed', '--cli-only', '--node', (Get-Command node).Source)
if ($arch -eq 'x64') {
    $old = '16.20.0'
    $name = "node-v$old-win-x64.zip"
    $zip = Join-Path $output $name
    $sums = (Invoke-WebRequest "https://nodejs.org/dist/v$old/SHASUMS256.txt").Content
    $line = @($sums -split "`n" | Where-Object { $_.Trim().EndsWith("  $name") })
    if ($line.Length -ne 1) { throw 'Expected exactly one Windows Node package checksum' }
    Invoke-WebRequest "https://nodejs.org/dist/v$old/$name" -OutFile $zip
    if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne ($line[0].Trim() -split '\s+')[0]) { throw 'Unexpected Node package' }
    Expand-Archive $zip -DestinationPath $output
    $smokeArgs += @('--node', (Join-Path $output "node-v$old-win-x64/node.exe"))
}
node @smokeArgs
