# Signe maMaisonConnectee.exe si un certificat est present.
# Usage : $env:MAISON_CERT = "chemin.pfx" ; $env:MAISON_CERT_PASS = "..." ; .\sign.ps1
$exe = Join-Path $PSScriptRoot "dist\maMaisonConnectee.exe"
if (-not (Test-Path $exe)) { Write-Error "Compile le programme d'abord."; exit 1 }
if (-not $env:MAISON_CERT) { Write-Output "Pas de certificat. Windows affichera encore l'alerte a l'ouverture."; exit 0 }
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $signtool) { Write-Error "signtool.exe introuvable."; exit 1 }
& $signtool.FullName sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /f $env:MAISON_CERT /p $env:MAISON_CERT_PASS $exe
