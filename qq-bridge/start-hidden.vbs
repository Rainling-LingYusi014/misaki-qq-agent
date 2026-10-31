' 2026-10-30：隐藏窗口启动 qq-bridge（start.bat 是常驻循环：node src/bridge.js 退出即重拉）。
' 主人桌面不需要这个黑窗口；关掉它会连带杀死桥，所以改成完全隐藏（窗口样式 0）。
' 日志仍落 qq-bridge/state/bridge.log，控制台在 http://127.0.0.1:3100。
' 用法：wscript.exe start-hidden.vbs
On Error Resume Next
Dim sh, fso, base
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
sh.Run "cmd /c """ & base & "\start.bat""", 0, False
