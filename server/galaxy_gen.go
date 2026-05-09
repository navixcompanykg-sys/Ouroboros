package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"math/rand"
	"os"
)

// ============================================================
// CONFIG
// ============================================================

type Config struct {
	Generation struct {
		Seed              int64       `json:"seed"`
		NumStars          int         `json:"num_stars"`
		NumBlackHoles     int         `json:"num_black_holes"`
		NumNebulae        int         `json:"num_nebulae"`
		NumAsteroidFields int         `json:"num_asteroid_fields"`
		GalaxyRadius      float64     `json:"galaxy_radius"`
		ChaosRadius       float64     `json:"chaos_radius"`
		MinDist           float64     `json:"min_dist"`
		NumRays           int         `json:"num_rays"`
		StarsOnRay        []int       `json:"stars_on_ray"`
		StarTypeProbs     [][]float64 `json:"star_type_probs"`
		MassBGMin         int         `json:"mass_blue_giant_min"`
		MassBGMax         int         `json:"mass_blue_giant_max"`
		MassYDMin         int         `json:"mass_yellow_dwarf_min"`
		MassYDMax         int         `json:"mass_yellow_dwarf_max"`
		MassRDMin         int         `json:"mass_red_dwarf_min"`
		MassRDMax         int         `json:"mass_red_dwarf_max"`
		MassWDMin         int         `json:"mass_white_dwarf_min"`
		MassWDMax         int         `json:"mass_white_dwarf_max"`
		MassBHMin         int         `json:"mass_black_hole_min"`
		MassBHMax         int         `json:"mass_black_hole_max"`
		MassNebMin        int         `json:"mass_nebula_min"`
		MassNebMax        int         `json:"mass_nebula_max"`
		MassAstMin        int         `json:"mass_asteroid_min"`
		MassAstMax        int         `json:"mass_asteroid_max"`
	} `json:"generation"`
}

func loadConfig(path string) (Config, error) {
	var cfg Config
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("cannot read config: %w", err)
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("cannot parse config: %w", err)
	}
	return cfg, nil
}

// ============================================================
// TYPES
// ============================================================

type ObjectType string
type StarType string

const (
	TypeStar          ObjectType = "star"
	TypeBlackHole     ObjectType = "black_hole"
	TypeNebula        ObjectType = "nebula"
	TypeAsteroidField ObjectType = "asteroid_field"

	StarBlueGiant   StarType = "blue_giant"
	StarYellowDwarf StarType = "yellow_dwarf"
	StarRedDwarf    StarType = "red_dwarf"
	StarWhiteDwarf  StarType = "white_dwarf"
)

type GalaxyObject struct {
	ID       int        `json:"id"`
	Type     ObjectType `json:"type"`
	StarType StarType   `json:"star_type,omitempty"`
	X        float64    `json:"x"`
	Y        float64    `json:"y"`
	Mass     int        `json:"mass"`
	R        float64    `json:"r"`
	Theta    float64    `json:"theta"`
	VX       float64    `json:"vx"`
	VY       float64    `json:"vy"`
}

type GalaxyStats struct {
	TotalObjects    int            `json:"total_objects"`
	TotalMass       int            `json:"total_mass"`
	CountByType     map[string]int `json:"count_by_type"`
	CountByStarType map[string]int `json:"count_by_star_type"`
}

type Galaxy struct {
	Seed        int64          `json:"seed"`
	Objects     []GalaxyObject `json:"objects"`
	Stats       GalaxyStats    `json:"stats"`
	RotationDir float64        `json:"rotation_dir"`
}

// ============================================================
// SPATIAL GRID
// ============================================================

type Grid struct {
	cells    map[[2]int][][2]float64
	cellSize float64
}

func newGrid(minDist float64) *Grid {
	return &Grid{cells: map[[2]int][][2]float64{}, cellSize: minDist}
}

func (g *Grid) key(x, y float64) [2]int {
	return [2]int{int(math.Floor(x / g.cellSize)), int(math.Floor(y / g.cellSize))}
}

func (g *Grid) isFree(x, y, minDist float64) bool {
	ck := g.key(x, y)
	minD2 := minDist * minDist
	for dx := -2; dx <= 2; dx++ {
		for dy := -2; dy <= 2; dy++ {
			for _, p := range g.cells[[2]int{ck[0] + dx, ck[1] + dy}] {
				ddx, ddy := p[0]-x, p[1]-y
				if ddx*ddx+ddy*ddy < minD2 {
					return false
				}
			}
		}
	}
	return true
}

func (g *Grid) add(x, y float64) {
	ck := g.key(x, y)
	g.cells[ck] = append(g.cells[ck], [2]float64{x, y})
}

// ============================================================
// HELPERS
// ============================================================

func dist2(x1, y1, x2, y2 float64) float64 {
	return math.Sqrt((x2-x1)*(x2-x1) + (y2-y1)*(y2-y1))
}

func velocity(x, y, rotDir, centerX, centerY float64) (vx, vy float64) {
	theta := math.Atan2(y-centerY, x-centerX)
	r := dist2(x, y, centerX, centerY)
	if r < 0.5 {
		return
	}
	// П3: скорость для устойчивой орбиты вокруг центрального аттрактора
	// v = sqrt(G * M_center / r), G=0.005, M_center=2000
	const G = 0.005
	const M = 2000.0
	v := math.Sqrt(G * M / r)
	vx = -rotDir * v * math.Sin(theta)
	vy = rotDir * v * math.Cos(theta)
	return
}

func pickStarType(r float64, rng *rand.Rand, probs [][]float64) StarType {
	band := int(r / 10.0)
	if band >= len(probs) {
		band = len(probs) - 1
	}
	p := probs[band]
	roll, cum := rng.Float64(), 0.0
	types := []StarType{StarBlueGiant, StarYellowDwarf, StarRedDwarf, StarWhiteDwarf}
	for i, prob := range p {
		cum += prob
		if roll < cum {
			return types[i]
		}
	}
	return StarRedDwarf
}

func starMass(st StarType, rng *rand.Rand, g *Config) int {
	switch st {
	case StarBlueGiant:
		return g.Generation.MassBGMin + rng.Intn(g.Generation.MassBGMax-g.Generation.MassBGMin+1)
	case StarYellowDwarf:
		return g.Generation.MassYDMin + rng.Intn(g.Generation.MassYDMax-g.Generation.MassYDMin+1)
	case StarRedDwarf:
		return g.Generation.MassRDMin + rng.Intn(g.Generation.MassRDMax-g.Generation.MassRDMin+1)
	case StarWhiteDwarf:
		return g.Generation.MassWDMin + rng.Intn(g.Generation.MassWDMax-g.Generation.MassWDMin+1)
	}
	return 20
}

// ============================================================
// GENERATION
// ============================================================

func generateGalaxy(seed int64, cfg *Config) Galaxy {
	rng := rand.New(rand.NewSource(seed))
	rotDir := 1.0
	if rng.Intn(2) == 0 {
		rotDir = -1.0
	}

	centerX := 50.0
	centerY := 50.0
	galaxyR := cfg.Generation.GalaxyRadius
	chaosR := cfg.Generation.ChaosRadius
	minDist := cfg.Generation.MinDist

	objects := []GalaxyObject{}
	grid := newGrid(minDist)
	id := 0

	inGalaxy := func(x, y float64) bool { return dist2(x, y, centerX, centerY) <= galaxyR }
	inChaos := func(x, y float64) bool  { return dist2(x, y, centerX, centerY) < chaosR }
	isFree := func(x, y float64) bool   { return inGalaxy(x, y) && !inChaos(x, y) && grid.isFree(x, y, minDist) }

	add := func(obj GalaxyObject) {
		obj.ID = id
		objects = append(objects, obj)
		grid.add(obj.X, obj.Y)
		id++
	}

	makeObj := func(x, y float64, t ObjectType, st StarType, mass int) GalaxyObject {
		r := dist2(x, y, centerX, centerY)
		theta := math.Atan2(y-centerY, x-centerX)
		vx, vy := velocity(x, y, rotDir, centerX, centerY)
		return GalaxyObject{Type: t, StarType: st, X: x, Y: y, Mass: mass, R: r, Theta: theta, VX: vx, VY: vy}
	}

	randInGalaxy := func() (float64, float64) {
		angle := rng.Float64() * 2 * math.Pi
		radius := math.Sqrt(rng.Float64()) * galaxyR
		return centerX + radius*math.Cos(angle), centerY + radius*math.Sin(angle)
	}

	// --- Stars via spiral rays ---
	placed := 0
	numRings := len(cfg.Generation.StarsOnRay)
	ringSize := (galaxyR - chaosR) / float64(numRings)

	for i := 0; i < cfg.Generation.NumRays; i++ {
		phi := float64(i) * math.Pi / float64(cfg.Generation.NumRays/2)
		for j := 0; j < numRings; j++ {
			minR := chaosR + float64(j)*ringSize
			maxR := chaosR + float64(j+1)*ringSize
			count := cfg.Generation.StarsOnRay[j]
			for s := 0; s < count; s++ {
				for attempt := 0; attempt < 40; attempt++ {
					r := minR + rng.Float64()*(maxR-minR)
					delta := (rng.Float64() - 0.5) * (math.Pi / float64(cfg.Generation.NumRays/2))
					x := centerX + r*math.Cos(phi+delta)
					y := centerY + r*math.Sin(phi+delta)
					if !isFree(x, y) {
						continue
					}
					st := pickStarType(r, rng, cfg.Generation.StarTypeProbs)
					add(makeObj(x, y, TypeStar, st, starMass(st, rng, cfg)))
					placed++
					break
				}
			}
		}
	}

	// Fill missing stars
	for missing := cfg.Generation.NumStars - placed; missing > 0; {
		x, y := randInGalaxy()
		if !isFree(x, y) {
			continue
		}
		r := dist2(x, y, centerX, centerY)
		st := pickStarType(r, rng, cfg.Generation.StarTypeProbs)
		add(makeObj(x, y, TypeStar, st, starMass(st, rng, cfg)))
		missing--
	}

	// Generic random placer
	placeN := func(n int, t ObjectType, massLo, massHi int) int {
		placed := 0
		maxTries := n * 500
		for tries := 0; placed < n && tries < maxTries; tries++ {
			x, y := randInGalaxy()
			if !isFree(x, y) {
				continue
			}
			mass := massLo + rng.Intn(massHi-massLo+1)
			add(makeObj(x, y, t, "", mass))
			placed++
		}
		return placed
	}

	placedBH  := placeN(cfg.Generation.NumBlackHoles,     TypeBlackHole,     cfg.Generation.MassBHMin, cfg.Generation.MassBHMax)
	placedNeb := placeN(cfg.Generation.NumNebulae,         TypeNebula,        cfg.Generation.MassNebMin, cfg.Generation.MassNebMax)
	placedAst := placeN(cfg.Generation.NumAsteroidFields,  TypeAsteroidField, cfg.Generation.MassAstMin, cfg.Generation.MassAstMax)

	fmt.Printf("  Stars: %d/%d\n", len(objects)-placedBH-placedNeb-placedAst, cfg.Generation.NumStars)
	fmt.Printf("  Black holes: %d/%d\n", placedBH, cfg.Generation.NumBlackHoles)
	fmt.Printf("  Nebulae: %d/%d\n", placedNeb, cfg.Generation.NumNebulae)
	fmt.Printf("  Asteroid fields: %d/%d\n", placedAst, cfg.Generation.NumAsteroidFields)

	// Stats
	stats := GalaxyStats{
		TotalObjects:    len(objects),
		CountByType:     map[string]int{},
		CountByStarType: map[string]int{},
	}
	for _, o := range objects {
		stats.TotalMass += o.Mass
		stats.CountByType[string(o.Type)]++
		if o.Type == TypeStar {
			stats.CountByStarType[string(o.StarType)]++
		}
	}

	return Galaxy{Seed: seed, Objects: objects, Stats: stats, RotationDir: rotDir}
}

// ============================================================
// MAIN
// ============================================================

func main() {
	seedFlag := flag.Int64("seed", -1, "Galaxy seed (-1 = use config.json value)")
	configPath := flag.String("config", "config.json", "Path to config.json")
	outputPath := flag.String("out", "galaxy.json", "Output path for galaxy.json")
	flag.Parse()

	cfg, err := loadConfig(*configPath)
	if err != nil {
		fmt.Println("Error:", err)
		os.Exit(1)
	}

	seed := cfg.Generation.Seed
	if *seedFlag >= 0 {
		seed = *seedFlag
	}

	fmt.Printf("Generating galaxy with seed %d ...\n", seed)
	galaxy := generateGalaxy(seed, &cfg)

	data, _ := json.MarshalIndent(galaxy, "", "  ")
	if err := os.WriteFile(*outputPath, data, 0644); err != nil {
		fmt.Println("Error:", err)
		os.Exit(1)
	}

	fmt.Printf("\nTotal objects: %d\n", galaxy.Stats.TotalObjects)
	fmt.Printf("Total mass:    %d\n", galaxy.Stats.TotalMass)
	fmt.Printf("Saved to %s\n", *outputPath)
}
