; Munim Tally Connector - Windows installer
;
; Build:  iscc installer\munim.iss
; Needs:  Inno Setup 6+, and dist\munim-connector.exe already built.
;
; Design note: this script does the HARD GATES only - Windows version, admin
; rights, disk, internet, and Tally. Everything interactive (sign-in, QR code,
; company selection) happens afterwards in the connector's own browser wizard,
; because a QR code and a live company list are an afternoon in HTML and a
; fortnight in Pascal.

#define AppName        "Munim"
; Allow the build script to override with /DAppVersion=x.y.z. Without the
; guard the script's own define wins and build.ps1 -Version is silently ignored.
#ifndef AppVersion
  #define AppVersion   "0.1.0"
#endif
#define Publisher      "Munim Technologies"
#define ExeName        "munim-connector.exe"
#define ServiceName    "MunimConnector"
#define SupportURL     "https://munim.app/help"

[Setup]
AppId={{9F2A4B11-7E3B-4D44-9C21-3A5E7C1D8B60}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} Connector {#AppVersion}
AppPublisher={#Publisher}
AppSupportURL={#SupportURL}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=no
OutputDir=..\dist
OutputBaseFilename=MunimSetup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
; The connector runs as a Windows service, which requires admin to install.
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
MinVersion=10.0
WizardStyle=modern
WizardSizePercent=110
SetupIconFile=assets\munim.ico
UninstallDisplayIcon={app}\{#ExeName}
; Signing: set SignTool in the Inno IDE, or pass /S on the command line.
; An unsigned installer trips SmartScreen and install conversion collapses.
;SignTool=munimsign

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\dist\{#ExeName}"; DestDir: "{app}"; Flags: ignoreversion
; A second copy extracted to {tmp} so the system-check page can run the real
; check binary BEFORE anything is installed. Same file, no extra download.
Source: "..\dist\{#ExeName}"; Flags: dontcopy noencryption
Source: "assets\munim.ico";   DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist

[Icons]
Name: "{group}\Munim Setup";        Filename: "{app}\{#ExeName}"; Parameters: "setup"; IconFilename: "{app}\munim.ico"
Name: "{group}\Munim Sync Status";  Filename: "{app}\{#ExeName}"; Parameters: "check"
Name: "{group}\Uninstall Munim";    Filename: "{uninstallexe}"

[Run]
; Order matters: install the service, start it, then open the pairing wizard.
Filename: "{app}\{#ExeName}"; Parameters: "install"; Flags: runhidden waituntilterminated; StatusMsg: "Installing the Munim background service..."
Filename: "{app}\{#ExeName}"; Parameters: "start";   Flags: runhidden waituntilterminated; StatusMsg: "Starting Munim..."
Filename: "{app}\{#ExeName}"; Parameters: "setup";   Flags: nowait postinstall skipifsilent runasoriginaluser; Description: "Connect Munim to your mobile number"

[UninstallRun]
Filename: "{app}\{#ExeName}"; Parameters: "stop";      Flags: runhidden waituntilterminated; RunOnceId: "StopSvc"
Filename: "{app}\{#ExeName}"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveSvc"

[UninstallDelete]
; Leave C:\ProgramData\Munim in place: it holds the pairing and sync cursors,
; so a reinstall resumes instead of re-downloading the whole book. The
; uninstaller asks before removing it (see CurUninstallStepChanged).
Type: filesandordirs; Name: "{app}\logs"

[Code]
var
  CheckPage: TWizardPage;
  CheckMemo: TNewMemo;
  RecheckBtn: TNewButton;
  HelpBtn: TNewButton;
  ChecksPassed: Boolean;

{ ---- helpers ---- }

function RunChecks(): Boolean;
var
  OutFile: String;
  Cmd: String;
  Code, I: Integer;
  Lines: TArrayOfString;
  Text: String;
begin
  CheckMemo.Text := 'Checking this computer...';
  WizardForm.Refresh();

  OutFile := ExpandConstant('{tmp}\munim-check.txt');
  DeleteFile(OutFile);

  { cmd /C, because Inno cannot capture a child process's stdout directly. }
  Cmd := '/C ""' + ExpandConstant('{tmp}\{#ExeName}') + '" check > "' + OutFile + '" 2>&1"';
  if not Exec(ExpandConstant('{cmd}'), Cmd, '', SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    CheckMemo.Text := 'Could not run the system check.'#13#10 +
                      'Your antivirus may have blocked it. Allow ' +
                      '{#ExeName} and try again.';
    Result := False;
    Exit;
  end;

  Text := '';
  if LoadStringsFromFile(OutFile, Lines) then
    for I := 0 to GetArrayLength(Lines) - 1 do
      Text := Text + Lines[I] + #13#10;
  if Text = '' then
    Text := 'The system check produced no output.'#13#10;

  CheckMemo.Text := Text;
  { The check binary exits non-zero when any check FAILs. }
  Result := (Code = 0);
end;

procedure RecheckClick(Sender: TObject);
begin
  ChecksPassed := RunChecks();
  WizardForm.NextButton.Enabled := ChecksPassed;
  if ChecksPassed then
    CheckMemo.Text := CheckMemo.Text + #13#10'Everything looks good. Click Next to install.';
end;

procedure HelpClick(Sender: TObject);
var
  Code: Integer;
begin
  ShellExec('open', '{#SupportURL}/tally-connection', '', '', SW_SHOW, ewNoWait, Code);
end;

{ ---- wizard pages ---- }

procedure InitializeWizard();
var
  Lbl: TNewStaticText;
begin
  { Needed before the check page can run it. }
  ExtractTemporaryFile('{#ExeName}');

  CheckPage := CreateCustomPage(wpLicense,
    'System check',
    'Munim needs Tally and an internet connection on this computer.');

  Lbl := TNewStaticText.Create(CheckPage);
  Lbl.Parent := CheckPage.Surface;
  Lbl.Top := 0;
  Lbl.Width := CheckPage.SurfaceWidth;
  Lbl.WordWrap := True;
  Lbl.Caption := 'Munim reads your data directly from Tally, so both must be on this ' +
                 'same computer. Keep Tally open while we check.';
  Lbl.AutoSize := True;

  CheckMemo := TNewMemo.Create(CheckPage);
  CheckMemo.Parent := CheckPage.Surface;
  CheckMemo.Top := Lbl.Top + Lbl.Height + ScaleY(10);
  CheckMemo.Width := CheckPage.SurfaceWidth;
  CheckMemo.Height := CheckPage.SurfaceHeight - Lbl.Height - ScaleY(52);
  CheckMemo.ReadOnly := True;
  CheckMemo.ScrollBars := ssVertical;
  CheckMemo.Font.Name := 'Consolas';
  CheckMemo.Font.Size := 8;

  RecheckBtn := TNewButton.Create(CheckPage);
  RecheckBtn.Parent := CheckPage.Surface;
  RecheckBtn.Top := CheckMemo.Top + CheckMemo.Height + ScaleY(8);
  RecheckBtn.Width := ScaleX(110);
  RecheckBtn.Height := ScaleY(25);
  RecheckBtn.Caption := 'Check again';
  RecheckBtn.OnClick := @RecheckClick;

  HelpBtn := TNewButton.Create(CheckPage);
  HelpBtn.Parent := CheckPage.Surface;
  HelpBtn.Top := RecheckBtn.Top;
  HelpBtn.Left := RecheckBtn.Width + ScaleX(8);
  HelpBtn.Width := ScaleX(150);
  HelpBtn.Height := ScaleY(25);
  HelpBtn.Caption := 'How do I enable Tally?';
  HelpBtn.OnClick := @HelpClick;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = CheckPage.ID then
  begin
    ChecksPassed := RunChecks();
    WizardForm.NextButton.Enabled := ChecksPassed;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = CheckPage.ID then
  begin
    { Never let a user install a connector that provably cannot work. They
      would end up with a paid product that shows an empty dashboard and no
      explanation. }
    if not ChecksPassed then
    begin
      MsgBox('Munim cannot run on this computer yet.'#13#10#13#10 +
             'Fix the items marked FAIL above, then press "Check again".',
             mbError, MB_OK);
      Result := False;
    end;
  end;
end;

{ Stop a running service before overwriting the binary, or the file is locked
  and the upgrade fails halfway. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\{#ExeName}')) then
  begin
    Exec(ExpandConstant('{app}\{#ExeName}'), 'stop', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Sleep(1500);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{commonappdata}\Munim');
    if DirExists(DataDir) then
      if MsgBox('Remove your Munim settings and sync history from this computer?'#13#10#13#10 +
                'Choose No if you plan to reinstall - Munim will then resume ' +
                'syncing instead of re-reading all your Tally data.',
                mbConfirmation, MB_YESNO) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
