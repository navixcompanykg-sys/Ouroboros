// Пульс экономики на экранах, где нет панели колонии (карта системы и карта галактики).
// Колонии добывают сами по тактам реального времени, корабль ест пищу где бы ни был — значит и
// оповещения («трюм забит», «жизнеобеспечение истощено больше чем наполовину») должны доходить
// до игрока, пока он летит в другом месте. Щелчок по оповещению ведёт к кораблю (js/notify.js).
//
// Раз в пять секунд: догнать активный корабль и все колонии. Поверхности колоний
// пересоздаются из seed (generateSurface) и кэшируются — в хранилище они не лежат.
(() => {
  if (typeof Colony === 'undefined' || typeof Ship === 'undefined') return;
  let tbl = null;
  const surfaces = {};

  function surfaceOf(star, planet) {
    const k = star + ':' + planet;
    if (surfaces[k] !== undefined) return surfaces[k];
    const gstar = World.galaxy().stars[star];
    if (!gstar) return (surfaces[k] = null);
    const p = generateSystem(gstar).planets[planet];
    return (surfaces[k] = p ? generateSurface(p, gstar) : null);
  }

  function beat() {
    if (!tbl) return;
    const now = Date.now();
    const ship = World.active();
    // Корабль: добыча идёт только там, где он сел; здесь поверхности нет — значит только пища.
    const r = Ship.advance(tbl, ship, null, now);
    if (r.full) Notify.shipAlert(ship, 'full', 'Трюм забит: ' + (ship.design || 'корабль') + ' #' + ship.id + ' больше не берёт добычу', '');
    else Notify.drop('ship' + ship.id + ':full');
    if (r.justLow) Notify.shipAlert(ship, 'low',
      'Жизнеобеспечение ' + (ship.design || 'корабль') + ' #' + ship.id + ' истощено больше чем наполовину — нужно пополнить пищей', 'bad');
    if (!r.low) Notify.drop('ship' + ship.id + ':low');

    for (const { star, planet, col } of World.colonyList()) {
      const surf = surfaceOf(star, planet);
      if (surf) Colony.advance(col, surf, now);
    }
    World.save();
  }

  Store.load('parts').then(got => {
    tbl = loadParts(got.data);
    Colony.setHoldUnit(partParam(tbl, 'cargo', 'capSolid', 1) + partParam(tbl, 'cargo', 'capGas', 1));
    beat();
  });
  setInterval(beat, 5000);
})();
