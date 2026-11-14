// Таблица компонентов — СОБРАНА АВТОМАТОМ из tools/parts-balance.js, правки сюда бессмысленны.
// Числа влияния и сжигания топлива — из таблицы пользователя; состав и места оборудования —
// настройка по умолчанию. Это только НАЧАЛЬНОЕ заполнение: всё правится на странице.
const PARTS_PRESET = {
 "v": 3,
 "params": [
  {
   "key": "mass",
   "name": "Масса",
   "unit": "т",
   "role": "mass"
  },
  {
   "key": "dur",
   "name": "Прочность",
   "unit": "",
   "role": "dur"
  },
  {
   "key": "heat",
   "name": "Термостойкость",
   "unit": "",
   "role": "heat"
  },
  {
   "key": "rad",
   "name": "Радиозащита",
   "unit": "",
   "role": "rad"
  },
  {
   "key": "thrust",
   "name": "Тяга",
   "unit": "",
   "role": "thrust"
  },
  {
   "key": "turn",
   "name": "Угол поворота",
   "unit": "°/с",
   "role": "turn"
  },
  {
   "key": "enPassive",
   "name": "Пассивное потребление",
   "unit": "за цикл",
   "role": "enPassive"
  },
  {
   "key": "enActive",
   "name": "Активное потребление",
   "unit": "за цикл",
   "role": "enActive"
  },
  {
   "key": "enGen",
   "name": "Выработка энергии",
   "unit": "за цикл",
   "role": "enGen"
  },
  {
   "key": "durRegen",
   "name": "Восстановление прочности",
   "unit": "за цикл",
   "role": "repair"
  },
  {
   "key": "capSolid",
   "name": "Грузовая ёмкость твёрдое",
   "unit": "ед.",
   "role": "cap"
  },
  {
   "key": "capGas",
   "name": "Грузовая ёмкость газовая",
   "unit": "ед.",
   "role": "cap"
  },
  {
   "key": "capEnergy",
   "name": "Ёмкость аккумулятора",
   "unit": "ед.",
   "role": "enCap"
  },
  {
   "key": "lifeSup",
   "name": "Запас жизнеобеспечения",
   "unit": "циклов",
   "role": "life"
  },
  {
   "key": "dmgPhys",
   "name": "Урон физический",
   "unit": "",
   "role": "dmg"
  },
  {
   "key": "dmgRad",
   "name": "Урон радиоактивный",
   "unit": "",
   "role": "dmg"
  },
  {
   "key": "dmgHeat",
   "name": "Урон тепловой",
   "unit": "",
   "role": "dmg"
  },
  {
   "key": "fireRange",
   "name": "Дальность стрельбы",
   "unit": "ед.",
   "role": "fire"
  },
  {
   "key": "radar",
   "name": "Дальность радара",
   "unit": "ед.",
   "role": "range"
  },
  {
   "key": "ecmPower",
   "name": "Мощность РЭБ воздействия",
   "unit": "",
   "role": "ecm"
  },
  {
   "key": "ecmFreq",
   "name": "РЭБ частот",
   "unit": ""
  },
  {
   "key": "ecmDef",
   "name": "РЭБ защита",
   "unit": "",
   "role": "ecmDef"
  },
  {
   "key": "overheat",
   "name": "Перегрев",
   "unit": ""
  },
  {
   "key": "cooldown",
   "name": "Остывание",
   "unit": ""
  }
 ],
 "seeded": [
  "mass",
  "dur",
  "heat",
  "rad",
  "thrust",
  "turn",
  "enPassive",
  "enActive",
  "enGen",
  "durRegen",
  "capSolid",
  "capGas",
  "capEnergy",
  "lifeSup",
  "dmgPhys",
  "dmgRad",
  "dmgHeat",
  "fireRange",
  "radar",
  "ecmPower",
  "ecmFreq",
  "ecmDef",
  "overheat",
  "cooldown"
 ],
 "slots": {
  "weapon_mount": [
   "mass",
   "dur",
   "heat",
   "rad",
   null,
   null,
   null,
   null,
   null,
   null
  ],
  "frame": [
   "mass",
   "dur",
   "heat",
   "rad",
   null,
   null,
   null,
   null,
   null,
   null
  ],
  "ecm": [
   "mass",
   "dur",
   "heat",
   "rad",
   "ecmPower",
   "ecmDef",
   "ecmFreq",
   "enPassive",
   null,
   null
  ],
  "engine": [
   "mass",
   "dur",
   "heat",
   "rad",
   "thrust",
   "turn",
   "enActive",
   "capEnergy",
   null,
   null
  ],
  "engine_ion": [
   "mass",
   "dur",
   "heat",
   "rad",
   "thrust",
   "turn",
   "enActive",
   "capEnergy",
   null,
   null
  ],
  "solar_sail": [
   "mass",
   "dur",
   "heat",
   "rad",
   "thrust",
   "enGen",
   "capEnergy",
   null,
   null,
   null
  ],
  "reactor": [
   "mass",
   "dur",
   "heat",
   "rad",
   "enGen",
   "capEnergy",
   "overheat",
   null,
   null,
   null
  ],
  "gas_storage": [
   "mass",
   "dur",
   "heat",
   "rad",
   "capGas",
   "capEnergy",
   null,
   null,
   null,
   null
  ],
  "battery": [
   "mass",
   "dur",
   "heat",
   "rad",
   "capEnergy",
   null,
   null,
   null,
   null,
   null
  ],
  "gun_autocannon": [
   "mass",
   "dur",
   "heat",
   "rad",
   "dmgPhys",
   "fireRange",
   "enActive",
   "overheat",
   null,
   null
  ],
  "gun_railgun": [
   "mass",
   "dur",
   "heat",
   "rad",
   "dmgPhys",
   "fireRange",
   "enActive",
   "overheat",
   null,
   null
  ],
  "gun_laser": [
   "mass",
   "dur",
   "heat",
   "rad",
   "dmgHeat",
   "dmgRad",
   "fireRange",
   "enActive",
   "overheat",
   null
  ],
  "gun_plasma": [
   "mass",
   "dur",
   "heat",
   "rad",
   "dmgRad",
   "dmgPhys",
   "fireRange",
   "overheat",
   "enActive",
   null
  ],
  "gun_missile": [
   "mass",
   "dur",
   "heat",
   "rad",
   "dmgPhys",
   "fireRange",
   "enActive",
   "overheat",
   null,
   null
  ],
  "gun_torpedo": [
   "mass",
   "dur",
   "heat",
   "rad",
   "dmgPhys",
   "fireRange",
   "enActive",
   "overheat",
   null,
   null
  ],
  "life_support": [
   "mass",
   "dur",
   "heat",
   "rad",
   "lifeSup",
   "enPassive",
   null,
   null,
   null,
   null
  ],
  "colonist": [
   "mass",
   "dur",
   "heat",
   "rad",
   "capSolid",
   "enPassive",
   null,
   null,
   null,
   null
  ],
  "radar": [
   "mass",
   "dur",
   "heat",
   "rad",
   "radar",
   "enPassive",
   null,
   null,
   null,
   null
  ],
  "computer": [
   "mass",
   "dur",
   "heat",
   "rad",
   "ecmDef",
   "enActive",
   null,
   null,
   null,
   null
  ],
  "teleport": [
   "mass",
   "dur",
   "heat",
   "rad",
   "enActive",
   null,
   null,
   null,
   null,
   null
  ],
  "miner": [
   "mass",
   "dur",
   "heat",
   "rad",
   "enActive",
   "capSolid",
   null,
   null,
   null,
   null
  ],
  "repair": [
   "mass",
   "dur",
   "heat",
   "rad",
   "durRegen",
   "enActive",
   null,
   null,
   null,
   null
  ],
  "cargo": [
   "mass",
   "dur",
   "heat",
   "rad",
   "capSolid",
   null,
   null,
   null,
   null,
   null
  ],
  "hangar": [
   "mass",
   "dur",
   "heat",
   "rad",
   "capSolid",
   "enPassive",
   null,
   null,
   null,
   null
  ]
 },
 "inf": {
  "struct": {
   "mass": [
    10,
    12,
    16
   ],
   "dur": [
    3,
    2,
    5
   ],
   "heat": [
    2,
    1,
    3
   ],
   "rad": [
    1,
    3,
    2
   ],
   "thrust": [
    100,
    200,
    300
   ],
   "turn": [
    2,
    2,
    2
   ],
   "enPassive": [
    0,
    0,
    0
   ],
   "enActive": [
    0,
    0,
    0
   ],
   "enGen": [
    10,
    20,
    30
   ],
   "durRegen": [
    1,
    2,
    3
   ],
   "capSolid": [
    1000,
    1500,
    2000
   ],
   "capGas": [
    100,
    150,
    200
   ],
   "capEnergy": [
    200,
    300,
    500
   ],
   "lifeSup": [
    1,
    1,
    1
   ],
   "dmgPhys": [
    4,
    6,
    10
   ],
   "dmgRad": [
    0,
    0,
    0
   ],
   "dmgHeat": [
    0,
    0,
    0
   ],
   "fireRange": [
    50,
    80,
    120
   ],
   "radar": [
    20,
    30,
    50
   ],
   "ecmPower": [
    0,
    0,
    0
   ],
   "ecmFreq": [
    0,
    0,
    0
   ],
   "ecmDef": [
    20,
    30,
    50
   ],
   "overheat": [
    1,
    2,
    3
   ],
   "cooldown": [
    1,
    1,
    2
   ]
  },
  "compute": {
   "mass": [
    5,
    15,
    12
   ],
   "dur": [
    0,
    1,
    3
   ],
   "heat": [
    1,
    0,
    0
   ],
   "rad": [
    0,
    0,
    2
   ],
   "thrust": [
    100,
    300,
    800
   ],
   "turn": [
    2,
    3,
    5
   ],
   "enPassive": [
    6,
    4,
    2
   ],
   "enActive": [
    12,
    8,
    4
   ],
   "enGen": [
    4,
    20,
    100
   ],
   "durRegen": [
    2,
    3,
    5
   ],
   "capSolid": [
    0,
    0,
    0
   ],
   "capGas": [
    0,
    0,
    0
   ],
   "capEnergy": [
    100,
    200,
    300
   ],
   "lifeSup": [
    1,
    2,
    3
   ],
   "dmgPhys": [
    1,
    2,
    3
   ],
   "dmgRad": [
    0,
    1,
    2
   ],
   "dmgHeat": [
    2,
    3,
    6
   ],
   "fireRange": [
    200,
    400,
    800
   ],
   "radar": [
    300,
    600,
    1200
   ],
   "ecmPower": [
    150,
    300,
    600
   ],
   "ecmFreq": [
    1,
    2,
    3
   ],
   "ecmDef": [
    60,
    120,
    240
   ],
   "overheat": [
    2,
    3,
    5
   ],
   "cooldown": [
    0,
    0,
    0
   ]
  },
  "bio": {
   "mass": [
    5,
    7,
    9
   ],
   "dur": [
    0,
    0,
    2
   ],
   "heat": [
    0,
    0,
    3
   ],
   "rad": [
    0,
    0,
    5
   ],
   "thrust": [
    50,
    100,
    200
   ],
   "turn": [
    1,
    1,
    2
   ],
   "enPassive": [
    8,
    3,
    1
   ],
   "enActive": [
    24,
    9,
    3
   ],
   "enGen": [
    20,
    30,
    50
   ],
   "durRegen": [
    20,
    30,
    50
   ],
   "capSolid": [
    0,
    0,
    0
   ],
   "capGas": [
    0,
    0,
    0
   ],
   "capEnergy": [
    100,
    200,
    300
   ],
   "lifeSup": [
    2,
    3,
    5
   ],
   "dmgPhys": [
    0,
    0,
    0
   ],
   "dmgRad": [
    0,
    0,
    0
   ],
   "dmgHeat": [
    0,
    0,
    0
   ],
   "fireRange": [
    0,
    0,
    0
   ],
   "radar": [
    0,
    0,
    0
   ],
   "ecmPower": [
    20,
    30,
    50
   ],
   "ecmFreq": [
    0,
    0,
    0
   ],
   "ecmDef": [
    0,
    0,
    0
   ],
   "overheat": [
    0,
    0,
    0
   ],
   "cooldown": [
    2,
    3,
    5
   ]
  },
  "energy": {
   "mass": [
    3,
    4,
    10
   ],
   "dur": [
    0,
    0,
    0
   ],
   "heat": [
    0,
    0,
    0
   ],
   "rad": [
    0,
    0,
    0
   ],
   "thrust": [
    0,
    0,
    300
   ],
   "turn": [
    0,
    0,
    4
   ],
   "enPassive": [
    0,
    0,
    0
   ],
   "enActive": [
    0,
    0,
    0
   ],
   "enGen": [
    0,
    0,
    500
   ],
   "durRegen": [
    0,
    0,
    0
   ],
   "capSolid": [
    0,
    0,
    0
   ],
   "capGas": [
    0,
    0,
    0
   ],
   "capEnergy": [
    100,
    200,
    300
   ],
   "lifeSup": [
    0,
    0,
    0
   ],
   "dmgPhys": [
    0,
    0,
    20
   ],
   "dmgRad": [
    2,
    6,
    30
   ],
   "dmgHeat": [
    1,
    3,
    10
   ],
   "fireRange": [
    0,
    0,
    500
   ],
   "radar": [
    0,
    0,
    400
   ],
   "ecmPower": [
    0,
    0,
    200
   ],
   "ecmFreq": [
    0,
    0,
    1
   ],
   "ecmDef": [
    0,
    0,
    100
   ],
   "overheat": [
    0,
    0,
    10
   ],
   "cooldown": [
    0,
    0,
    0
   ]
  }
 },
 "comp": {
  "weapon_mount": {
   "struct": 3,
   "compute": 1,
   "bio": 0,
   "energy": 0
  },
  "frame": {
   "struct": 8,
   "compute": 0,
   "bio": 0,
   "energy": 0
  },
  "ecm": {
   "struct": 1,
   "compute": 3,
   "bio": 1,
   "energy": 0
  },
  "engine": {
   "struct": 3,
   "compute": 1,
   "bio": 1,
   "energy": 1
  },
  "engine_ion": {
   "struct": 3,
   "compute": 3,
   "bio": 0,
   "energy": 5
  },
  "solar_sail": {
   "struct": 1,
   "compute": 1,
   "bio": 1,
   "energy": 0
  },
  "reactor": {
   "struct": 4,
   "compute": 3,
   "bio": 0,
   "energy": 4
  },
  "gas_storage": {
   "struct": 2,
   "compute": 0,
   "bio": 1,
   "energy": 1
  },
  "battery": {
   "struct": 1,
   "compute": 1,
   "bio": 0,
   "energy": 2
  },
  "gun_autocannon": {
   "struct": 4,
   "compute": 1,
   "bio": 0,
   "energy": 0
  },
  "gun_railgun": {
   "struct": 3,
   "compute": 1,
   "bio": 0,
   "energy": 1
  },
  "gun_laser": {
   "struct": 2,
   "compute": 2,
   "bio": 0,
   "energy": 2
  },
  "gun_plasma": {
   "struct": 2,
   "compute": 1,
   "bio": 1,
   "energy": 1
  },
  "gun_missile": {
   "struct": 4,
   "compute": 1,
   "bio": 0,
   "energy": 1
  },
  "gun_torpedo": {
   "struct": 3,
   "compute": 1,
   "bio": 1,
   "energy": 1
  },
  "life_support": {
   "struct": 2,
   "compute": 1,
   "bio": 2,
   "energy": 0
  },
  "colonist": {
   "struct": 3,
   "compute": 1,
   "bio": 3,
   "energy": 0
  },
  "radar": {
   "struct": 1,
   "compute": 2,
   "bio": 0,
   "energy": 1
  },
  "computer": {
   "struct": 1,
   "compute": 3,
   "bio": 0,
   "energy": 1
  },
  "teleport": {
   "struct": 2,
   "compute": 3,
   "bio": 0,
   "energy": 3
  },
  "miner": {
   "struct": 4,
   "compute": 1,
   "bio": 0,
   "energy": 1
  },
  "repair": {
   "struct": 2,
   "compute": 2,
   "bio": 1,
   "energy": 0
  },
  "cargo": {
   "struct": 3,
   "compute": 0,
   "bio": 1,
   "energy": 0
  },
  "hangar": {
   "struct": 5,
   "compute": 1,
   "bio": 1,
   "energy": 0
  }
 },
 "fuel": [
  100,
  300,
  800
 ],
 "build": "2026-11-13 21:29"
};
