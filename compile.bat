@echo off
chcp 65001 >nul
csc -nologo -target:winexe -platform:x64 -optimize+ -codepage:65001 -out:"足迹地图.exe" -win32icon:"pages\icon.ico" -r:"Microsoft.Web.WebView2.Core.dll" -r:"Microsoft.Web.WebView2.WinForms.dll" Program.cs
if errorlevel 1 pause
if exist "足迹地图.exe" echo 编译完成：足迹地图.exe
pause
