' Startet den Upload-Planer (Server im Hintergrund) und oeffnet das Dashboard im Browser.
Option Explicit
Dim shell, req, running
Set shell = CreateObject("WScript.Shell")
running = False
On Error Resume Next
Set req = CreateObject("MSXML2.XMLHTTP")
req.Open "GET", "http://127.0.0.1:8791/api/health", False
req.Send
If Err.Number = 0 Then
  If req.status = 200 Then running = True
End If
Err.Clear
On Error GoTo 0
If Not running Then
  shell.Run "cmd /c node ""D:\Kreativ\Social-Scheduler\dashboard-server.mjs""", 0, False
  WScript.Sleep 1500
End If
shell.Run "http://127.0.0.1:8791", 1, False
