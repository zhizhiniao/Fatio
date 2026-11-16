[Setup]
AppId={{7DDA4955-2B0F-4D48-8EE6-D3E3D6C519D3}
; Preserve AppId so this is an upgrade of the existing installation.
AppName=发条 Fatio
AppPublisher=蒋啊讲
AppVersion={#StudioVersion}
DefaultDirName={localappdata}\Programs\发条 Fatio
UsePreviousAppDir=no
DefaultGroupName=发条 Fatio
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/fast
SolidCompression=yes
DisableProgramGroupPage=yes
DisableDirPage=auto
CloseApplications=yes
OutputDir={#ReleaseDir}
OutputBaseFilename=Fatio-Setup-{#StudioVersion}-x64
SetupIconFile={#ProductDir}\resources\app\ui\fatio.ico
UninstallDisplayIcon={app}\Fatio.exe
WizardStyle=modern
[Files]
Source: "{#ProductDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#WebViewBootstrap}"; Flags: dontcopy
[Icons]
Name: "{userprograms}\发条 Fatio"; Filename: "{app}\Fatio.exe"; IconFilename: "{app}\resources\app\ui\fatio.ico"; AppUserModelID: "Fatio.CreatorWorkspace"
Name: "{userdesktop}\发条 Fatio"; Filename: "{app}\Fatio.exe"; IconFilename: "{app}\resources\app\ui\fatio.ico"; AppUserModelID: "Fatio.CreatorWorkspace"
[InstallDelete]
Type: files; Name: "{app}\JAStudio.exe"
Type: files; Name: "{app}\resources\channels-host\JAStudioChannels.exe"
Type: files; Name: "{app}\resources\app\ui\jastudio.ico"
[Run]
Filename: "{app}\Fatio.exe"; Description: "发条 Fatio"; Flags: nowait postinstall skipifsilent

[Code]
procedure RemoveOwnedLegacyShortcut(const Filename: String);
var
  WshShell, Shortcut: Variant;
  Target: String;
begin
  if not FileExists(Filename) then exit;
  try
    WshShell := CreateOleObject('WScript.Shell');
    Shortcut := WshShell.CreateShortcut(Filename);
    Target := Shortcut.TargetPath;
    if CompareText(Target, ExpandConstant('{app}\JAStudio.exe')) = 0 then
      DeleteFile(Filename);
  except
    Log('Legacy shortcut could not be inspected; leaving it intact: ' + Filename);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    RemoveOwnedLegacyShortcut(ExpandConstant('{userdesktop}\JAStudio.lnk'));
    RemoveOwnedLegacyShortcut(ExpandConstant('{userprograms}\JAStudio.lnk'));
  end;
end;

function HasWebView2: Boolean;
var
  Version: String;
  Key: String;
begin
  Key := 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  Result := (RegQueryStringValue(HKLM32, Key, 'pv', Version) or RegQueryStringValue(HKCU, Key, 'pv', Version)) and (Version <> '') and (Version <> '0.0.0.0');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  if HasWebView2() then exit;
  ExtractTemporaryFile('MicrosoftEdgeWebview2Setup.exe');
  if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebview2Setup.exe'), '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, Code) or not HasWebView2() then
    Result := '无法安装视频号所需的 Microsoft Edge WebView2 运行时。请检查网络后重试。';
end;
