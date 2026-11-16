param([string]$OutputDirectory)
$ErrorActionPreference='Stop'
$env:PSModulePath=(Join-Path $PSHOME 'Modules')+[IO.Path]::PathSeparator+$env:PSModulePath
$project=Split-Path -Parent $PSScriptRoot
$cache=Join-Path $project '.runtime/webview2-sdk'
$target=if($OutputDirectory){$OutputDirectory}else{Join-Path $project '.runtime/channels-host'}
New-Item -ItemType Directory -Force -Path $cache,$target | Out-Null
$zip=Join-Path $cache 'sdk.zip'
$version='1.0.3537.50'
$sha='5EA526BBD728ADDA0DA4D31219267E96460494A427E4894C4E09D9F320F4B9AA'
if(!(Test-Path -LiteralPath $zip)){
    Invoke-WebRequest -UseBasicParsing "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$version/microsoft.web.webview2.$version.nupkg" -OutFile $zip
}
if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $sha){throw 'WebView2 SDK 校验失败'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$package=[IO.Compression.ZipFile]::OpenRead($zip)
try{
    foreach($file in @('lib/net462/Microsoft.Web.WebView2.Core.dll','lib/net462/Microsoft.Web.WebView2.WinForms.dll','runtimes/win-x64/native/WebView2Loader.dll','LICENSE.txt')){
        [IO.Compression.ZipFileExtensions]::ExtractToFile($package.GetEntry($file),(Join-Path $target ([IO.Path]::GetFileName($file))),$true)
    }
} finally {$package.Dispose()}
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$target=(Resolve-Path $target).Path
$source=(Resolve-Path (Join-Path $project 'native/ChannelsWindow.cs')).Path
$icon=(Resolve-Path (Join-Path $project 'ui/fatio.ico')).Path
$version=(Get-Content -Raw -LiteralPath (Join-Path $project 'package.json') | ConvertFrom-Json).version
$assembly=Join-Path $target 'FatioAssemblyInfo.cs'
@"
using System.Reflection;
[assembly: AssemblyTitle("发条 Fatio · 视频号")]
[assembly: AssemblyProduct("发条 Fatio")]
[assembly: AssemblyCompany("蒋啊讲")]
[assembly: AssemblyVersion("$version")]
[assembly: AssemblyFileVersion("$version")]
"@ | Set-Content -LiteralPath $assembly -Encoding UTF8
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /utf8output "/win32icon:$icon" "/out:$target\FatioChannels.exe" "/reference:$target\Microsoft.Web.WebView2.Core.dll" "/reference:$target\Microsoft.Web.WebView2.WinForms.dll" /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll /reference:System.Drawing.dll $source $assembly
if($LASTEXITCODE){exit $LASTEXITCODE}
$bootstrap=Join-Path $cache 'MicrosoftEdgeWebview2Setup.exe'
if(!(Test-Path -LiteralPath $bootstrap)){
    Invoke-WebRequest -UseBasicParsing 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $bootstrap
}
$signature=Get-AuthenticodeSignature -FilePath $bootstrap
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '^CN=Microsoft Corporation,'){throw 'WebView2 安装程序签名无效'}
