$json = Get-Content "$PSScriptRoot\..\server\star_registry.json" -Raw | ConvertFrom-Json
Write-Host "Total records: $($json.Count)"
$dead = $json | Where-Object { $null -ne $_.death_tick }
Write-Host "Dead records: $($dead.Count)"
if ($dead.Count -gt 0) {
    $sample = $dead[0]
    Write-Host "Sample: birth_star_type=$($sample.birth_star_type) lifespan=$($sample.lifespan) death_cause=$($sample.death_cause)"
}
$alive = $json | Where-Object { $null -eq $_.death_tick }
Write-Host "Alive records: $($alive.Count)"
