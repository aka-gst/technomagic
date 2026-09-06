/*
 * ТЕХНОМАГИЯ — мир: тела, столкновения, оружие, смерть.
 *
 * Здесь нет ни отрисовки, ни ввода. Мир получает намерение игрока
 * (куда идти, куда смотреть, что нажал) и продвигает себя на dt.
 * Что рисовать — решает render.js, что делают враги — ai.js.
 *
 * Главное правило жанра: с одного удара умирают все, включая игрока.
 * Поэтому здоровья нет ни у кого, а есть только «жив» и «лежит».
 *
 * Оружия у игрока нет вовсе — только очередь демонов. Подобрать с пола
 * нечего, бросить нечего: всё, что он умеет, набирается стрелками. У
 * врагов оружие осталось: бита и пистолет — это их роль, а не инвентарь.
 */

import { ENTITY, TILE, TILE_SIZE, blocksMove, blocksSight, blocksShot, breakable, brokenBy } from './level.js';
import { thinkEnemy, buildFlowField } from './ai.js';
import { BY_EVENT } from './trace.js';
import {
  GROUND, createField, updateField, groundAt, groundIndex, burningAt,
  paint, tilesInCircle, tilesInCone, tilesAlongLine,
  conductedTiles, conducts, cloudsBlock, addCloud,
  SPILL, JOLT, FLARE, BURN_TIME, WET_TIME, CHAIN_HOP,
} from './field.js';
import { spellOf, STACK_LIMIT, CHARGE_STEP, colourOf, ELEMENT_ORDER } from './magic.js';
import { createOperation, updateOperation } from './operation.js';

export { TILE_SIZE };

/* Радиус тела одинаков у всех: попадание должно читаться на глаз. */
export const BODY = 9;

/*
 * Чем воюют враги. Огнестрела здесь больше нет ни у кого: те, кто держал
 * дистанцию, швыряются той же магией, что и игрок, — только одной стихией
 * и без очереди. Так вся игра говорит на одном языке, и по цвету снаряда
 * сразу видно, чем этого брать нельзя.
 */
export const WEAPONS = {
  bat: {
    id: 'bat', name: 'БИТА', kind: 'melee',
    reach: 38, arc: 2.0, cooldown: 0.27, lethal: true, noise: 110,
  },
  hex: {
    id: 'hex', name: 'ПОРЧА', kind: 'gun',
    cooldown: 0.9, clip: 99, speed: 560, spread: 0.05, noise: 380,
  },
};

/*
 * Темп. Игра про то, что всё решается за секунду, поэтому разгон почти
 * мгновенный: между нажатием и движением не должно быть ничего, что
 * чувствуется. Враг бежит заметно медленнее игрока — убегать можно, но
 * от пули это не спасает.
 */
/*
 * Общий темп. Одно число на всех, кто ходит по этажу, и правится оно
 * только здесь: разъехавшись, скорости игрока и врагов ломают не
 * ощущение, а расчёт — расстояние, на котором успеваешь набрать очередь,
 * держится ровно на их отношении.
 *
 * Изометрия попросила сбавить. Сверху скорость читалась по клеткам, а в
 * ромбе тот же путь выглядит длиннее и проходится будто рывком: глаз не
 * успевает за фигурой, и бой превращается в дёрганье.
 */
const PACE = 0.76;

const PLAYER_SPEED = 252 * PACE;
const PLAYER_ACCEL = 3600 * PACE;
const ENEMY_WALK = 70 * PACE;
const ENEMY_RUN = 152 * PACE;
const DOWN_TIME = 2;

/*
 * Сон от одиночной стихии длится дольше сбитого с ног: вырубленный
 * должен успеть побыть решением, а не заминкой. Точное число ищется
 * замером — оба исхода, «унёс ноги» и «не успел», обязаны остаться в
 * ходу. Слишком долго — убивать станет незачем; слишком коротко —
 * вырубать станет незачем.
 */
const SLEEP_TIME = 9;
const IMPACT_LETHAL = 220;

/*
 * ЗАМЕДЛЕНИЕ — ПО ПРИЗНАКУ, А НЕ ПО СПИСКУ
 * =========================================================
 * Список «замедлять на бочке, на цепи и на стене» пришлось бы вести
 * вечно, и он бы врал: то же самое, собранное игроком впервые и
 * случайно, ничем не хуже. Признак вместо списка называет не событие, а
 * положение дел — «ты что-то устроил, и оно доигралось без тебя»:
 *
 *   1. три РАЗНЫХ правила мира сработали подряд, внутри одного окна;
 *   2. последнее из них тронуло живого;
 *   3. и добил не твой снаряд, а последствие — цепь, огонь, тело, стена.
 *
 * Третье условие и есть весь смысл. Прямое попадание игрок и так видел:
 * он в него целился. Показывать надо то, чего он не выбирал, — иначе
 * замедление превращается в паузу после каждого выстрела.
 */
const SLOW_WINDOW = 0.9;   /* за столько секунд должны уложиться три правила */
const SLOW_TIME = 0.55;    /* столько длится само замедление */
const SLOW_SCALE = 0.35;   /* во столько раз медленнее идёт мир */

/* Последствия, а не прямые попадания: добил мир, а не снаряд. */
const NOT_YOURS = new Set(['chain', 'fire', 'fling', 'slam']);

/* Событие тронуло живого, а не обстановку. */
const TOUCHED_ALIVE = new Set(['kill', 'sleep', 'knock', 'held', 'ignite']);
const BULLET_LIFE = 1.6;


/* =========================================================
   МЕЛОЧИ
   ========================================================= */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function turnToward(from, to, step) {
  const d = angleDelta(from, to);
  return from + clamp(d, -step, step);
}

function rand(a, b) { return a + Math.random() * (b - a); }


/* =========================================================
   СЕТКА
   ========================================================= */

export function tileAt(world, x, y) {
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  if (tx < 0 || ty < 0 || tx >= world.w || ty >= world.h) return TILE.WALL;
  return world.tiles[ty * world.w + tx];
}

export function tileIndex(world, x, y) {
  const tx = clamp(Math.floor(x / TILE_SIZE), 0, world.w - 1);
  const ty = clamp(Math.floor(y / TILE_SIZE), 0, world.h - 1);
  return ty * world.w + tx;
}

function solidAt(world, x, y) {
  return blocksMove(tileAt(world, x, y));
}

/*
 * Тело двигается по осям раздельно: так оно скользит вдоль стены, а не
 * залипает в углу. Раздельность важнее точности — в дверном проёме
 * шириной в клетку игрок иначе застревает и умирает не по своей вине.
 */
/*
 * ИМПУЛЬС ЛЕТЯЩЕГО ТЕЛА
 * =========================================================
 * Тело, которое летит, — снаряд. Не «трупы от бочки сбивают соседей», а
 * общее правило: во что попало, тому и передалось. Разница
 * принципиальная. Частный случай — украшение, красивое один раз; общее
 * правило даёт игроку новый глагол — швырять врагов друг в друга, — и
 * порождает решения, которых никто не задумывал.
 *
 * Порог низкий намеренно, и это безопасно: сюда попадают только тела,
 * которые уже летят — отброшенные и мёртвые. Бегущий своим ходом враг в
 * эту ветку не заходит вовсе, поэтому случайных столкновений на бегу не
 * будет даже при скорости вдвое выше порога.
 *
 * Высокий порог пробовался первым и не работал: тело тормозит быстрее,
 * чем долетает, и к моменту касания скорость успевала упасть ниже
 * порога — снаряд честно долетал и вежливо останавливался.
 */
const FLING_SPEED = 105;

function fling(world, mover, from) {
  const speed = Math.hypot(mover.vx || 0, mover.vy || 0);
  if (speed < FLING_SPEED) return;

  const angle = Math.atan2(mover.vy, mover.vx);

  for (const body of [world.player, ...world.enemies]) {
    if (body === mover || body === from || !body.alive) continue;
    if (Math.hypot(body.x - mover.x, body.y - mover.y) > BODY * 2) continue;

    /* Половина скорости уходит дальше, в того, кого сбили. */
    body.vx = (body.vx || 0) + Math.cos(angle) * speed * 0.5;
    body.vy = (body.vy || 0) + Math.sin(angle) * speed * 0.5;
    body.stagger = Math.max(body.stagger || 0, 0.4);
    body.shove = Math.max(body.shove || 0, 0.4);

    world.fx.shake = Math.max(world.fx.shake, 5);
    world.events.push({ type: 'fling' });

    if (body === world.player) {
      killPlayer(world, angle);
    } else {
      killEnemy(world, body, angle, 'fling',
        { by: 'player', weapon: 'body', elements: [] });
    }

    /* Летящее тело тормозит о того, кого снесло. */
    mover.vx *= 0.4;
    mover.vy *= 0.4;
    return;
  }
}

function moveBody(world, body, dx, dy) {
  const r = BODY;
  const было = Math.hypot(body.vx || 0, body.vy || 0);
  let вСтену = false;

  if (dx) {
    const nx = body.x + dx;
    const edge = nx + Math.sign(dx) * r;
    if (!solidAt(world, edge, body.y - r + 1) && !solidAt(world, edge, body.y + r - 1)) {
      body.x = nx;
    } else {
      if (Math.abs(body.vx || 0) > 1) вСтену = true;
      body.vx = 0;
    }
  }

  if (dy) {
    const ny = body.y + dy;
    const edge = ny + Math.sign(dy) * r;
    if (!solidAt(world, body.x - r + 1, edge) && !solidAt(world, body.x + r - 1, edge)) {
      body.y = ny;
    } else {
      if (Math.abs(body.vy || 0) > 1) вСтену = true;
      body.vy = 0;
    }
  }

  /*
   * Стена — то же тело, только неподвижное. Летящий в неё получает то же,
   * что получил бы, влетев в живого: правило одно, иначе стена оказалась
   * бы мягче человека.
   *
   * Отсюда и берётся смысл льда. До сих пор скольжение отнимало
   * управление и больше ничего: съехал — и съехал. Теперь замороженный
   * пол плюс толчок дают связку, которой никто не задумывал: разогнать
   * врага в стену, ни разу его не коснувшись.
   *
   * А вот порог не тот же, и первая попытка на этом и легла. Я взял
   * общий порог с тела в тело и убил игрока о первую же стену: своим
   * ходом он идёт двести пятьдесят два, вдвое выше порога. Бот погибал
   * на каждом этаже, не сделав ни выстрела.
   *
   * Считается не скорость, а то, **своим ли ходом** тело её набрало.
   * Брошенному хватает общего порога; идущему сам — нужна скорость,
   * какой он не развивает никогда.
   */
  const брошено = (body.shove || 0) > 0;
  const скользит = body !== world.player && groundAt(world, body.x, body.y) === GROUND.ICE;
  if (вСтену && было >= ((брошено || скользит) ? FLING_SPEED : 300)) {
    slam(world, body, было);
  }
}

/*
 * Переключить питание этажа. Силовые двери меняются самой плиткой, а не
 * флагом: клетка, которая меняется, говорит правду всем сразу — и поиску
 * пути, и конусу зрения, и полёту снаряда, — без единой новой проверки.
 */
export function setPower(world, on) {
  if (world.powered === on) return;
  world.powered = on;

  const from = on ? TILE.FORCE_OFF : TILE.FORCE;
  const to = on ? TILE.FORCE : TILE.FORCE_OFF;
  let changed = 0;

  for (let i = 0; i < world.tiles.length; i += 1) {
    if (world.tiles[i] !== from) continue;
    world.tiles[i] = to;
    changed += 1;
  }

  if (changed) {
    world.rebake = true;
    creditConsequence(world, 'power');
    world.events.push({ type: 'power', on, doors: changed });
  }
}

/*
 * Системная комната считает не нажимания, а изменения мира. Обычным этажам
 * этот счётчик не нужен: для них он остаётся null и не меняет их HUD.
 */
function creditConsequence(world, kind, x = null, y = null) {
  if (!world.systemic) return;
  world.systemic.actions += 1;
  world.systemic.last = kind;
  world.events.push({ type: 'consequence', kind, actions: world.systemic.actions, x, y });
}

function raiseOperationAlarm(world, cause, engage = false) {
  if (engage) {
    if (world.engaged) return false;
    world.engaged = true;
  }
  if (world.operation) world.operation.alerts += 1;
  world.events.push({ type: engage ? 'engaged' : 'alarm', cause });
  return true;
}

function slam(world, body, speed) {
  if (!body.alive) return;

  const angle = Math.atan2(body.vy || 0, body.vx || 0);
  world.fx.shake = Math.max(world.fx.shake, 5);
  world.events.push({ type: 'slam', speed: Math.round(speed) });

  resolveBodyImpact(world, body, speed, angle);
}

export function resolveBodyImpact(world, body, speed, angle = 0) {
  if (!body.alive || speed < FLING_SPEED) return false;

  if (body === world.player) {
    killPlayer(world, angle);
    return true;
  }

  const lethalAt = body.brittle > 0 ? 180 : IMPACT_LETHAL;
  if (speed < lethalAt && world.enemies.includes(body)) {
    knockDown(world, body, angle);
    return true;
  }

  if (world.enemies.includes(body)) {
    killEnemy(world, body, angle, 'slam',
      { by: 'player', weapon: 'wall', elements: [] });
    return true;
  }

  if (world.civilians.includes(body) || body === world.hostage) {
    if (speed < lethalAt) {
      body.downed = Number.POSITIVE_INFINITY;
      body.state = 'down';
      world.events.push({ type: 'neutral-knock', kind: body.kind });
    } else {
      killNeutral(world, body, angle, 'slam');
    }
    return true;
  }

  return false;
}

function killNeutral(world, body, angle, cause) {
  if (!body.alive) return;
  body.alive = false;
  body.downed = 0;
  body.unconscious = false;
  world.corpses.push({
    x: body.x, y: body.y, angle: body.angle || angle, kind: body.kind,
    twitch: 0, fall: 0.34, sheet: body.kind, lean: 0,
    vx: body.vx || 0, vy: body.vy || 0, shove: 0, alive: false,
  });
  world.events.push({ type: 'neutral-death', kind: body.kind, cause });
}

function neutralBodies(world) {
  return [...world.civilians, ...(world.hostage ? [world.hostage] : [])];
}

function livingBodies(world) {
  return [...world.enemies, ...neutralBodies(world)].filter((body) => body.alive);
}

function hitNeutral(world, body, angle, cause, source = {}) {
  const traits = source.traits || {};
  const single = source.elements?.length === 1;
  if (traits.gust && single) {
    body.vx = (body.vx || 0) + Math.cos(angle) * 460;
    body.vy = (body.vy || 0) + Math.sin(angle) * 460;
    body.shove = Math.max(body.shove || 0, 0.45);
    world.events.push({ type: 'gust', x: body.x, y: body.y });
    return;
  }
  if (traits.freeze) {
    body.brittle = 3;
    body.downed = Number.POSITIVE_INFINITY;
    body.state = 'down';
    world.events.push({ type: 'frozen', x: body.x, y: body.y });
    return;
  }
  if (traits.wet && single) {
    body.wet = WET_TIME;
    world.events.push({ type: 'soaked', kind: body.kind });
    return;
  }
  if (traits.burn && single) {
    body.burning = BURN_TIME;
    world.events.push({ type: 'ignite', player: false });
    return;
  }
  killNeutral(world, body, angle, cause);
}

function hitLivingBody(world, body, angle, cause, source = {}) {
  if (world.enemies.includes(body)) {
    if (!resisted(world, body, angle, { elements: source.elements })) {
      killEnemy(world, body, angle, cause, source);
    }
  } else {
    hitNeutral(world, body, angle, cause, source);
  }
}

/*
 * Прямая видимость по клеткам (DDA). Стекло намеренно не мешает: сквозь
 * витрину враг вас увидит, и это единственная подсказка, что она там есть.
 */
export function hasSight(world, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const steps = Math.ceil(Math.hypot(dx, dy) / (TILE_SIZE * 0.4));
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    if (blocksSight(tileAt(world, ax + dx * t, ay + dy * t))) return false;
  }

  /*
   * Пар и пыль прячут всех одинаково — и врагов от игрока тоже. Одна
   * дверь на всё зрение: конус врага, наводка, выдох и вспышка ходят
   * через неё же, поэтому «за паром не видно» не приходится помнить в
   * пяти местах, и своим же паром можно ослепить себя.
   */
  return !cloudsBlock(world, ax, ay, bx, by);
}

/*
 * Видно — не значит попадёшь. Мебель низкая: взгляд идёт поверх, снаряд
 * вязнет. Без отдельной проверки колдун за столом всю попытку целится в
 * игрока и расстреливает стол, потому что «видит» его прекрасно, — и это
 * не хитрость, а тупик, из которого он сам не выходит.
 */
export function hasShot(world, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;

  /*
   * Шаг тот же, что у снаряда, и это не мелочь. Проверка шагала вдвое
   * крупнее полёта и потому не замечала углов, которые снаряд задевал:
   * «выстрел свободен» — а он гибнет о скамью. Бот на этом выпустил
   * полторы тысячи зарядов в один и тот же угол, стоя в трёх шагах от
   * цели, и не понял почему. Живой бы решил, что игра сломана.
   */
  const steps = Math.ceil(Math.hypot(dx, dy) / 6);
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    if (blocksShot(tileAt(world, ax + dx * t, ay + dy * t))) return false;
  }
  return true;
}


/* =========================================================
   ЗВУК КАК ИГРОВАЯ СУЩНОСТЬ
   ========================================================= */

/*
 * Выстрел слышно через стены — это плата за пистолет. Кулаки почти
 * бесшумны. Шум не «оповещает всех», а даёт точку, куда враг придёт
 * смотреть: разница между «услышал» и «увидел» и есть весь стелс.
 */
export function emitNoise(world, x, y, radius, source) {
  world.noises.push({ x, y, radius, life: 0.45, max: 0.45 });

  /*
   * Шаги — не преступление. Пока этаж спокоен, на них никто не идёт
   * смотреть: иначе достаточно было пройти мимо, чтобы получить хвост, и
   * тихого прохода не существовало. Как только тревога поднята, шаги
   * снова слышны — тогда за тобой уже честно охотятся.
   */
  if (source === 'step' && !world.engaged) return;

  for (const enemy of world.enemies) {
    if (!enemy.alive || enemy.downed > 0) continue;

    const gap = Math.hypot(enemy.x - x, enemy.y - y);
    if (gap > radius) continue;
    if (enemy.state === 'chase') continue;

    /*
     * Услышанное место тем точнее, чем ближе слушатель. У самого звука
     * идут прямо на него; с края слышимости — примерно в ту сторону.
     * Отсюда и берётся выгода бить издалека: грохот слышали все, а куда
     * бежать, никто толком не знает, и обыск уходит мимо.
     */
    /* Треск самой ловушки ведёт в её центр точно: если страж остановится
       у края, обучающий маршрут случайно исчезнет. Остальные разовые
       звуки сохраняют обычную неопределённость направления. */
    const blur = source === 'hay' ? 0 : (gap / radius) * radius * 0.5;
    const away = Math.random() * Math.PI * 2;
    enemy.heard = {
      x: x + Math.cos(away) * blur * Math.random(),
      y: y + Math.sin(away) * blur * Math.random(),
      origin: { x, y, source },
    };
    enemy.state = 'alert';
    enemy.think = 0;
    if (source === 'player') enemy.suspicion = Math.min(1, enemy.suspicion + 0.6);
  }
}


/* =========================================================
   ЧАСТИЦЫ, КРОВЬ, ГИЛЬЗЫ
   ========================================================= */

/*
 * Брызги по краю растекающейся лужи. Вода в игре — не заливка клетки, а
 * событие: без летящих капель кольцо просто меняет цвет пола, и разлив
 * читается как переключение, а не как течение.
 */
function splash(world, x, y, radius) {
  for (let i = 0; i < 7; i += 1) {
    const a = Math.random() * 6.29;
    const r = radius * (0.7 + Math.random() * 0.35);
    world.particles.push({
      x: x + Math.cos(a) * r, y: y + Math.sin(a) * r,
      vx: Math.cos(a) * 26, vy: Math.sin(a) * 26 - 12,
      life: 0.3, max: 0.3, color: '#5fd6ff', size: 1 + Math.random() * 1.6,
    });
  }
}

function spark(world, x, y, angle, spread, count, color, speed) {
  for (let i = 0; i < count; i += 1) {
    const a = angle + rand(-spread, spread);
    const v = speed * rand(0.4, 1.2);
    world.particles.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      life: rand(0.2, 0.5), max: 0.5, color, size: rand(1, 2.4),
    });
  }
}

/*
 * Кольцо удара. Расходящаяся окружность в точке касания — самый дешёвый
 * способ ответить на вопрос «попал или нет»: она появляется ровно там,
 * где удар что-то нашёл, и только тогда.
 */
function pop(world, x, y, radius, colour) {
  world.pops.push({ x, y, r: radius, max: radius * 2.4, life: 0.22, span: 0.22, colour });
}

function bleed(world, x, y, angle, force) {
  for (let i = 0; i < 22; i += 1) {
    const a = angle + rand(-0.9, 0.9);
    const v = force * rand(0.2, 1.1);
    world.particles.push({
      x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      life: rand(0.25, 0.6), max: 0.6, color: '#ff1450', size: rand(1.5, 3.4), wet: true,
    });
  }

  /*
   * Лужа рисуется один раз и остаётся до конца попытки. Она тут не
   * украшение, а карта: по ней видно, где ты уже был и куда идти не надо.
   */
  world.decals.push({ x, y, r: rand(11, 18), a: rand(0.6, 0.9) });
  for (let i = 0; i < 9; i += 1) {
    const a = angle + rand(-0.8, 0.8);
    const d = rand(6, 46);
    world.decals.push({
      x: x + Math.cos(a) * d, y: y + Math.sin(a) * d,
      r: rand(3, 9), a: rand(0.35, 0.7),
    });
  }
}


/* =========================================================
   СОЗДАНИЕ МИРА
   ========================================================= */

export function createWorld(level) {
  const world = {
    level,
    w: level.w,
    h: level.h,
    tiles: Uint8Array.from(level.tiles),

    /* Какие стихии даёт этаж. Не свойство игрока, а свойство комнаты:
       чужой этаж по ссылке обязан открыться так же, как у автора. */
    elements: level.elements && level.elements.length ? [...level.elements] : [...ELEMENT_ORDER],

    player: {
      x: level.spawn.x * TILE_SIZE + TILE_SIZE / 2,
      y: level.spawn.y * TILE_SIZE + TILE_SIZE / 2,
      vx: 0, vy: 0,
      angle: (level.spawn.angle || 0) * (Math.PI / 4),
      alive: true,
      cooldown: 0,
      swing: 0,
      step: 0,

      /* Очередь демонов: что набрано, что набирается, что вот-вот вылетит. */
      stack: [],
      charging: null,
      chargeLeft: 0,
      windup: 0,
      pending: null,
    },

    enemies: [],
    civilians: [],
    hostage: null,
    core: null,
    props: [],
    bullets: [],
    particles: [],
    pops: [],
    blasts: [],
    decals: [],
    casings: [],
    noises: [],
    corpses: [],

    /*
     * Этаж спит, пока смерть не заметили. Не «пока никто не умер»: убитый
     * в стороне, которого никто не видел и не слышал, тревоги не поднимает.
     * Именно это и делает тихую фазу игрой, а не паузой перед боем — см.
     * witnessed() ниже и thinkEnemy: до тревоги враги не гонятся.
     */
    engaged: false,

    time: 0,
    kills: 0,
    total: 0,
    state: 'play',
    exitOpen: false,
    alarm: 0,
    systemic: level.systemic ? { actions: 0, last: '' } : null,
    operation: createOperation(level.operation),

    flow: null,
    flowTimer: 0,
    flowFrom: -1,

    fx: { shake: 0, hitstop: 0, flash: 0, punch: 0 },
    beats: [],
    charged: null,

    /* Питание этажа. Пока есть — силовые двери держат. */
    powered: true,

    /*
     * Всплывающие подписи прямо в мире: «+300 ПО ВОДЕ» там, где это
     * случилось. Ответ на вопрос «а это вообще засчиталось?» должен
     * приходить в момент действия и на месте действия — в углу экрана
     * его читают уже после того, как перестали смотреть.
     */
    marks: [],
    events: [],
  };

  /* Носители: те же громилы, но со своей стихией — она их и защищает. */
  const SHIELD_BY_TYPE = { 7: 'fire', 8: 'water', 9: 'wind', 10: 'earth', 11: 'bolt' };

  for (const entity of level.entities) {
    const x = entity.x * TILE_SIZE + TILE_SIZE / 2;
    const y = entity.y * TILE_SIZE + TILE_SIZE / 2;

    if (entity.type === ENTITY.CIVIL || entity.type === ENTITY.HOSTAGE) {
      const body = {
        kind: entity.type === ENTITY.CIVIL ? 'civil' : 'hostage',
        x, y, vx: 0, vy: 0,
        angle: (entity.angle || 0) * (Math.PI / 4),
        alive: true,
        downed: 0,
        burning: 0,
        zap: 0,
        wet: 0,
        radius: BODY,
        released: false,
        rescued: false,
      };
      if (entity.type === ENTITY.CIVIL) world.civilians.push(body);
      else world.hostage = body;
      continue;
    }

    if (entity.type === ENTITY.CORE || entity.type === ENTITY.CANDLE) {
      const prop = {
        kind: entity.type === ENTITY.CORE ? 'core' : 'candle',
        x, y,
        radius: entity.type === ENTITY.CORE ? 11 : 7,
        taken: false,
        lit: false,
      };
      world.props.push(prop);
      if (entity.type === ENTITY.CORE) world.core = prop;
      continue;
    }

    if (SHIELD_BY_TYPE[entity.type]) {
      world.enemies.push({
        kind: 'carrier',
        weapon: 'bat',
        ammo: 0,
        hp: 2,
        element: SHIELD_BY_TYPE[entity.type],
        resist: SHIELD_BY_TYPE[entity.type],
        x, y, vx: 0, vy: 0,
        home: { x, y },
        angle: (entity.angle || 0) * (Math.PI / 4),
        alive: true,
        downed: 0,
        stagger: 0,
        state: 'idle',
        think: rand(0, 1.2),
        heard: null,
        suspicion: 0,
        windup: 0,
        cooldown: rand(0, 0.5),
        step: 0,
      });
      world.total += 1;
      continue;
    }

    if (entity.type === 0 || entity.type === 1) {
      /*
       * Стихия дальнобойного берётся из его клетки, а не из случая: этаж
       * должен выглядеть одинаково при каждом заходе, иначе выученная
       * комната перестаёт быть выученной.
       */
      /*
       * Стихия дальнобойного берётся из стихий этажа, а не из всех пяти:
       * иначе на первом этаже в игрока летит молния, которой он ещё не
       * видел, и цвет снаряда перестаёт быть инструкцией.
       */
      const palette = world.elements;
      const element = palette[(entity.x + entity.y * 2) % palette.length];

      world.enemies.push({
        kind: entity.type === 0 ? 'thug' : 'caster',
        weapon: entity.type === 0 ? 'bat' : 'hex',
        element: entity.type === 0 ? null : element,
        /* Своя стихия не берёт: чем светится, тем его не убить. */
        resist: entity.type === 0 ? null : element,
        ammo: 99,
        x, y, vx: 0, vy: 0,
        home: { x, y },
        angle: (entity.angle || 0) * (Math.PI / 4),
        alive: true,
        downed: 0,
        stagger: 0,
        state: 'idle',
        think: rand(0, 1.2),
        heard: null,
        suspicion: 0,
        windup: 0,
        cooldown: rand(0, 0.5),
        step: 0,
      });
      world.total += 1;
      continue;
    }

    /* Типы 3 и 4 — оружие на полу из старых кодов. Подбирать нечего,
       поэтому они просто пропускаются: чужой код всё равно откроется. */
  }

  /* Пустая комната — задача на материал и путь, а не на несуществующую
     зачистку. Выход всё равно отделён реальными препятствиями карты. */
  if (world.operation) world.exitOpen = true;
  else if (world.total === 0) openExit(world);

  createField(world);
  world.flow = buildFlowField(world, world.player.x, world.player.y);
  return world;
}


/* =========================================================
   ОРУЖИЕ
   ========================================================= */

function fireGun(world, shooter, from) {
  const weapon = WEAPONS[shooter.weapon];
  const angle = shooter.angle + rand(-weapon.spread, weapon.spread) * (from === 'enemy' ? 2.4 : 1);
  const start = muzzle(world, shooter.x, shooter.y, shooter.angle);

  world.bullets.push({
    x: start.x,
    y: start.y,
    vx: Math.cos(angle) * weapon.speed,
    vy: Math.sin(angle) * weapon.speed,
    from,
    weapon: shooter.weapon,
    /* Порча летит своей стихией: по цвету снаряда видно, чем этого не взять.
       Заодно она не убивает союзника той же стойкости — и это честно. */
    elements: shooter.element ? [shooter.element] : [],
    colour: shooter.element ? colourOf(shooter.element) : null,
    life: BULLET_LIFE,
  });

  shooter.ammo -= 1;
  shooter.cooldown = weapon.cooldown;
  shooter.flash = 0.06;

  world.casings.push({
    x: shooter.x, y: shooter.y,
    vx: Math.cos(angle - 1.6) * rand(50, 90),
    vy: Math.sin(angle - 1.6) * rand(50, 90),
    angle: rand(0, 6.28), spin: rand(-14, 14), life: 0.6,
  });

  spark(world, shooter.x + Math.cos(shooter.angle) * 16, shooter.y + Math.sin(shooter.angle) * 16,
    shooter.angle, 0.4, 6, '#ffe06b', 260);

  emitNoise(world, shooter.x, shooter.y, weapon.noise, from);
  world.fx.shake = Math.max(world.fx.shake, from === 'player' ? 3.5 : 2);
  world.events.push({ type: 'shot', from });
}

/*
 * Удар — не снаряд, а мгновенная проверка сектора. Так он честно
 * попадает по тому, кого игрок видел на экране в момент нажатия.
 */
function swingMelee(world, attacker, from) {
  const weapon = WEAPONS[attacker.weapon];
  attacker.cooldown = weapon.cooldown;
  attacker.swing = 0.16;
  emitNoise(world, attacker.x, attacker.y, weapon.noise, from);
  world.events.push({ type: 'swing', from, lethal: weapon.lethal });

  const candidates = from === 'player'
    ? world.enemies.filter((e) => e.alive)
    : [world.player].filter((p) => p.alive);

  attacker.swingHit = 0;

  /*
   * Взмах достаётся одному — ближайшему в секторе.
   *
   * Раньше он доставал всем сразу, и это поймал прогон: бита выносила
   * троих за один кадр, а очередь демонов, стоящая почти секунду
   * уязвимости, оказывалась строго хуже бесплатного удара. Толпа обязана
   * быть проблемой, которую решают чем-то другим, — иначе это «другое»
   * незачем набирать.
   */
  let target = null;
  let best = Infinity;

  for (const candidate of candidates) {
    const dist = Math.hypot(candidate.x - attacker.x, candidate.y - attacker.y);
    if (dist > weapon.reach + BODY || dist >= best) continue;
    const toTarget = Math.atan2(candidate.y - attacker.y, candidate.x - attacker.x);
    if (Math.abs(angleDelta(attacker.angle, toTarget)) > weapon.arc / 2) continue;
    if (!hasSight(world, attacker.x, attacker.y, candidate.x, candidate.y)) continue;
    best = dist;
    target = candidate;
  }

  const connected = Boolean(target);

  if (target) {
    const toTarget = Math.atan2(target.y - attacker.y, target.x - attacker.x);

    if (target === world.player) {
      killPlayer(world, toTarget);
    } else if (!resisted(world, target, toTarget)) {
      /* Лежачего добивают даже кулаком — иначе сбитый враг бессмысленен. */
      if (weapon.lethal || target.downed > 0) {
        killEnemy(world, target, toTarget, 'melee', {
          by: from,
          weapon: attacker.weapon,
          execution: target.downed > 0,
        });
      } else {
        knockDown(world, target, toTarget);
      }
    }
  }

  /*
   * Попадание должно ощущаться иначе, чем промах, — и не одним звуком.
   * Кадр замирает, экран вздрагивает, камера коротко наезжает, а дуга
   * удара наливается белым. Промах не делает ничего из этого.
   */
  if (connected) {
    world.fx.hitstop = Math.max(world.fx.hitstop, 0.08);
    world.fx.shake = Math.max(world.fx.shake, 7);
    world.fx.punch = 1;
    attacker.swingHit = 0.2;
    world.events.push({ type: 'impact', lethal: weapon.lethal, from });
  }
}

/*
 * Стойкость. Не здоровье и не щит с зарядами: враг просто не берётся
 * своей же стихией. Огнём по огненному — он её отобьёт, хоть одной, хоть
 * тремя подряд; нужен любой другой цвет, и в смешанной очереди хватает
 * одного чужого.
 *
 * Через эту дверь проходят все смертельные пути — удар, чужая порча,
 * форма демона, — иначе правило однажды забыли бы в одном из них.
 */
/*
 * Кто заметил смерть.
 *
 * Видел — если живой смотрит в ту сторону и между ними нет стены. Слышал —
 * если он ближе, чем падает тело. Второе намеренно куда короче первого:
 * иначе «тихо» не существовало бы, а на маленьком этаже слышно было бы
 * всё и всегда.
 */
const WITNESS_SIGHT = 300;
const WITNESS_HEAR = 130;

function witnessed(world, victim) {
  for (const enemy of world.enemies) {
    if (!enemy.alive || enemy === victim) continue;

    const dist = Math.hypot(enemy.x - victim.x, enemy.y - victim.y);
    if (dist < WITNESS_HEAR) return true;
    if (dist < WITNESS_SIGHT && hasSight(world, enemy.x, enemy.y, victim.x, victim.y)) {
      return true;
    }
  }

  return false;
}

export function resists(enemy, elements) {
  if (!enemy.resist) return false;
  if (!elements || !elements.length) return false; /* железо стойкость не разбирает */
  return elements.every((element) => element === enemy.resist);
}

export function resisted(world, enemy, angle, source = {}) {
  if (!resists(enemy, source.elements)) return false;

  enemy.hitFlash = 0.12;
  enemy.blocked = 0.3;
  pop(world, enemy.x, enemy.y, 15, '255,255,255');
  spark(world, enemy.x, enemy.y, angle + Math.PI, 1.4, 8, colourOf(enemy.resist), 160);
  world.events.push({ type: 'resist', element: enemy.resist });
  return true;
}

export function knockDown(world, enemy, angle, срок = DOWN_TIME) {
  enemy.unconscious = Boolean(world.operation);
  enemy.downed = enemy.unconscious ? Number.POSITIVE_INFINITY : срок;
  enemy.state = 'down';
  enemy.vx += Math.cos(angle) * 260;
  enemy.vy += Math.sin(angle) * 260;
  enemy.hitFlash = 0.16;
  spark(world, enemy.x, enemy.y, angle, 1.2, 9, '#ffffff', 150);
  pop(world, enemy.x, enemy.y, 14, '255,255,255');
  world.events.push({ type: 'knock' });
  /* Вырубленный считается обезвреженным — значит последний из них
     открывает выход так же, как последний убитый. */
  openExit(world);
}

/*
 * ЖИВУЧЕСТЬ
 * =========================================================
 * С одного удара умирают слабые. Крепкого — носителя щита — одиночная
 * стихия в лоб не берёт: он её держит и отшатывается. Это не про
 * «бить дважды», а про то, чтобы найти, чем взять; способов четыре, и
 * каждый убивает крепкого сразу.
 *
 * 1. Состояние. Мокрый под разрядом, горящий под чем угодно — по телу
 *    уже идёт то, что его добьёт, и удар только заканчивает начатое.
 * 2. Состав. Две стихии и больше — это вещество, а не искра; за него
 *    заплачено очередью, и оно того стоит.
 * 3. Дорогая форма. Луч, пробой и вспышка стоят долгого набора и бьют
 *    насквозь; требовать от них ещё и второго попадания — обесценить.
 * 4. Добивание. Оглушённый и сбитый с ног не держит ничего.
 *
 * Всё вместе и есть ответ на вопрос, ради которого крепкий и стоит на
 * этаже: можно ли убрать его одним ходом. Можно — если ход выстроен.
 */
function outright(enemy, cause, source) {
  if (cause === 'chain' || cause === 'fire' || cause === 'melee') return true;

  /* Состояние тела. */
  if (enemy.burning > 0) return true;
  if ((enemy.wet || 0) > 0 && source.traits && source.traits.shock) return true;

  /* Добивание. */
  if (enemy.stagger > 0 || enemy.downed > 0) return true;

  /* Состав и дорогая форма. */
  if (source.elements && source.elements.length >= 2) return true;
  if (source.form === 'beam' || source.form === 'nova') return true;

  return false;
}

export function killEnemy(world, enemy, angle, cause, source = {}) {
  if (!enemy.alive) return;

  const лежал = (enemy.downed || 0) > 0;

  /*
   * БАЗОВЫЙ ВЕТЕР НЕ УБИВАЕТ — ОН ТОЛКАЕТ
   * -------------------------------------------------------
   * Одиночная стихия делает слабое действие плюс свойство, а сила
   * приходит от смешивания. Вода одна — не урон, а «мокрый». Ветер один —
   * не урон, а толчок.
   *
   * И толчок здесь не подарок: летящее тело уже умеет сносить соседей и
   * разбиваться о стену. То есть ветер сам никого не убивает, но
   * убивает то, куда он тебя отправил, — а это ровно тот вопрос «а если
   * смешать», ради которого одиночные стихии и делаются слабыми.
   *
   * Смешанные ветра — СМЕРЧ, БУРЯ — остаются смертельными: за состав
   * заплачено очередью.
   */
  if (source.traits && source.traits.gust
      && source.elements && source.elements.length === 1) {
    enemy.vx = (enemy.vx || 0) + Math.cos(angle) * 460;
    enemy.vy = (enemy.vy || 0) + Math.sin(angle) * 460;
    enemy.stagger = Math.max(enemy.stagger || 0, 0.45);
    enemy.shove = Math.max(enemy.shove || 0, 0.45);
    enemy.hitFlash = 0.25;
    world.fx.shake = Math.max(world.fx.shake, 3);
    world.events.push({ type: 'gust', x: enemy.x, y: enemy.y });
    return;
  }

  /* В операции мороз — подготовка, а не ещё один цвет урона. Тело
     падает целым и на короткое время становится хрупким; разбивает его
     уже отдельное последствие — столкновение. Старые этажи сохраняют
     прежнюю смертельность составов. */
  if (world.operation && source.traits?.freeze && cause === 'daemon') {
    enemy.brittle = 3;
    knockDown(world, enemy, angle);
    world.events.push({ type: 'frozen', x: enemy.x, y: enemy.y });
    return;
  }

  /*
   * Крепкий держит удар — но только тот, который нечем было усилить.
   * Событие уходит наружу: игрок обязан понять, что промаха не было, а
   * был неподходящий удар, иначе он решит, что игра его обманула.
   */
  if ((enemy.hp || 1) > 1 && !outright(enemy, cause, source)) {
    enemy.hp -= 1;
    /* Надломленный остаётся помечен: кольцо вокруг него рвётся, и видно,
       что теперь его добьёт что угодно. */
    enemy.wasTough = true;
    enemy.stagger = Math.max(enemy.stagger || 0, 0.3);
    enemy.hitFlash = 0.3;
    enemy.vx += Math.cos(angle) * 90;
    enemy.vy += Math.sin(angle) * 90;
    world.fx.shake = Math.max(world.fx.shake, 4);
    world.events.push({ type: 'held', kind: enemy.kind });
    return;
  }

  /*
   * ОДИНОЧНАЯ СТИХИЯ ВЫРУБАЕТ, А НЕ УБИВАЕТ
   * -------------------------------------------------------
   * Тот же уговор, что и с ветром, только общий: голая стихия делает
   * слабое действие, а смерть покупается составом, формой или
   * состоянием тела. Условие здесь ровно то же `outright`, которым
   * крепкий отличает подготовленный удар от случайного, — и это не
   * совпадение: вопрос один и тот же, «выстроен ли ход».
   *
   * Условие требует РОВНО ОДНОЙ стихии, а не просто «удар не выстроен».
   * Разница не педантичная: у чужой пули и у добивания стихий нет
   * вовсе, и через `!outright` они молча становились несмертельными —
   * враг переставал убивать врага, а игрок не мог добить лежачего.
   * Отсутствие состава это не одиночный состав.
   *
   * Лежачий не бесплатен для игрока. Он просыпается, он виден
   * остальным, и он поднимает тревогу тем же способом, что и труп.
   * Значит выбор между «убить» и «вырубить» — это выбор между шумом
   * сейчас и сроком потом, а не между сложным и лёгким.
   */
  if (source.elements && source.elements.length === 1
      && !outright(enemy, cause, source)) {
    enemy.subdued = true;
    knockDown(world, enemy, angle, SLEEP_TIME);
    enemy.wasTough = true;
    world.events.push({
      type: 'sleep',
      kind: enemy.kind,
      x: enemy.x,
      y: enemy.y,
      by: source.by || 'player',
      permanent: Boolean(enemy.unconscious),
    });
    return;
  }

  enemy.alive = false;
  enemy.unconscious = false;
  world.kills += 1;

  /*
   * Тело падает — и это слышно. Шум идёт всегда, даже когда тревоги нет:
   * услышавший пойдёт посмотреть, что упало, и это единственная плата за
   * убийство в стороне.
   */
  emitNoise(world, enemy.x, enemy.y, 140, 'body');

  /* Тревогу поднимает не смерть, а замеченная смерть. */
  if (!world.engaged && witnessed(world, enemy)) {
    raiseOperationAlarm(world, 'witness', true);
  }

  bleed(world, enemy.x, enemy.y, angle, cause === 'bullet' ? 260 : 190);
  pop(world, enemy.x, enemy.y, 16, '255,20,80');

  world.corpses.push({
    x: enemy.x + Math.cos(angle) * 6,
    y: enemy.y + Math.sin(angle) * 6,
    angle: enemy.angle,
    kind: enemy.kind,
    twitch: 0.5,

    /*
     * Падение — отдельное состояние, а не мгновенная подмена фигуры
     * лежащим телом. Без него смерть выглядит как «было / стало»: маг
     * стоял, маг лежит, а что между — игрок не увидел. Из «было / стало»
     * модель правил в голове не собирается, а вся игра на ней и держится.
     *
     * Треть секунды — минимум, при котором видно, что тело валится, и
     * при котором это ещё не мешает темпу.
     */
    fall: 0.34,
    sheet: enemy.kind,
    lean: (Math.random() - 0.5) * 0.6,

    /*
     * Труп уносит с собой скорость. Именно этого просил автор: тело,
     * отлетевшее от взрыва, сносит второго — «у нас же маджика, физика и
     * веселье». Правило одно на всех, поэтому живой, отброшенный
     * ОТБОЕМ, сносит так же.
     */
    vx: enemy.vx || 0,
    vy: enemy.vy || 0,
    shove: 0.6,
    alive: false,
  });

  world.fx.hitstop = Math.max(world.fx.hitstop, 0.045);
  world.fx.flash = Math.max(world.fx.flash, 0.25);

  /*
   * Событие несёт не только факт смерти: счёту нужно знать, чьих это рук
   * дело, чем ударили и добивали ли лежачего. Считать это задним числом
   * по состоянию мира уже нельзя — тела к тому моменту одинаковы.
   */
  world.events.push({
    type: 'kill',
    /* Место смерти нужно снаружи: плату за способ показывают там, где
       способ сработал, а не в углу экрана. */
    x: enemy.x,
    y: enemy.y,
    cause,
    by: source.by || 'player',
    weapon: source.weapon || null,
    /* Добивание — это состояние жертвы, а не свойство оружия. Раньше
       им считался только удар в ближнем бою, и лежачий, добитый
       магией, шёл как обычное убийство. */
    execution: Boolean(source.execution) || лежал,
  });

  openExit(world);
}

/*
 * Выход считает ОБЕЗВРЕЖЕННЫХ, а не убитых. Иначе несмертельный проход
 * невозможен физически: вырубил всех — и заперт навсегда, потому что
 * счётчик ждёт трупов. Снаружи это выглядит не как строгость, а как
 * поломка, и человек уходит.
 *
 * Открывшийся выход больше не закрывается: проснувшийся гонится за
 * тобой к выходу, и этого напряжения достаточно. Захлопывать дверь
 * перед добежавшим — наказывать за то, что он выбрал милосердие.
 *
 * И считается ПОЛОЖЕННЫЙ ХОТЬ РАЗ, а не лежащий прямо сейчас. Разница
 * оказалась решающей, и нашлась замером: чтобы выход открылся по
 * одновременно лежащим, восьмерых надо уложить внутри одного сна, то
 * есть примерно за девять секунд. Обход восьмерых стоит около двух
 * секунд на каждого — шестнадцать. Несмертельный проход был не трудным,
 * а невозможным, и снаружи это читается как поломка, а не как строгость.
 *
 * Теперь срок сна назначает не проходимость, а опасность: выход
 * откроется, но проснувшиеся пойдут за тобой. Оба исхода остаются в
 * ходу, и цена милосердия — не запертая дверь, а погоня.
 */
export function openExit(world) {
  if (world.exitOpen) return;
  let обезврежено = 0;
  for (const enemy of world.enemies) {
    if (!enemy.alive || enemy.subdued) обезврежено += 1;
  }
  if (обезврежено < world.total) return;
  world.exitOpen = true;
  world.events.push({ type: 'cleared' });
}

export function killPlayer(world, angle) {
  const player = world.player;
  if (!player.alive || world.state !== 'play') return;
  player.alive = false;
  world.state = 'dead';
  bleed(world, player.x, player.y, angle, 240);
  world.fx.hitstop = Math.max(world.fx.hitstop, 0.16);
  world.fx.shake = 11;
  world.events.push({ type: 'death' });
}


/* =========================================================
   ДЕМОНЫ
   =========================================================
   Набор стоит времени, и это единственная его цена: пока идёт
   набор, игрок замедлен и стек видно над головой. Всё, что
   вылетает, убивает одинаково — разной бывает только форма.
   ========================================================= */

function releaseStack(world) {
  const player = world.player;
  const spell = spellOf(player.stack);
  if (!spell) return;

  player.stack = [];

  /* У луча замах: линию видно заранее, и уйти с неё успевают обе стороны. */
  if (spell.form.kind === 'beam') {
    player.windup = spell.form.windup;
    player.pending = spell;
    world.events.push({ type: 'daemon-windup', form: spell.form.id });
    return;
  }

  castForm(world, spell);
}

/*
 * Заклинание ходит по миру целиком, а не разобранным на форму и список
 * стихий: вещество нужно всем — оно решает цвет, что останется на полу и
 * кого возьмёт попадание. Разбирать его на входе значило бы собирать
 * обратно в каждой из пяти функций ниже.
 */
function castForm(world, spell) {
  const player = world.player;
  const angle = player.angle;
  const { form, substance } = spell;

  player.cooldown = form.cooldown || 0.22;
  emitNoise(world, player.x, player.y, form.noise, 'player');
  world.fx.shake = Math.max(world.fx.shake, form.kind === 'nova' ? 9 : 4.5);
  world.fx.punch = 1;
  world.events.push({
    type: 'daemon',
    form: form.id,
    elements: spell.elements,
    substance: substance.id,
    signature: spell.signature ? spell.signature.id : null,
  });

  if (form.kind === 'shot') {
    spawnDaemon(world, angle, spell);
  } else if (form.kind === 'fan') {
    for (const shift of [-form.spread, 0, form.spread]) {
      spawnDaemon(world, angle + shift, spell);
    }
  } else if (form.kind === 'cone') {
    castCone(world, spell, angle);
  } else if (form.kind === 'beam') {
    castBeam(world, spell, angle);
  } else if (form.kind === 'nova') {
    castNova(world, spell);
  }
}

/*
 * Откуда вылетает снаряд. Обычно — на шаг впереди, чтобы он не рождался
 * внутри собственного тела. Но если этот шаг попадает в мебель, снаряд
 * гибнет в стволе: каждый выстрел уходит в ничто, а игрок видит, что
 * стреляет, и не понимает, почему не попадает.
 *
 * Поймано прогоном: бот, встав углом к скамье, выпустил полторы тысячи
 * зарядов подряд и не убил стоящего в трёх шагах. У живого это выглядело
 * бы поломкой игры, а не мебелью.
 */
function muzzle(world, x, y, angle) {
  const ahead = { x: x + Math.cos(angle) * 14, y: y + Math.sin(angle) * 14 };
  if (blocksShot(tileAt(world, ahead.x, ahead.y))) return { x, y };
  return ahead;
}

function spawnDaemon(world, angle, spell) {
  const player = world.player;
  const { form, substance } = spell;
  const from = muzzle(world, player.x, player.y, angle);

  world.bullets.push({
    x: from.x,
    y: from.y,
    vx: Math.cos(angle) * form.speed,
    vy: Math.sin(angle) * form.speed,
    from: 'player',
    weapon: 'daemon',
    ox: player.x,
    oy: player.y,
    elements: spell.elements,
    substance,
    /* Снаряд несёт форму с собой: живучесть крепкого решается в месте
       попадания, а там от заклинания остаётся только снаряд. */
    form: form.kind,
    trail: Boolean(spell.signature && spell.signature.trail),
    pierce: form.pierce || 0,
    breaks: Boolean(form.breaks),
    colour: substance.colour,
    life: form.life,
  });
}

function castCone(world, spell, angle) {
  const player = world.player;
  const { form, substance } = spell;
  const elements = spell.elements;

  for (const body of livingBodies(world)) {
    const dx = body.x - player.x;
    const dy = body.y - player.y;
    if (Math.hypot(dx, dy) > form.reach + BODY) continue;
    const toBody = Math.atan2(dy, dx);
    if (Math.abs(angleDelta(angle, toBody)) > form.arc / 2) continue;
    if (!hasSight(world, player.x, player.y, body.x, body.y)) continue;
    hitLivingBody(world, body, toBody, 'daemon',
      { by: 'player', weapon: 'daemon', elements, form: form.kind, traits: substance.traits });
  }

  world.blasts.push({
    kind: 'cone', x: player.x, y: player.y, angle,
    reach: form.reach, arc: form.arc,
    life: 0.2, span: 0.2, colour: substance.colour,
  });

  land(world, tilesInCone(world, player.x, player.y, angle, form.reach, form.arc), substance, {
    x: player.x + Math.cos(angle) * form.reach * 0.6,
    y: player.y + Math.sin(angle) * form.reach * 0.6,
    r: form.reach * 0.55,
  });

  applySignature(world, spell, { x: player.x, y: player.y });
}

function castBeam(world, spell, angle) {
  const player = world.player;
  const { form, substance } = spell;
  const elements = spell.elements;
  const step = 6;
  let distance = 0;

  /* Луч идёт по шагам: так он честно останавливается о стену и по дороге
     выносит витрины, а не телепортируется в конец комнаты. */
  while (distance < form.range) {
    const x = player.x + Math.cos(angle) * distance;
    const y = player.y + Math.sin(angle) * distance;
    const tile = tileAt(world, x, y);

    if (breakable(tile)) {
      world.tiles[tileIndex(world, x, y)] = TILE.FLOOR;
      world.rebake = true;
      spark(world, x, y, angle, 2.2, 10, '#9be7ff', 200);
    } else if (blocksShot(tile)) {
      /* Луч проходит сквозь предмет, который ему по силам, и идёт дальше. */
      if (!shatter(world, tileIndex(world, x, y), substance)) break;
    }

    for (const body of livingBodies(world)) {
      if (Math.hypot(body.x - x, body.y - y) > BODY + 2) continue;
      hitLivingBody(world, body, angle, 'daemon',
        { by: 'player', weapon: 'daemon', elements, form: form.kind, traits: substance.traits });
    }

    distance += step;
  }

  world.blasts.push({
    kind: 'beam',
    x: player.x, y: player.y,
    x2: player.x + Math.cos(angle) * distance,
    y2: player.y + Math.sin(angle) * distance,
    life: 0.26, span: 0.26, colour: substance.colour,
  });

  /* Полоса начинается на шаг вперёд: луч огня, кладущий пожар себе под
     ноги, наказывал бы за самую очевидную очередь из трёх одинаковых. */
  const from = 26;
  const sign = spell.signature;

  if (distance > from) {
    land(world,
      tilesAlongLine(world,
        player.x + Math.cos(angle) * from, player.y + Math.sin(angle) * from,
        player.x + Math.cos(angle) * distance, player.y + Math.sin(angle) * distance),
      substance,
      { x: player.x + Math.cos(angle) * distance, y: player.y + Math.sin(angle) * distance },
      Boolean(sign && sign.paintBeam));
  }

  /* РАЗРЯДНИК бьёт не в конце линии, а с каждого её шага: луч, идущий
     над лужей, поднимает всю лужу разом. */
  if (sign && sign.chainAlong) {
    for (let along = from; along < distance; along += TILE_SIZE) {
      discharge(world, player.x + Math.cos(angle) * along, player.y + Math.sin(angle) * along,
        substance);
    }
  }

  applySignature(world, spell, { x: player.x, y: player.y });
}

/*
 * Вспышка бьёт по кругу и не разбирает своих. В тесноте она отражается от
 * стен и достаёт того, кто её выпустил, — это не наказание, а плата за
 * кнопку паники, и в игре, где смерть стоит полсекунды, такая смерть
 * скорее смешная, чем обидная.
 */
/*
 * Вспышка. Без ветра в составе она рвёт там, где стоишь, — и в тесноте
 * достаёт своего же.
 *
 * С ветром её уносит вперёд, и это не поблажка, а следствие правила
 * «состав решает вещество». Тройной состав всегда даёт вспышку — узор
 * «три разные» другой формы не знает, — и без этого десять самых
 * интересных веществ оказывались одной и той же кнопкой паники: ГРОЗУ и
 * БУРЮ нельзя было бросить, только подорвать под ногами. Носителем стал
 * ветер, потому что он и так отвечает за дальность: чему быть унесённым,
 * видно прямо по составу, а не по заученному списку.
 */
function castNova(world, spell) {
  const player = world.player;

  if (spell.substance.traits.gust) {
    const angle = player.angle;
    world.bullets.push({
      x: muzzle(world, player.x, player.y, angle).x,
      y: muzzle(world, player.x, player.y, angle).y,
      vx: Math.cos(angle) * 430,
      vy: Math.sin(angle) * 430,
      from: 'player',
      weapon: 'daemon',
      ox: player.x,
      oy: player.y,
      elements: spell.elements,
      substance: spell.substance,
      nova: spell,
      pierce: 0,
      breaks: Boolean(spell.form.breaks),
      colour: spell.substance.colour,
      life: 0.55,
    });
    world.events.push({ type: 'nova-thrown' });
    return;
  }

  novaAt(world, spell, player.x, player.y, true);
}

function novaAt(world, spell, x, y, atFeet) {
  const player = world.player;
  const { form, substance } = spell;
  const elements = spell.elements;

  for (const body of livingBodies(world)) {
    const dx = body.x - x;
    const dy = body.y - y;
    if (Math.hypot(dx, dy) > form.radius) continue;
    if (!hasSight(world, x, y, body.x, body.y)) continue;
    const toBody = Math.atan2(dy, dx);
    hitLivingBody(world, body, toBody, 'daemon',
      { by: 'player', weapon: 'daemon', elements, form: form.kind, traits: substance.traits });
  }

  /*
   * Кого достало — решается до того, как вещество ляжет на пол. Иначе
   * вспышка ставит облако пара и им же закрывает себе проверку попадания:
   * брошенный в упор ТУМАН оставлял бросившего живым, потому что тот
   * оказывался за собственным паром. Свой дым не защищает от своего удара.
   */
  const caughtSelf = !atFeet && player.alive
    && Math.hypot(player.x - x, player.y - y) <= form.radius
    && hasSight(world, x, y, player.x, player.y);

  world.blasts.push({
    kind: 'nova', x, y,
    radius: form.radius, life: 0.3, span: 0.3, colour: '#ffffff', tint: substance.colour,
  });

  land(world, tilesInCircle(world, x, y, form.radius), substance,
    { x, y, r: form.radius * 0.8 });

  applySignature(world, spell, { x, y });

  /*
   * Брошенная вспышка своих не разбирает так же, как и та, что рвётся под
   * ногами: подошёл слишком близко к месту разрыва — сам виноват. Без
   * этого «унести ветром» превращалось бы в способ обойти единственную
   * цену, которая у вспышки есть.
   */
  if (!atFeet) {
    if (caughtSelf) {
      world.events.push({ type: 'backfire' });
      killPlayer(world, Math.atan2(player.y - y, player.x - x));
    }
    return;
  }

  /*
   * Отражение считается по соседним клеткам, а не лучами: восемь соседей
   * вокруг той клетки, где стоишь. Четыре стены и больше — теснота, волну
   * возвращает. Коридор и дверной проём набирают четыре и шесть, угол
   * комнаты — три, и поэтому в углу вспышка безопасна.
   *
   * Считаются только стены: мебель низкая, волна идёт поверх, и смерть от
   * стола выглядела бы случайной, а не заслуженной.
   */
  const cx = Math.floor(x / TILE_SIZE);
  const cy = Math.floor(y / TILE_SIZE);
  let walls = 0;

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (!dx && !dy) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      const tile = (nx < 0 || ny < 0 || nx >= world.w || ny >= world.h)
        ? TILE.WALL
        : world.tiles[ny * world.w + nx];
      if (tile === TILE.WALL) walls += 1;
    }
  }

  if (walls >= 4) {
    world.events.push({ type: 'backfire' });
    killPlayer(world, Math.random() * Math.PI * 2);
  }
}


/* =========================================================
   СЛЕД ВЕЩЕСТВА
   =========================================================
   Заклинание не заканчивается попаданием. Всё, что вещество
   умеет после — лужа, пожар, лёд, пар, разряд по воде, —
   собрано здесь, а сами правила встречи живут в field.js.
   ========================================================= */

/*
 * Вещество ложится на пол там, где форма закончилась. Точку даёт форма,
 * потому что только она знает, где закончилась: снаряд — где упал, выдох —
 * по всему конусу, луч — вдоль линии.
 */
function land(world, tiles, substance, at, force = false) {
  const touched = new Set(tiles);
  if (substance.traits.burn) {
    for (const prop of world.props) {
      if (prop.kind !== 'candle' || prop.lit) continue;
      if (!touched.has(tileIndex(world, prop.x, prop.y))) continue;
      prop.lit = true;
      if (world.operation) world.operation.candleLesson = true;
      world.events.push({ type: 'candle-lit', x: prop.x, y: prop.y });
      creditConsequence(world, 'candle', prop.x, prop.y);
    }
  }

  /* Сперва предметы: бочка обязана вскрыться до того, как на её клетку
     ляжет вещество, иначе вода разольётся под целой бочкой. */
  for (const idx of tiles) shatter(world, idx, substance);

  paint(world, tiles, substance, at, force);
  if (substance.traits.shock && at) discharge(world, at.x, at.y, substance);
}

function hitWorldProp(world, bullet) {
  for (const prop of world.props) {
    if (prop.kind !== 'candle' || prop.lit) continue;
    if (Math.hypot(prop.x - bullet.x, prop.y - bullet.y) > prop.radius + 3) continue;
    if (bullet.substance?.traits?.burn) {
      prop.lit = true;
      if (world.operation) world.operation.candleLesson = true;
      world.events.push({ type: 'candle-lit', x: prop.x, y: prop.y });
      creditConsequence(world, 'candle', prop.x, prop.y);
    }
    return true;
  }
  return false;
}

/*
 * Предмет ломается только своим веществом — и ломается насовсем, оставляя
 * после себя не пустоту, а последствие. В этом весь смысл: бочка не
 * «препятствие, которое убрали», а способ налить воды туда, куда сам не
 * дотянешься.
 *
 * Проверяется черта, а не стихия. Лаву и жар роднит огонь, и оба вскрывают
 * бочку; перечислять составы поимённо значило бы править этот список при
 * каждой новой смеси.
 */
/*
 * ОТЛОЖЕННЫЕ ШАГИ
 * =========================================================
 * Цепочка из бочки — главный ход игры: одно нажатие, три следствия.
 * Пока все три случались в одном кадре, игрок видел только результат:
 * все умерли. Причина была не видна, а значит и не читалась как своя
 * заслуга. Поэтому следствия разложены по времени и идут по очереди:
 * бочку вскрыло, вода разошлась, разряд добежал, тела задёргались.
 *
 * Очередь живёт внутри мира и умирает вместе с ним: перезапуск этажа
 * не может донести до нового мира чужой взрыв.
 */
/* Скорость, с которой разряд бежит по воде, и сколько тело дёргается,
   прежде чем упасть. Обе величины про читаемость, а не про баланс: ниже
   них цепочка снова слипается в один кадр. */
const ARC_SPEED = 900;
const STUN_TIME = 0.18;

function schedule(world, delay, run) {
  world.beats.push({ left: delay, run });
}

function runBeats(world, dt) {
  if (!world.beats.length || dt <= 0) return;

  /* Шаг может поставить следующий — он попадёт уже в новый кадр. */
  const due = [];
  world.beats = world.beats.filter((beat) => {
    beat.left -= dt;
    if (beat.left > 0) return true;
    due.push(beat);
    return false;
  });

  for (const beat of due) beat.run();
}

function shatter(world, at, substance) {
  if (at < 0 || at >= world.tiles.length) return false;

  const tile = world.tiles[at];
  if (!substance || !brokenBy(tile, substance.traits)) return false;

  const x = ((at % world.w) + 0.5) * TILE_SIZE;
  const y = (((at / world.w) | 0) + 0.5) * TILE_SIZE;

  /*
   * Мокрое дерево не занимается — и проверить это надо до того, как
   * клетка обнулится: первая моя попытка стояла ниже и возвращала на
   * место уже стёртое, то есть чинила следствие.
   *
   * Это единственное, что вода умеет делать с предметами, и ради него её
   * и льют заранее: намочил копну — и чужой огонь по ней не пойдёт.
   * Удар и разряд мокрому дереву по-прежнему не помеха: вода тушит, а не
   * укрепляет.
   */
  /*
   * Задержка на повторное срабатывание — и проверять её надо здесь, до
   * того как клетка обнулится. Второй раз я наступил на те же грабли, что
   * с мокрым деревом: поставил проверку внутрь ветки щитка, а клетка к
   * тому моменту уже стёрта в пол. Снаружи это выглядело так, будто взлом
   * сжигает щиток.
   *
   * Нужна она тому, что переживает удар: целый щиток снаряд задевает на
   * каждом шаге полёта, и питание щёлкало восемь раз туда-обратно за один
   * выстрел. Чётное число щелчков возвращало всё на место, и взлом
   * выглядел неработающим.
   */
  if (world.tileHold && world.tileHold[at] > 0) return false;

  if (world.tileWet && world.tileWet[at] > 0
      && substance.traits.burn && !substance.traits.crush && !substance.traits.shock) {
    addCloud(world, x, y, TILE_SIZE * 0.8, 'steam');
    world.tileWet[at] = Math.max(0, world.tileWet[at] - 1);
    world.events.push({ type: 'doused', x, y });
    return false;
  }

  world.tiles[at] = TILE.FLOOR;
  world.rebake = true;
  world.fx.shake = Math.max(world.fx.shake, 5);

  if (tile === TILE.BARREL) {
    /* Сначала — только грохот и осколки. Воды ещё нет. */
    spark(world, x, y, 0, 3.2, 14, '#7fe6ff', 150);
    emitNoise(world, x, y, 260, 'barrel');
    world.events.push({ type: 'barrel', x, y });
    world.fx.hitstop = Math.max(world.fx.hitstop, 0.05);

    /*
     * Вода расходится двумя кольцами, а не появляется готовой лужей:
     * игрок должен успеть увидеть, что она течёт под ноги врагу. Льётся
     * она на соседние клетки, а не только на свою — лужа в одну клетку
     * никого не поймает, и бочка была бы просто мусором.
     */
    for (let ring = 0; ring < 4; ring += 1) {
      const radius = TILE_SIZE * (0.65 + ring * 0.6);
      schedule(world, 0.09 + ring * 0.09, () => {
        paint(world, tilesInCircle(world, x, y, radius), SPILL, { x, y }, true);
        for (const body of [world.player, ...livingBodies(world)]) {
          if (groundAt(world, body.x, body.y) === GROUND.WATER) body.wet = WET_TIME;
        }
        splash(world, x, y, radius);
        if (ring === 3) world.events.push({ type: 'spill', x, y });
      });
    }

    /*
     * Разряд, вскрывший бочку, идёт по той воде, которую сам и вылил, —
     * но идёт последним, когда воде уже есть где стоять. Это тот самый
     * ход, ради которого бочка в игре и стоит: одно нажатие, три
     * следствия, и все три видно по очереди.
     */
    /*
     * Разряд ждёт, пока вода дотечёт. Кольца ложатся до 0.36 секунды, и
     * удар раньше этого бил по недоразлитой луже: крайние оставались
     * сухими и выживали. Порядок здесь не украшение — он и есть правило.
     */
    if (substance.traits.shock) {
      schedule(world, 0.4, () => discharge(world, x, y, substance));
    }
    return true;
  }

  if (tile === TILE.HAY) {
    /*
     * Стог не просто исчезает — он загорается, и вместе с ним всё вокруг.
     * В этом его смысл: солома стоит там, где за ней прячутся, и укрытие
     * превращается в костёр вместе со стоящими рядом.
     *
     * И солома поджигает солому: одной искры в край копны хватает, чтобы
     * занялась вся. Без этого копна была бы девятью отдельными кустами, а
     * поджог — девятью выстрелами; с этим она становится одной ловушкой,
     * которую готовят заранее. Рекурсия конечна: клетка гасится в пол до
     * того, как разойдётся дальше.
     */
    paint(world, tilesInCircle(world, x, y, TILE_SIZE * 1.3), FLARE, { x, y }, true);
    spark(world, x, y, 0, 3.2, 16, '#ffb347', 200);
    emitNoise(world, x, y, 300, 'hay');
    world.events.push({ type: 'hay', x, y });

    /*
     * Солома поджигает солому — но не в тот же кадр. Раньше копна из
     * девяти клеток исчезала целиком за одно мгновение, и правило,
     * которое стоило показать, не было видно вовсе: игрок наблюдал не
     * пожар, а подмену картинки.
     *
     * Теперь огонь идёт по копне клетка за клеткой. Восьмая доля секунды
     * на шаг — этого хватает, чтобы увидеть направление, и мало, чтобы
     * успеть уйти из уже занявшегося: копна остаётся ловушкой, но
     * ловушкой понятной.
     *
     * Рекурсия по-прежнему конечна: клетка гасится в пол сразу, и
     * отложенный вызов на уже сгоревшую просто ничего не находит.
     */
    const tx = at % world.w;
    const ty = (at / world.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= world.w || ny >= world.h) continue;
      const next = ny * world.w + nx;
      if (world.tiles[next] !== TILE.HAY) continue;
      schedule(world, 0.12, () => shatter(world, next, FLARE));
    }
    return true;
  }

  if (tile === TILE.CRYSTAL) {
    /* Кристалл берёт молния — и сам отдаёт её обратно: разряд идёт по
       всему, что рядом мокрое. Это ловушка, работающая на обе стороны. */
    spark(world, x, y, 0, 3.2, 16, '#fff2a8', 220);
    emitNoise(world, x, y, 320, 'crystal');
    world.events.push({ type: 'crystal', x, y });
    creditConsequence(world, 'crystal', x, y);
    discharge(world, x, y, JOLT);
    return true;
  }

  /*
   * Дерево горит так же, как солома, и по той же причине идёт дальше:
   * огонь не спрашивает, копна перед ним или скамья. Круг меньше —
   * скамья и меньше копны, — но правило одно.
   */
  if ((tile === TILE.TABLE || tile === TILE.DOOR) && substance.traits.burn) {
    paint(world, tilesInCircle(world, x, y, TILE_SIZE * 0.8), FLARE, { x, y }, true);
    spark(world, x, y, 0, 3.2, 12, '#ffb347', 170);
    emitNoise(world, x, y, 240, 'hay');
    world.events.push({ type: 'hay', x, y });
    if (tile === TILE.DOOR) creditConsequence(world, 'wood', x, y);

    const wx = at % world.w;
    const wy = (at / world.w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = wx + dx;
      const ny = wy + dy;
      if (nx < 0 || ny < 0 || nx >= world.w || ny >= world.h) continue;
      const next = ny * world.w + nx;
      if (!brokenBy(world.tiles[next], { burn: 1 })) continue;
      schedule(world, 0.12, () => shatter(world, next, FLARE));
    }
    return true;
  }

  /*
   * Щиток замкнули. Он не убивает и не открывает дорогу — он **шумит не
   * там, где игрок**, и в этом всё его назначение.
   *
   * До него всякий шум в игре исходил из-под ног того, кто его устроил:
   * выстрел, взрыв, падающее тело. Таким шумом можно убить, но нельзя
   * отвлечь — стража идёт ровно туда, где ты стоишь. Щиток разрывает эту
   * связь, и с ним появляется первый способ пройти этаж, никого не убив.
   *
   * Слышно его дальше всего в игре: триста шестьдесят против трёхсот у
   * бьющегося стекла. Заметить обязаны все, кто в комнате.
   */
  if (tile === TILE.PANEL) {
    /*
     * ВЗЛОМ ИЛИ ЗАМЫКАНИЕ — РЕШАЕТ СОСТАВ
     * -------------------------------------------------------
     * Взлом здесь не мини-игра и не новый предмет: это разница в том,
     * ЧЕМ ты бьёшь по тому же щитку. Отдельный экран с таймером был бы
     * другой игрой, приклеенной к этой, — он ни на что не умножается и
     * живёт по своим законам, а весь смысл здесь в том, что правила
     * перемножаются.
     *
     * Одиночная искра замыкает: щиток гаснет, гремит на весь этаж и
     * больше не работает. Состав, в котором есть разряд, делает то же
     * тихо и не ломая: за состав заплачено очередью, и он даёт точность,
     * а не силу — ровно так же, как везде в этой игре.
     *
     * Отсюда развилка с ценой, которую не пришлось придумывать: шумно и
     * сразу или тихо и дольше. И у неё есть третья сторона: целый щиток
     * можно переключить обратно, а сожжённый — нет.
     */
    const точно = substance.traits.shock && substance.elements.length >= 2;

    if (world.tileHold) world.tileHold[at] = 0.5;
    setPower(world, !world.powered);
    world.events.push({ type: 'panel', x, y, точно });

    if (точно) {
      /* Взломанный щиток остаётся на месте: тихо и обратимо. */
      world.tiles[at] = TILE.PANEL;
      world.rebake = true;
      spark(world, x, y, 0, 1.2, 8, '#9fe8ff', 90);
      return true;
    }

    spark(world, x, y, 0, 3.2, 22, '#ffe14d', 260);
    spark(world, x, y, 0, 3.2, 14, '#9fe8ff', 200);
    emitNoise(world, x, y, 360, 'panel');
    raiseOperationAlarm(world, 'panel');
    world.fx.flash = Math.max(world.fx.flash, 0.3);
    return true;
  }

  if (tile === TILE.GLASS) {
    /* Стекло слышно дальше, чем видно: звон собирает этаж. */
    spark(world, x, y, 0, 3.2, 18, '#cfe9ff', 240);
    emitNoise(world, x, y, 300, 'glass');
    world.events.push({ type: 'glass', x, y });
    return true;
  }

  if (tile === TILE.METAL) creditConsequence(world, 'metal', x, y);
  spark(world, x, y, 0, 3.2, 12, '#c9a27a', 170);
  emitNoise(world, x, y, 240, 'boulder');
  world.events.push({ type: 'boulder', x, y });
  return true;
}

/*
 * Толчок сигнатуры. Тела двигает через ту же оглушку, что и сорванный
 * щит: у неё уже есть и трение, и проверка стен, а второй способ двигать
 * тело означал бы второй способ пройти сквозь стену.
 *
 * Игрока толчок не трогает: он тут центр, а не цель. Своя же ХВАТКА,
 * стягивающая самого себя, читалась бы как поломка, а не как цена.
 */
function impulse(world, x, y, radius, strength) {
  for (const enemy of world.enemies) {
    if (!enemy.alive) continue;
    const dx = enemy.x - x;
    const dy = enemy.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist > radius || dist < 1) continue;
    if (!hasSight(world, x, y, enemy.x, enemy.y)) continue;

    /* Ближних кидает сильнее — иначе дальний край работает так же, как
       вплотную, и у заклинания пропадает форма. */
    const fall = 1 - dist / radius;
    const push = (strength * (0.45 + fall * 0.55)) / dist;
    enemy.vx = dx * push;
    enemy.vy = dy * push;
    enemy.stagger = Math.max(enemy.stagger || 0, 0.35);
    enemy.shove = 0.35;
  }
}

/* Сигнатура — набор флагов; здесь они превращаются в действие. */
function applySignature(world, spell, at) {
  const sign = spell.signature;
  if (!sign) return;

  const player = world.player;
  const reach = spell.form.reach || spell.form.radius || 140;

  if (sign.pull) impulse(world, player.x, player.y, reach * 3, -sign.pull);
  if (sign.push) impulse(world, player.x, player.y, reach * 2.6, sign.push);
  if (sign.bigCloud) {
    addCloud(world, player.x, player.y, reach * sign.bigCloud, 'steam');
  }
}

/*
 * Разряд по воде. Сначала под током оказывается вся связная лужа, потом
 * ток перескакивает на мокрых рядом и с них дальше.
 *
 * Своих цепь не разбирает — как и вспышка. Стоять в собственной луже,
 * пуская в неё молнию, это ровно то решение, за которое игра обязана
 * спросить: иначе «намочи и ударь» превратилось бы в бесплатную кнопку.
 */
export function discharge(world, x, y, substance) {
  const live = conductedTiles(world, x, y);
  const bodies = [world.player, ...world.enemies, ...world.civilians,
    ...(world.hostage ? [world.hostage] : [])].filter((body) => body.alive);
  const hit = new Set();
  const queue = [{ x, y }];

  for (const body of bodies) {
    if (live.has(groundIndex(world, body.x, body.y))) { hit.add(body); queue.push(body); }
  }

  while (queue.length) {
    const from = queue.shift();
    for (const body of bodies) {
      if (hit.has(body) || !conducts(world, body)) continue;
      if (Math.hypot(body.x - from.x, body.y - from.y) > CHAIN_HOP) continue;
      hit.add(body);
      queue.push(body);
    }
  }

  if (!hit.size) return;

  /* Треск идёт сразу: он и есть предупреждение тем, кто стоит в воде. */
  world.events.push({ type: 'chain', size: hit.size });
  if (world.operation && hit.size > 1) world.operation.waterLesson = true;
  world.fx.flash = Math.max(world.fx.flash, 0.2);

  /*
   * Сначала светится земля. Ток идёт по воде, а не по воздуху, и порядок
   * «залило → зарядило → ударило» игрок должен видеть глазами, а не
   * достраивать в уме: без светящейся лужи посередине выходит, что
   * молния убила троих через полкомнаты неизвестно как.
   *
   * Фронт бежит наружу от точки удара с той же скоростью, с какой
   * назначены удары по телам, — поэтому свет добегает до врага ровно
   * тогда, когда врага бьёт.
   */
  world.charged = { tiles: live, x, y, life: 0.5, max: 0.5 };

  /*
   * Остаточное электричество — просьба Сергея словами: после разряда вода
   * не гаснет мгновенно, а ещё пару секунд потрескивает и слабо светится.
   * Это память о разряде, не сам разряд: держится дольше фронта, рисуется
   * тише (см. drawResidual), и по ней читается «лужа всё ещё опасна была».
   */
  world.residual = { tiles: live, x, y, life: 2.6, max: 2.6 };

  let order = 0;

  for (const body of hit) {
    const angle = Math.atan2(body.y - y, body.x - x);

    /*
     * Разряд не возникает всюду разом — он добегает. Дальний в луже
     * дёргается позже ближнего, и по этой задержке видно, что убило их
     * одно и то же, а не пять отдельных случайностей.
     */
    /*
     * К расстоянию добавляется шаг по счёту. Трое, стоящие бок о бок,
     * одинаково далеки от бочки — и падали в один кадр, отчего цепь
     * читалась как «все умерли разом», а не как разряд, идущий дальше.
     * Разница в восьмую долю секунды делает из этого домино.
     */
    const travel = Math.min(0.3, Math.hypot(body.x - x, body.y - y) / ARC_SPEED)
      + order * 0.13;
    order += 1;

    schedule(world, travel, () => {
      if (!body.alive) return;

      /*
       * Сначала бьёт — тело дёргается. Смерть приходит следом.
       * Оглушение берётся то же самое, что у сорванного щита: оно уже
       * выключает управление, и врага не должно тянуть стрелять в момент,
       * когда его бьёт током.
       */
      body.zap = Math.max(body.zap || 0, STUN_TIME);
      if (body !== world.player) {
        body.stagger = Math.max(body.stagger || 0, STUN_TIME);
      }
      spark(world, body.x, body.y, angle, 2.4, 9, '#9fe8ff', 130);
      world.fx.shake = Math.max(world.fx.shake, 3);

      schedule(world, STUN_TIME, () => {
        if (!body.alive) return;
        if (body === world.player) {
          world.events.push({ type: 'shocked-self' });
          killPlayer(world, angle);
          return;
        }
        const trupovBylo = world.corpses.length;
        if (world.enemies.includes(body)) {
          if (resisted(world, body, angle, { elements: substance.elements })) return;
          killEnemy(world, body, angle, 'chain',
            { by: 'player', weapon: 'daemon', elements: substance.elements });
        } else {
          killNeutral(world, body, angle, 'chain');
        }
        /* Убитое током тело потрескивает и после смерти — остаточное
           электричество носят не только живые (см. drawCorpses). */
        if (world.corpses.length > trupovBylo) {
          world.corpses[world.corpses.length - 1].zap = 1.8;
        }
      });
    });
  }
}

/*
 * Что пол делает с телом. Лёд не убивает, но отнимает управление —
 * поэтому он ценен обеим сторонам: по нему одинаково несёт и врага, и
 * того, кто его настелил.
 */
function footing(world, body) {
  const ground = groundAt(world, body.x, body.y);
  if (ground === GROUND.MUD) return { pace: 0.55, grip: 1 };
  if (ground === GROUND.ICE) return { pace: 1.12, grip: 0.16 };
  return { pace: 1, grip: 1 };
}

/*
 * Мокрое и горящее. Огонь не убивает мгновенно: горящий бежит и умирает
 * на бегу, и всё это время у него есть выход — лужа. Мгновенная смерть от
 * пола была бы честнее по букве правила «все умирают с одного касания», но
 * отняла бы у воды единственное применение, ради которого её набирают.
 */
function scorch(world, body, dt) {
  body.wet = Math.max(0, (body.wet || 0) - dt);

  const ground = groundAt(world, body.x, body.y);

  if (ground === GROUND.WATER || ground === GROUND.MUD) {
    body.wet = WET_TIME;
    if (body.burning > 0) {
      body.burning = 0;
      addCloud(world, body.x, body.y, TILE_SIZE, 'steam');
      world.events.push({ type: 'doused' });
    }
  }

  /* Стойкий к огню в огне не горит: это та же стойкость, просто пол. */
  if (!body.burning && !body.wet && burningAt(world, body.x, body.y)
      && !resists(body, ['fire'])) {
    body.burning = BURN_TIME;
    world.events.push({ type: 'ignite', player: body === world.player });
    const origin = body.heard?.origin;
    if (world.enemies.includes(body) && origin
        && Math.hypot(body.x - origin.x, body.y - origin.y) <= TILE_SIZE * 2
        && !body.noiseTrapObserved) {
      body.noiseTrapObserved = true;
      world.events.push({ type: 'world-observation', id: 'noise-fire' });
    }
  }

  if (body.burning > 0) {
    body.burning -= dt;
    if (body.burning <= 0) {
      body.burning = 0;
      const angle = Math.random() * Math.PI * 2;
      if (body === world.player) killPlayer(world, angle);
      else if (world.enemies.includes(body)) {
        killEnemy(world, body, angle, 'fire',
          { by: 'player', weapon: 'daemon', elements: ['fire'] });
      } else {
        killNeutral(world, body, angle, 'fire');
      }
    }
  }
}


/* =========================================================
   ШАГ МИРА
   ========================================================= */

export function update(world, dt, intent) {
  world.events.length = 0;

  /*
   * Часы мира идут НАСТОЯЩИМ временем, а не замедленным: иначе окно, в
   * котором считаются три правила, растягивалось бы вместе с миром, и
   * замедление продлевало бы само себя.
   */
  const real = dt;
  world.clock = (world.clock || 0) + real;

  if (world.slow > 0) {
    world.slow = Math.max(0, world.slow - real);
    dt *= SLOW_SCALE;
  }

  /* Стоп-кадр в момент удара: он и делает попадание «мясным». */
  if (world.fx.hitstop > 0) {
    world.fx.hitstop -= dt;
    dt = Math.min(dt, 0.004);
  }

  world.fx.shake = Math.max(0, world.fx.shake - dt * 26);
  world.fx.flash = Math.max(0, world.fx.flash - dt * 3.2);
  world.fx.punch = Math.max(0, world.fx.punch - dt * 4);

  runBeats(world, dt);

  if (world.charged) {
    world.charged.life -= dt;
    if (world.charged.life <= 0) world.charged = null;
  }

  if (world.residual) {
    world.residual.life -= dt;
    if (world.residual.life <= 0) world.residual = null;
  }

  /* Метка «бьёт током» гаснет сама — её носят живые, игрок и тела. */
  world.player.zap = Math.max(0, (world.player.zap || 0) - dt);
  for (const enemy of world.enemies) enemy.zap = Math.max(0, (enemy.zap || 0) - dt);
  for (const corpse of world.corpses) {
    if (corpse.zap) corpse.zap = Math.max(0, corpse.zap - dt);
  }

  if (world.state === 'play') world.time += dt;

  updateField(world, dt);
  updatePlayer(world, dt, intent);
  updateOperation(world, dt);
  tryExit(world);

  world.flowTimer -= dt;
  const playerCell = tileIndex(world, world.player.x, world.player.y);
  if (world.flowTimer <= 0 || playerCell !== world.flowFrom) {
    world.flow = buildFlowField(world, world.player.x, world.player.y);
    world.flowFrom = playerCell;
    world.flowTimer = 0.2;
  }

  for (const enemy of world.enemies) updateEnemy(world, enemy, dt);
  for (const body of [...world.civilians, ...(world.hostage ? [world.hostage] : [])]) {
    if (!body.alive) continue;
    scorch(world, body, dt);
    body.zap = Math.max(0, (body.zap || 0) - dt);
  }

  updateBullets(world, dt);
  updateLoose(world, dt);

  for (const noise of world.noises) noise.life -= dt;
  world.noises = world.noises.filter((n) => n.life > 0);

  world.marks = world.marks.filter((mark) => {
    mark.life -= dt;
    mark.y -= dt * 26;
    return mark.life > 0;
  });

  for (const corpse of world.corpses) {
    corpse.twitch = Math.max(0, corpse.twitch - dt);
    if (corpse.fall > 0) corpse.fall = Math.max(0, corpse.fall - dt);

    /* Летящее тело едет и сбивает, пока не остановится. */
    if (Math.hypot(corpse.vx || 0, corpse.vy || 0) > 4) {
      moveBody(world, corpse, corpse.vx * dt, corpse.vy * dt);
      fling(world, corpse, null);
      corpse.vx *= 0.9;
      corpse.vy *= 0.9;
    }
  }

  noticeBodies(world);
  maybeSlow(world);

  if (world.decals.length > 420) world.decals.splice(0, world.decals.length - 420);
}

export function tryExit(world) {
  if (!world.exitOpen || world.state !== 'play'
    || tileAt(world, world.player.x, world.player.y) !== TILE.EXIT) return false;
  if (world.operation && !world.operation.coreTaken) return false;
  world.state = 'clear';
  if (world.operation) world.operation.escaped = true;
  world.events.push({ type: 'exit' });
  return true;
}

/*
 * Решение о замедлении принимается в конце шага, когда события кадра уже
 * все на месте. Раньше — значит судить по половине кадра: цепь по воде
 * успевает породить и «разряд», и «убил», и по первому из них ещё ничего
 * не видно.
 */
function maybeSlow(world) {
  if (!world.recent) world.recent = [];

  let живое = null;
  for (const event of world.events) {
    const rule = BY_EVENT[event.type];
    if (rule) world.recent.push({ t: world.clock, rule });
    if (TOUCHED_ALIVE.has(event.type)) живое = event;
  }

  /* Окно скользит по настоящему времени и чистится здесь же, чтобы
     список не рос весь этаж. */
  while (world.recent.length && world.clock - world.recent[0].t > SLOW_WINDOW) {
    world.recent.shift();
  }

  if (world.slow > 0) return;          /* уже идёт — не продлевать */
  if (!живое) return;                  /* обстановку ломать можно молча */
  if (!NOT_YOURS.has(живое.cause)) return;  /* в это ты целился сам */

  /*
   * Добивающий удар — третье происшествие, а не довесок к двум. В цепи
   * по воде мир делает ровно три вещи: вскрыл бочку, пустил разряд,
   * убил, — но названных правил там два, потому что у смерти своего
   * имени в словаре нет. Считать только имена значило бы требовать
   * четырёх событий вместо трёх и не срабатывать никогда: первая
   * версия так и не сработала ни разу.
   */
  const разных = new Set(world.recent.map((r) => r.rule));
  if (разных.size + 1 < 3) return;

  world.slow = SLOW_TIME;
  world.events.push({ type: 'slow', rules: [...разных], cause: живое.cause });
}

/*
 * ТЕЛО НА ПОЛУ ВИДНО ОСТАЛЬНЫМ
 * =========================================================
 * До сих пор мир не замечал тел вовсе: можно было положить пятерых на
 * глазах у шестого, и он ходил дозором мимо. Тревогу поднимала только
 * увиденная смерть — сам миг, — а всё, что осталось лежать после,
 * становилось частью обстановки.
 *
 * Правило одно и на труп, и на лежачего: разбирать их было бы враньём
 * в очевидную сторону — вырубленного замечают, а убитого нет.
 *
 * Оно же назначает цену вырубанию. Оглушённый лежит на виду девять
 * секунд, и всё это время он — улика. Убитый лежит вечно, но убийство
 * слышно сразу. Один способ платит шумом сейчас, другой — сроком
 * потом, и оба остаются в ходу.
 */
function noticeBodies(world) {
  if (world.engaged) return;

  for (const enemy of world.enemies) {
    if (!enemy.alive || enemy.downed > 0) continue;
    if (enemy.state === 'chase') continue;

    for (const тело of world.corpses) {
      const gap = Math.hypot(enemy.x - тело.x, enemy.y - тело.y);
      if (gap > WITNESS_SIGHT) continue;
      if (!hasSight(world, enemy.x, enemy.y, тело.x, тело.y)) continue;
      raiseOperationAlarm(world, 'body', true);
      return;
    }

    for (const другой of world.enemies) {
      if (другой === enemy || !другой.alive || !(другой.downed > 0)) continue;
      const gap = Math.hypot(enemy.x - другой.x, enemy.y - другой.y);
      if (gap > WITNESS_SIGHT) continue;
      if (!hasSight(world, enemy.x, enemy.y, другой.x, другой.y)) continue;
      raiseOperationAlarm(world, 'body', true);
      return;
    }
  }
}


function updatePlayer(world, dt, intent) {
  const player = world.player;
  if (!player.alive) return;

  /*
   * Набор демона стоит скорости, замах луча — почти всей. Это и есть та
   * ставка, ради которой очередь вообще нужна: чем длиннее, тем дольше
   * стоишь на виду.
   */
  const stand = footing(world, player);
  scorch(world, player, dt);
  if (!player.alive) return;

  const pace = (player.windup > 0 ? 0.35 : (player.chargeLeft > 0 ? 0.55 : 1)) * stand.pace;
  const speed = PLAYER_SPEED * pace;

  const wish = Math.hypot(intent.moveX, intent.moveY);
  const targetX = wish > 0.001 ? (intent.moveX / Math.max(1, wish)) * speed : 0;
  const targetY = wish > 0.001 ? (intent.moveY / Math.max(1, wish)) * speed : 0;

  const accel = PLAYER_ACCEL * stand.grip;
  player.vx += clamp(targetX - player.vx, -accel * dt, accel * dt);
  player.vy += clamp(targetY - player.vy, -accel * dt, accel * dt);

  moveBody(world, player, player.vx * dt, player.vy * dt);

  player.step += Math.hypot(player.vx, player.vy) * dt;
  if (player.step > 26) {
    player.step = 0;
    emitNoise(world, player.x, player.y, 58, 'step');
    world.events.push({ type: 'step' });
  }

  if (intent.aimAngle !== null && intent.aimAngle !== undefined) {
    player.angle = intent.aimAngle;
  } else if (wish > 0.1) {
    player.angle = turnToward(player.angle, Math.atan2(player.vy, player.vx), dt * 14);
  }

  player.cooldown = Math.max(0, player.cooldown - dt);
  player.swing = Math.max(0, player.swing - dt);
  player.swingHit = Math.max(0, (player.swingHit || 0) - dt);
  player.flash = Math.max(0, (player.flash || 0) - dt);

  /* Луч на замахе: линию уже видно, отменить нельзя. */
  if (player.windup > 0) {
    player.windup -= dt;
    if (player.windup <= 0 && player.pending) {
      const pending = player.pending;
      player.pending = null;
      castForm(world, pending);
    }
    return;
  }

  /* Сброс набранного: время уже потрачено, но выпустить не туда — хуже. */
  if (intent.dump && (player.stack.length || player.chargeLeft > 0)) {
    player.stack = [];
    player.charging = null;
    player.chargeLeft = 0;
    world.events.push({ type: 'dump' });
  }

  /* Стихии, которой этаж не даёт, у игрока просто нет. Молча — плохо:
     он решит, что кнопка не сработала, а не что стихия не его. */
  if (intent.charge && !world.elements.includes(intent.charge)) {
    world.events.push({ type: 'locked', element: intent.charge });
    intent.charge = null;
  }

  if (intent.charge && player.stack.length < STACK_LIMIT && player.chargeLeft <= 0) {
    player.charging = intent.charge;
    player.chargeLeft = CHARGE_STEP;
    world.events.push({ type: 'charge-start', element: intent.charge });
  }

  if (player.chargeLeft > 0) {
    player.chargeLeft -= dt;
    if (player.chargeLeft <= 0) {
      player.stack.push(player.charging);
      player.charging = null;
      world.events.push({ type: 'charge', size: player.stack.length, element: player.stack[player.stack.length - 1] });
    }
  }

  if (intent.attack && player.cooldown <= 0) {
    /*
     * Удар при наборе бросает недобранную стихию и выпускает то, что уже
     * есть: остаться без ответа из-за собственного набора — худшее, что
     * тут может случиться.
     */
    if (player.chargeLeft > 0) {
      player.chargeLeft = 0;
      player.charging = null;
    }

    if (player.stack.length) {
      releaseStack(world);
    } else {
      /* Пустая очередь — единственный случай, когда удар ничего не делает. */
      player.cooldown = 0.18;
      world.events.push({ type: 'dry' });
    }
  }

}


function updateEnemy(world, enemy, dt) {
  if (!enemy.alive) {
    enemy.vx *= 0.8;
    enemy.vy *= 0.8;
    return;
  }

  enemy.cooldown = Math.max(0, enemy.cooldown - dt);
  enemy.brittle = Math.max(0, (enemy.brittle || 0) - dt);
  enemy.swing = Math.max(0, (enemy.swing || 0) - dt);
  enemy.flash = Math.max(0, (enemy.flash || 0) - dt);
  enemy.hitFlash = Math.max(0, (enemy.hitFlash || 0) - dt);
  enemy.blocked = Math.max(0, (enemy.blocked || 0) - dt);

  /* Сорванный щит выключает носителя на треть секунды — окно для добивания. */
  if (enemy.stagger > 0) {
    enemy.stagger -= dt;

    /*
     * Отброшенное тело тормозит медленнее оглушённого. Разница поймана
     * прогоном: на общем торможении ХВАТКА сдвигала врага на два десятка
     * пикселей — меньше собственного роста, — и найденное заклинание не
     * делало ничего заметного. Толчок обязан быть виден, иначе его незачем
     * искать.
     */
    const drag = (enemy.shove || 0) > 0 ? 0.93 : 0.82;
    enemy.shove = Math.max(0, (enemy.shove || 0) - dt);
    enemy.vx *= drag;
    enemy.vy *= drag;
    moveBody(world, enemy, enemy.vx * dt, enemy.vy * dt);

    /* Отброшенный живой — такой же снаряд, как и мёртвый. Правило одно. */
    fling(world, enemy, null);
    return;
  }

  if (enemy.downed > 0) {
    /*
     * Лежачий горит. Без этой строки обморок работал бронёй: в огне
     * лежать было безопаснее, чем стоять, потому что ветка сна
     * возвращалась раньше, чем тело успевало обуглиться. Поймано
     * тестом про копну — он единственный ставил вырубленного в
     * пожар, и мы чуть не списали его как устаревший.
     */
    scorch(world, enemy, dt);
    if (!enemy.alive) return;

    if (!enemy.unconscious) enemy.downed -= dt;
    enemy.vx *= 0.86;
    enemy.vy *= 0.86;
    moveBody(world, enemy, enemy.vx * dt, enemy.vy * dt);
    if (!enemy.unconscious && enemy.downed <= 0) {
      enemy.state = 'alert';
      enemy.heard = { x: world.player.x, y: world.player.y };
      /* Пробуждение — событие, а не тихая смена поля. Без него судьбу
         вырубленных приходится угадывать по состоянию мира в конце
         прогона, а это уже не замер, а гадание. */
      /* Флаг `subdued` отличает вырубленного стихией от сбитого с ног в
         ближнем бою: второй встаёт через две секунды и делает это
         постоянно, и объявлять каждый такой подъём — засорять экран. */
      world.events.push({ type: 'wake', kind: enemy.kind, subdued: Boolean(enemy.subdued) });
    }
    return;
  }

  const stand = footing(world, enemy);
  scorch(world, enemy, dt);
  if (!enemy.alive) return;

  const move = thinkEnemy(world, enemy, dt,
    { walk: ENEMY_WALK * stand.pace, run: ENEMY_RUN * stand.pace });

  enemy.vx = lerp(enemy.vx, move.vx, clamp(dt * 9 * stand.grip, 0, 1));
  enemy.vy = lerp(enemy.vy, move.vy, clamp(dt * 9 * stand.grip, 0, 1));
  moveBody(world, enemy, enemy.vx * dt, enemy.vy * dt);

  /* Тела расталкиваются, иначе толпа слипается в одну точку. */
  for (const other of world.enemies) {
    if (other === enemy || !other.alive) continue;
    const dx = other.x - enemy.x;
    const dy = other.y - enemy.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.01 && dist < BODY * 2) {
      const push = (BODY * 2 - dist) * 0.5;
      moveBody(world, enemy, (-dx / dist) * push, (-dy / dist) * push);
    }
  }

  if (move.attack) {
    const weapon = WEAPONS[enemy.weapon];
    if (weapon.kind === 'gun' && enemy.ammo > 0) fireGun(world, enemy, 'enemy');
    else if (weapon.kind === 'melee') swingMelee(world, enemy, 'enemy');
  }

  enemy.step += Math.hypot(enemy.vx, enemy.vy) * dt;
  if (enemy.step > 30) { enemy.step = 0; world.events.push({ type: 'enemystep', x: enemy.x, y: enemy.y }); }
}


function updateBullets(world, dt) {
  for (const bullet of world.bullets) {
    const steps = Math.max(1, Math.ceil(Math.hypot(bullet.vx, bullet.vy) * dt / 6));
    const sx = (bullet.vx * dt) / steps;
    const sy = (bullet.vy * dt) / steps;

    for (let i = 0; i < steps && bullet.life > 0; i += 1) {
      bullet.x += sx;
      bullet.y += sy;

      /*
       * Проходимое ломается на лету. Стог не держит снаряд — сквозь него
       * можно и пройти, и выстрелить, — поэтому поджечь его можно только
       * так: проверкой на каждом шагу полёта, а не в точке остановки.
       */
      if (bullet.substance) shatter(world, tileIndex(world, bullet.x, bullet.y), bullet.substance);

      if (bullet.from === 'player' && hitWorldProp(world, bullet)) {
        bullet.life = 0;
        break;
      }

      /*
       * Сигнатура следа: вещество ложится на каждом шагу полёта, а не
       * только там, где снаряд встал. Первые полторы клетки пропускаются —
       * иначе БОРОЗДА поджигает пол ровно под ногами того, кто её нашёл, и
       * награда за находку оказывается смертельной ловушкой.
       */
      if (bullet.trail && bullet.substance
        && Math.hypot(bullet.x - bullet.ox, bullet.y - bullet.oy) > TILE_SIZE * 1.5) {
        paint(world, tilesInCircle(world, bullet.x, bullet.y, TILE_SIZE * 0.6),
          bullet.substance, null);
      }

      const tile = tileAt(world, bullet.x, bullet.y);

      if (breakable(tile)) {
        world.tiles[tileIndex(world, bullet.x, bullet.y)] = TILE.FLOOR;
        spark(world, bullet.x, bullet.y, Math.atan2(sy, sx), 2.2, 14, '#9be7ff', 200);
        emitNoise(world, bullet.x, bullet.y, 300, 'glass');
        world.fx.shake = Math.max(world.fx.shake, 3);
        world.events.push({ type: 'glass' });
        /* Витрина запечена в статический слой — его придётся собрать заново. */
        world.rebake = true;
        continue;
      }

      if (blocksShot(tile)) {
        /* Предмет своей стихии не держит снаряд: он от него и ломается. */
        if (bullet.substance
          && shatter(world, tileIndex(world, bullet.x, bullet.y), bullet.substance)) {
          continue;
        }

        /* Пробой сносит мебель и идёт дальше — на то он и пробой. */
        if (bullet.breaks && tile === TILE.TABLE) {
          world.tiles[tileIndex(world, bullet.x, bullet.y)] = TILE.FLOOR;
          world.rebake = true;
          spark(world, bullet.x, bullet.y, Math.atan2(sy, sx), 2, 10, '#ff9b52', 190);
          continue;
        }
        spark(world, bullet.x, bullet.y, Math.atan2(-sy, -sx), 1.1, 5, '#ffe06b', 150);
        pop(world, bullet.x, bullet.y, 5, bullet.colour ? '255,255,255' : '255,224,107');
        bullet.life = 0;
        break;
      }

      const angle = Math.atan2(sy, sx);

      if (bullet.from === 'player') {
        const struck = livingBodies(world)
          .filter((body) => Math.hypot(body.x - bullet.x, body.y - bullet.y) < BODY + 1)
          .sort((a, b) => Math.hypot(a.x - bullet.x, a.y - bullet.y)
            - Math.hypot(b.x - bullet.x, b.y - bullet.y));
        for (const body of struck) {
          hitLivingBody(world, body, angle, bullet.weapon === 'daemon' ? 'daemon' : 'bullet',
            { by: 'player', weapon: bullet.weapon, elements: bullet.elements,
              form: bullet.form,
              traits: bullet.substance ? bullet.substance.traits : null });

          if (bullet.pierce > 0) { bullet.pierce -= 1; continue; }
          bullet.life = 0;
          break;
        }
      } else {
        const player = world.player;
        if (player.alive && Math.hypot(player.x - bullet.x, player.y - bullet.y) < BODY + 1) {
          killPlayer(world, angle);
          bullet.life = 0;
        }
        /* Своих тоже задевает: чужая пуля в спину товарища — честный трофей. */
        for (const enemy of world.enemies) {
          if (!enemy.alive || bullet.life <= 0) continue;
          if (Math.hypot(enemy.x - bullet.x, enemy.y - bullet.y) >= BODY + 1) continue;
          if (!resisted(world, enemy, angle, { elements: bullet.elements })) {
            killEnemy(world, enemy, angle, 'bullet', { by: 'enemy', weapon: bullet.weapon });
          }
          bullet.life = 0;
        }
      }
    }

    bullet.life -= dt;

    /*
     * Снаряд кончился — вещество осталось. Одна дверь на все способы
     * кончиться (стена, тело, время), иначе половина попаданий не
     * оставляла бы следа, и правило «вещество живёт после удара»
     * работало бы через раз.
     */
    if (bullet.substance && bullet.life <= 0 && !bullet.landed) {
      bullet.landed = true;

      if (bullet.nova) {
        novaAt(world, bullet.nova, bullet.x, bullet.y, false);
      } else {
        const reach = bullet.substance.traits.reach || 1;
        land(world, tilesInCircle(world, bullet.x, bullet.y, TILE_SIZE * 0.9 * reach),
          bullet.substance, { x: bullet.x, y: bullet.y, r: TILE_SIZE * 1.2 });
      }
    }
  }

  world.bullets = world.bullets.filter((b) => b.life > 0);
}


function updateLoose(world, dt) {
  for (const ring of world.pops) ring.life -= dt;
  world.pops = world.pops.filter((ring) => ring.life > 0);

  for (const blast of world.blasts) blast.life -= dt;
  world.blasts = world.blasts.filter((blast) => blast.life > 0);

  for (const particle of world.particles) {
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.vx *= 0.9;
    particle.vy *= 0.9;
    particle.life -= dt;
    if (particle.wet && particle.life <= 0 && !blocksMove(tileAt(world, particle.x, particle.y))) {
      world.decals.push({ x: particle.x, y: particle.y, r: rand(1.5, 3.5), a: rand(0.25, 0.5) });
    }
  }
  world.particles = world.particles.filter((p) => p.life > 0);

  for (const casing of world.casings) {
    casing.x += casing.vx * dt;
    casing.y += casing.vy * dt;
    casing.vx *= 0.87;
    casing.vy *= 0.87;
    casing.angle += casing.spin * dt;
    casing.life -= dt;
  }
  world.casings = world.casings.filter((c) => c.life > 0);
}
