package main

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"os"
)

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

	CenterX     = 50.0
	CenterY     = 50.0
	GalaxyR     = 50.0
	ChaosR      = 2.0
	MinDist     = 1.2 // min distance between objects
	NumRays     = 40
	NumStars    = 2000
	NumBH       = 20
	NumNebulae  = 200
	NumAsteroid = 800
)

var starsOnRay = [10]int{1, 2, 3, 4, 5, 7, 9, 8, 6, 5}

var starTypeProbs = [5][4]float64{
	{0.00, 0.10, 0.85, 0.05},
	{0.15, 0.25, 0.55, 0.05},
	{0.05, 0.35, 0.55, 0.05},
	{0.00, 0.20, 0.75, 0.05},
	{0.00, 0.10, 0.85, 0.05},
}

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

// --- Spatial grid ---
type Grid struct {
	cells    map[[2]int][][2]float64
	cellSize float64
}

func newGrid() *Grid {
	return &Grid{cells: map[[2]int][][2]float64{}, cellSize: MinDist}
}

func (g *Grid) key(x, y float64) [2]int {
	return [2]int{int(math.Floor(x / g.cellSize)), int(math.Floor(y / g.cellSize))}
}

func (g *Grid) isFree(x, y float64) bool {
	ck := g.key(x, y)
	minD2 := MinDist * MinDist
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

// --- Helpers ---
func dist2(x1, y1, x2, y2 float64) float64 {
	return math.Sqrt((x2-x1)*(x2-x1) + (y2-y1)*(y2-y1))
}

func inGalaxy(x, y float64) bool   { return dist2(x, y, CenterX, CenterY) <= GalaxyR }
func inChaos(x, y float64) bool    { return dist2(x, y, CenterX, CenterY) < ChaosR }
func ok(x, y float64, g *Grid) bool { return inGalaxy(x, y) && !inChaos(x, y) && g.isFree(x, y) }

func velocity(x, y, rotDir float64) (vx, vy float64) {
	theta := math.Atan2(y-CenterY, x-CenterX)
	r := dist2(x, y, CenterX, CenterY)
	if r < 0.01 {
		return
	}
	period := 14.0 + (365.0-14.0)*(r-2.0)/48.0
	v := 2 * math.Pi * r / period
	vx = -rotDir * v * math.Sin(theta)
	vy = rotDir * v * math.Cos(theta)
	return
}

func pickStarType(r float64, rng *rand.Rand) StarType {
	band := int(r/10.0)
	if band > 4 { band = 4 }
	probs := starTypeProbs[band]
	roll, cum := rng.Float64(), 0.0
	types := []StarType{StarBlueGiant, StarYellowDwarf, StarRedDwarf, StarWhiteDwarf}
	for i, p := range probs {
		cum += p
		if roll < cum { return types[i] }
	}
	return StarRedDwarf
}

func starMass(st StarType, rng *rand.Rand) int {
	switch st {
	case StarBlueGiant:   return 61 + rng.Intn(40)
	case StarYellowDwarf: return 31 + rng.Intn(30)
	case StarRedDwarf:    return 20 + rng.Intn(11)
	case StarWhiteDwarf:  return 10 + rng.Intn(6)
	}
	return 20
}

// --- Generation ---
func generateGalaxy(seed int64) Galaxy {
	rng := rand.New(rand.NewSource(seed))
	rotDir := 1.0
	if rng.Intn(2) == 0 { rotDir = -1.0 }

	objects := []GalaxyObject{}
	grid := newGrid()
	id := 0

	add := func(obj GalaxyObject) {
		obj.ID = id
		objects = append(objects, obj)
		grid.add(obj.X, obj.Y)
		id++
	}

	makeObj := func(x, y float64, t ObjectType, st StarType, mass int) GalaxyObject {
		r := dist2(x, y, CenterX, CenterY)
		theta := math.Atan2(y-CenterY, x-CenterX)
		vx, vy := velocity(x, y, rotDir)
		return GalaxyObject{Type: t, StarType: st, X: x, Y: y, Mass: mass, R: r, Theta: theta, VX: vx, VY: vy}
	}

	// Random point uniformly distributed inside galaxy circle
	randInGalaxy := func() (float64, float64) {
		angle := rng.Float64() * 2 * math.Pi
		radius := math.Sqrt(rng.Float64()) * GalaxyR
		return CenterX + radius*math.Cos(angle), CenterY + radius*math.Sin(angle)
	}

	// --- Stars via spiral rays ---
	placed := 0
	for i := 0; i < NumRays; i++ {
		phi := float64(i) * math.Pi / 20.0
		for j := 0; j < 10; j++ {
			minR := float64(j) * 5.0
			if j == 0 { minR = ChaosR }
			maxR := float64(j+1) * 5.0
			for s := 0; s < starsOnRay[j]; s++ {
				for attempt := 0; attempt < 40; attempt++ {
					r := minR + rng.Float64()*(maxR-minR)
					delta := (rng.Float64() - 0.5) * (math.Pi / 20.0)
					x := CenterX + r*math.Cos(phi+delta)
					y := CenterY + r*math.Sin(phi+delta)
					if !ok(x, y, grid) { continue }
					st := pickStarType(r, rng)
					add(makeObj(x, y, TypeStar, st, starMass(st, rng)))
					placed++
					break
				}
			}
		}
	}

	// Fill missing stars
	for missing := NumStars - placed; missing > 0; {
		x, y := randInGalaxy()
		if !ok(x, y, grid) { continue }
		r := dist2(x, y, CenterX, CenterY)
		st := pickStarType(r, rng)
		add(makeObj(x, y, TypeStar, st, starMass(st, rng)))
		missing--
	}

	// Generic random placer with attempt limit
	placeN := func(n int, t ObjectType, massLo, massHi int) int {
		placed := 0
		maxTries := n * 500
		for tries := 0; placed < n && tries < maxTries; tries++ {
			x, y := randInGalaxy()
			if !ok(x, y, grid) { continue }
			mass := massLo + rng.Intn(massHi-massLo+1)
			add(makeObj(x, y, t, "", mass))
			placed++
		}
		return placed
	}

	placedBH  := placeN(NumBH,       TypeBlackHole,     101, 150)
	placedNeb := placeN(NumNebulae,   TypeNebula,        1,   2)
	placedAst := placeN(NumAsteroid,  TypeAsteroidField, 3,   9)

	fmt.Printf("  Stars: %d/%d\n", len(objects)-placedBH-placedNeb-placedAst, NumStars)
	fmt.Printf("  Black holes: %d/%d\n", placedBH, NumBH)
	fmt.Printf("  Nebulae: %d/%d\n", placedNeb, NumNebulae)
	fmt.Printf("  Asteroid fields: %d/%d\n", placedAst, NumAsteroid)

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

func main() {
	seed := int64(42)
	fmt.Println("Generating galaxy with seed", seed, "...")
	galaxy := generateGalaxy(seed)

	data, _ := json.MarshalIndent(galaxy, "", "  ")
	if err := os.WriteFile("galaxy.json", data, 0644); err != nil {
		fmt.Println("Error:", err)
		os.Exit(1)
	}

	fmt.Printf("\nTotal objects: %d\n", galaxy.Stats.TotalObjects)
	fmt.Printf("Total mass:    %d\n", galaxy.Stats.TotalMass)
	fmt.Println("Saved to galaxy.json")
}
