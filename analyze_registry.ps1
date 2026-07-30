$json = Get-Content 'D:\Projects\Ouroboros\server\star_registry.json' -Raw | ConvertFrom-Json
$dead = $json | Where-Object { $null -ne $_.death_tick }

$types = @('red_dwarf','yellow_dwarf','blue_giant','neutron_star')
foreach ($t in $types) {
    $arr = @($dead | Where-Object { $_.birth_star_type -eq $t } | ForEach-Object { [int]$_.lifespan } | Sort-Object)
    $n = $arr.Count
    if ($n -eq 0) { Write-Host "$t : no data"; continue }
    $avg = [math]::Round(($arr | Measure-Object -Average).Average)
    $med = $arr[[math]::Floor($n/2)]
    $p75 = $arr[[math]::Floor($n*0.75)]
    $p90 = $arr[[math]::Floor($n*0.90)]
    $max = $arr[$n-1]
    Write-Host "$t ($n): avg=$avg  med=$med  p75=$p75  p90=$p90  max=$max"
}
