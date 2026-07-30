$json = Get-Content "$PSScriptRoot\..\server\star_registry.json" -Raw | ConvertFrom-Json
$alive = @($json | Where-Object { $null -eq $_.death_tick })
$dead  = @($json | Where-Object { $null -ne $_.death_tick })
Write-Host "Total: $($json.Count)  Alive: $($alive.Count)  Dead: $($dead.Count)"

$types = @('red_dwarf','yellow_dwarf','blue_giant','neutron_star')
foreach ($t in $types) {
    $arr = @($dead | Where-Object { $_.birth_star_type -eq $t } | ForEach-Object { [int]$_.lifespan } | Sort-Object)
    $n = $arr.Count
    if ($n -eq 0) { Write-Host "$t : no data"; continue }
    $avg = [math]::Round(($arr | Measure-Object -Average).Average)
    $min = $arr[0]
    $med = $arr[[math]::Floor($n/2)]
    $p75 = $arr[[math]::Floor($n*0.75)]
    $p90 = $arr[[math]::Floor($n*0.90)]
    $max = $arr[$n-1]
    # long-lived: lifespan > 200
    $long = @($arr | Where-Object { $_ -gt 200 }).Count
    Write-Host "$t ($n dead): avg=$avg min=$min med=$med p75=$p75 p90=$p90 max=$max | >200ticks: $long"
}

# Death causes for red_dwarf
Write-Host "`nRed dwarf death causes:"
$rd = @($dead | Where-Object { $_.birth_star_type -eq 'red_dwarf' })
$causes = $rd | Group-Object death_cause
foreach ($c in $causes) { Write-Host "  $($c.Name): $($c.Count)" }
