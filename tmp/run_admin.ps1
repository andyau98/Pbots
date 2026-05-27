#requires -RunAsAdministrator

$scriptPath = "C:\Users\HFTC\Documents\trae_projects\PBOTS\tmp\extract_cookies.py"
$outFile = "C:\Users\HFTC\Documents\trae_projects\PBOTS\tmp\cookies_result.txt"

python3 $scriptPath *> $outFile

Write-Host "Done. Output written to $outFile"
