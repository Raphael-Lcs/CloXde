' CloXde silent launcher.
'
' Wraps cloxde-launcher.bat so that double-clicking the desktop shortcut
' starts the dev server with NO cmd window — not even the brief flash you
' get from `WindowStyle 7` (which still parks the console in the taskbar).
'
' stdout/stderr are redirected to %LOCALAPPDATA%\CloXde\launcher.log so we
' can still tail the log when something goes wrong. Open with:
'   notepad %LOCALAPPDATA%\CloXde\launcher.log
' Or, for live logs, keep using cloxde-launcher.bat directly.

Option Explicit

Dim shell, fso, scriptDir, batPath, logDir, logPath, cmd, q

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = scriptDir & "\cloxde-launcher.bat"

If Not fso.FileExists(batPath) Then
  MsgBox "CloXde launcher not found:" & vbCrLf & batPath, 16, "CloXde"
  WScript.Quit 1
End If

logDir = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\CloXde"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
logPath = logDir & "\launcher.log"

' Build:  cmd /c "<bat>" > "<log>" 2>&1
' (cmd.exe will strip the outer pair if the whole command after /c is wrapped.)
q = Chr(34)
cmd = "cmd /c " & q & q & batPath & q & " > " & q & logPath & q & " 2>&1" & q

' 0 = hidden window. False = do not wait — releases this script immediately.
shell.Run cmd, 0, False

