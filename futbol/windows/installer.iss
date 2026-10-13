; Instalador de Estudio Futbol (Inno Setup). Lo compila la GitHub Action .github/workflows/windows-installer.yml
; a partir de dist\app (la app + Node, Python, ffmpeg, Claude Code, Codex y CapCutAPI ya preparados).
#define AppVersion GetEnv("APP_VERSION")
#if AppVersion == ""
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F0B5E3A-9C1D-4E57-9B0A-ESTUDIOFUTBOL}
AppName=Estudio Futbol
AppVersion={#AppVersion}
AppPublisher=Bramenn
; por usuario: no pide administrador y la carpeta es escribible (claves, ajustes)
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\Estudio Futbol
DisableProgramGroupPage=yes
OutputDir=..\..\dist
OutputBaseFilename=EstudioFutbol-Setup-{#AppVersion}
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Estudio Futbol

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "Crear un acceso directo en el escritorio"; GroupDescription: "Accesos directos:"

[Files]
Source: "..\..\dist\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Estudio Futbol"; Filename: "{app}\Estudio Futbol.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\node\node.exe"
Name: "{autodesktop}\Estudio Futbol"; Filename: "{app}\Estudio Futbol.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\node\node.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Estudio Futbol.cmd"; Description: "Abrir Estudio Futbol"; Flags: postinstall nowait shellexec skipifsilent

[UninstallDelete]
; las claves guardadas en Ajustes se borran al desinstalar; los videos (Documentos\Estudio Futbol) se conservan
Type: filesandordirs; Name: "{app}\.secrets"
