$json = Get-Content "$PSScriptRoot\..\server\star_registry.json" -Raw | ConvertFrom-Json
$dead = @($json | Where-Object { $null -ne $_.death_tick })

function Stats($arr) {
    $n = $arr.Count
    if ($n -eq 0) { return "no data" }
    $avg = [math]::Round(($arr | Measure-Object -Average).Average)
    $med = $arr[[math]::Floor($n/2)]
    $p90 = $arr[[math]::Floor($n*0.90)]
    $max = $arr[$n-1]
    return "n=$n avg=$avg med=$med p90=$p90 max=$max"
}

Write-Host "=== Естественная смерть (overcool / overheat) ==="
foreach ($t in @('red_dwarf','yellow_dwarf','blue_giant','neutron_star')) {
    $nat = @($dead | Where-Object { $_.birth_star_type -eq $t -and ($_.death_cause -eq 'overcool' -or $_.death_cause -eq 'overheat') } | ForEach-Object { [int]$_.lifespan } | Sort-Object)
    Write-Host "$t : $(Stats $nat)"
}

Write-Host ""
Write-Host "=== Все смерти (включая столкновения) ==="
foreach ($t in @('red_dwarf','yellow_dwarf')) {
    $all = @($dead | Where-Object { $_.birth_star_type -eq $t } | ForEach-Object { [int]$_.lifespan } | Sort-Object)
    $nat = @($dead | Where-Object { $_.birth_star_type -eq $t -and ($_.death_cause -eq 'overcool' -or $_.death_cause -eq 'overheat') } | ForEach-Object { [int]$_.lifespan } | Sort-Object)
    $col = @($dead | Where-Object { $_.birth_star_type -eq $t -and $_.death_cause -eq 'collision' })
    $pctCol = [math]::Round($col.Count * 100 / [math]::Max(1,$all.Count))
    Write-Host "$t : всего=$($all.Count) (столкнов.=$($col.Count) = $pctCol%) | естественных=$($nat.Count) avg=$(if($nat.Count){ [math]::Round(($nat | Measure-Object -Average).Average) } else { '-' }) max=$(if($nat.Count){ ($nat | Measure-Object -Maximum).Maximum } else { '-' })"
}

Write-Host ""
Write-Host "=== Красные карлики-долгожители (lifespan > 300) ==="
$rdLong = @($dead | Where-Object { $_.birth_star_type -eq 'red_dwarf' -and [int]$_.lifespan -gt 300 })
Write-Host "Кол-во: $($rdLong.Count)"
$rdCauses = $rdLong | Group-Object death_cause
foreach ($c in $rdCauses) { Write-Host "  $($c.Name): $($c.Count)" }
