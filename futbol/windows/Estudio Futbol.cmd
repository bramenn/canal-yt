@echo off
rem Estudio Futbol: arranca la app (Node + herramientas incluidas en el instalador) y abre el navegador.
title Estudio Futbol - deja esta ventana abierta mientras usas la app
cd /d "%~dp0"

rem herramientas incluidas: Node, Python (fotos, Whisper, yt-dlp, recorte), ffmpeg
set "PATH=%~dp0node;%~dp0python;%~dp0python\Scripts;%~dp0ffmpeg;%PATH%"
set "IMG_PYTHON=%~dp0python\python.exe"
set "ALIGN_PYTHON=%~dp0python\python.exe"
set "YTDLP_BIN=%~dp0python\Scripts\yt-dlp.exe"
set "CAPCUT_DIR=%~dp0CapCutAPI"
set "CAPCUT_PYTHON=%~dp0python\python.exe"
rem tus videos van a Documentos: sobreviven a actualizaciones y desinstalaciones
set "PROJECTS_DIR=%USERPROFILE%\Documents\Estudio Futbol"
rem rutas de Claude Code y Codex (las escribe el instalador)
if exist "%~dp0bins.cmd" call "%~dp0bins.cmd"

rem si ya estaba abierta, solo abre el navegador
powershell -NoProfile -Command "try { Invoke-RestMethod http://127.0.0.1:4322/api/status -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 (
  start "" http://localhost:4322
  exit /b
)

echo.
echo   Estudio Futbol se esta abriendo en tu navegador...
echo   Deja esta ventana abierta mientras lo usas. Para cerrar la app, cierra esta ventana.
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process http://localhost:4322"
"%~dp0node\node.exe" futbol\server.js
echo.
echo La app se ha cerrado. Si ves un error arriba, envialo a quien te paso la app.
pause
