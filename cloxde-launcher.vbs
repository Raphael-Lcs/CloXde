' CloXde silent launcher.
'
' Wraps cloxde-launcher.bat so double-clicking the desktop shortcut starts
' the dev server with NO cmd window (not even a brief flash).
'
' The bat redirects its own stdout/stderr to:
'   %LOCALAPPDATA%\CloXde\launcher.log
' View with: notepad %LOCALAPPDATA%\CloXde\launcher.log

Option Explicit

Dim shell, fso, scriptDir, batPath

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = scriptDir & "\cloxde-launcher.bat"

If Not fso.FileExists(batPath) Then
  MsgBox "CloXde launcher not found:" & vbCrLf & batPath, 16, "CloXde"
  WScript.Quit 1
End If

' Run the bat directly. The bat owns its log redirection, so this is a
' single quoted path with no nested-quote handoff for cmd to mangle.
' 0 = hidden window. False = do not wait; release this script immediately.
shell.Run """" & batPath & """", 0, False
