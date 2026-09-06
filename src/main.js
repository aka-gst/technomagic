/*
 * ТЕХНОМАГИЯ — сборка игры.
 *
 * Здесь живёт то, что связывает остальное: цикл кадра, камера, прицел,
 * экраны между попытками и перезапуск. Правил боя тут нет — они в
 * world.js, поведения врагов нет — оно в ai.js.
 */

import { CAMPAIGN } from './levels.js';
import { systemicLabel } from './systemic-room.js';
import { decode, encode } from './level.js';
import { createWorld, update } from './world.js';
import { AIM_CONE, assistAim, closeThreat, hasTargetUnderAim, lockTarget, keepPicked, cycleTarget, targetNear } from './aim.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';
import { createAudio } from './audio.js';
import { createScore, readBest, writeBest } from './score.js';
import { ELEMENTS, ELEMENT_ORDER, STACK_LIMIT, CHARGE_STEP, spellOf, colourOf } from './magic.js';
import { parseHash, buildLink, compare, cleanNick, NICK_KEY } from './challenge.js';
import { loadBook, noteSpell, noteObservation, bookPages, bookCount, elementMarks } from './book.js';
import { iconTag } from './icons.js';
import { pulse } from './pulse.js';
import { createTrace, traceEvent, traceKey, traceDelivery } from './trace.js';
import { createEpisodeShowcase, createShowcase, withSeed } from './showcase.js';
import { loadArt } from './art.js';
import { operationResult } from './operation.js';
import { physicalHint } from './observations.js';

const $ = (id) => document.getElementById(id);

const canvas = $('screen');
const renderer = createRenderer(canvas);
const input = createInput(canvas);
const audio = createAudio();

const ui = {
  kills: $('kills'),
  clock: $('clock'),
  toast: $('toast'),
  veil: $('veil'),
  veilKicker: $('veilKicker'),
  veilTitle: $('veilTitle'),
  veilText: $('veilText'),
  veilStats: $('veilStats'),
  veilAction: $('veilAction'),
  veilSecond: $('veilSecond'),
  veilCode: $('veilCode'),
  codeBox: $('codeBox'),
  veilScore: $('veilScore'),
  rankLetter: $('rankLetter'),
  scoreLines: $('scoreLines'),
  scoreTotal: $('scoreTotal'),
  scoreBest: $('scoreBest'),
  score: $('score'),
  systemic: $('systemic'),
  systemicActions: $('systemicActions'),
  combo: $('combo'),
  target: $('target'),
  targetTime: $('targetTime'),
  veilShare: $('veilShare'),
  nickBox: $('nickBox'),
  linkBox: $('linkBox'),
  stack: $('stack'),
  form: $('form'),
  mute: $('mute'),
  ghostMove: $('ghostMove'),
  ghostAim: $('ghostAim'),
  tome: $('tome'),
  tomeCount: $('tomeCount'),
  tomeSubstances: $('tomeSubstances'),
  tomeSignatures: $('tomeSignatures'),
  tomeObservations: $('tomeObservations'),
  tomeClose: $('tomeClose'),
  tomeOpen: $('tomeOpen'),
  found: $('found'),
  foundKicker: $('foundKicker'),
  foundName: $('foundName'),
  foundNote: $('foundNote'),
  operationHud: $('operationHud'),
  operationGoal: $('operationGoal'),
  operationOptional: $('operationOptional'),
  operationLesson: $('operationLesson'),
  physicalObservation: $('physicalObservation'),
};

/*
 * Книга живёт рядом с игрой, а не внутри мира: мир не знает, что игрок
 * уже видел, и знать не должен — иначе один и тот же этаж вёл бы себя
 * по-разному у двух людей и перестал бы быть тем же этажом.
 */
const book = loadBook();

/*
 * Стихии набираются правой рукой: четыре на стрелках, пятая — на правом
 * шифте под ними. Слэш пробовали и убрали: до него приходится тянуться
 * через весь нижний ряд, а шифт лежит там же, где и так стоит ладонь.
 * Цифровой ряд оставлен дубликатом — кому-то привычнее он, а стоит это
 * пяти строк.
 *
 * Сброс очереди уехал со стрелки вниз на Q и Backspace: стрелку забрала
 * земля. Q — потому что левая рука на WASD и мизинец до неё дотягивается,
 * не отпуская хода.
 */
const CHARGE_KEYS = {
  ArrowLeft: 'fire',
  ArrowUp: 'water',
  ArrowRight: 'wind',
  ArrowDown: 'earth',
  ShiftRight: 'bolt',
  Digit1: 'fire',
  Digit2: 'water',
  Digit3: 'wind',
  Digit4: 'earth',
  Digit5: 'bolt',
};

const SFX_BY_EVENT = {
  shot: 'shot',
  swing: 'swing',
  impact: 'impact',
  'charge-start': 'charge',
  charge: 'land',
  'daemon-windup': 'beamup',
  resist: 'resist',
  knock: 'knock',
  kill: 'kill',
  death: 'death',
  pickup: 'pickup',
  dry: 'dry',
  glass: 'glass',
  panel: 'chain',
  slam: 'impact',
  spot: 'spot',
  cleared: 'exit',
  chain: 'chain',
  ignite: 'ignite',
  doused: 'doused',
  spill: 'doused',
};

let levelIndex = 0;
let custom = false;
let challenge = null;   /* чужой результат, если этаж открыт по ссылке */
let locked = null;      /* цель, за которую держится прицел на клавиатуре */
let picked = null;      /* цель, выбранная руками: тап, клик или Tab */
let level = CAMPAIGN[0];
let world = null;
let score = null;
let levelCode = '';
let result = null;
let scene = 'call';          /* call → play → dead | clear, плюс pause */
let view = { x: 0, y: 0 };
let lastView = { zoom: 1, camX: 0, camY: 0 };
let toastTimer = 0;
let tomeVisible = false;
let foundTimer = 0;
let deathHold = 0;
let attempts = 0;


/* =========================================================
   ЧУЖОЙ ЭТАЖ ИЗ АДРЕСА
   ========================================================= */

/*
 * Уровень целиком лежит в ссылке. Редактора пока нет, но канал уже
 * рабочий: код из адресной строки проходит тот же путь, что пройдёт код
 * из чужих рук.
 */
function levelFromHash() {
  const parsed = parseHash(location.hash);
  challenge = parsed.challenge;
  if (!parsed.code) return null;

  try {
    const outside = decode(parsed.code);
    outside.title = challenge ? 'ВЫЗОВ' : 'ЧУЖОЙ ЭТАЖ';
    outside.call = challenge
      ? `${challenge.nick} прошёл этот этаж за ${formatTime(challenge.time)}, ранг ${challenge.rank}. Автоответчик передал вызов — теперь твоя очередь.`
      : 'Код прислали снаружи. Кто там внутри — в сообщении не сказано.';
    return outside;
  } catch (error) {
    setToast(`КОД НЕ ОТКРЫЛСЯ: ${error.message}`, 5);
    return null;
  }
}


/* =========================================================
   ВЫЗОВ
   ========================================================= */

function readNick() {
  try {
    return cleanNick(localStorage.getItem(NICK_KEY) || '');
  } catch (error) {
    return '';
  }
}

function rememberNick(nick) {
  try { localStorage.setItem(NICK_KEY, nick); } catch (error) { /* приватный режим */ }
}

/* Ссылка перестраивается на каждое нажатие в поле имени: подписаться под
   вызовом должно быть так же дёшево, как его скопировать. */
function refreshLink() {
  if (!result) return;
  const base = location.origin + location.pathname;
  ui.linkBox.value = buildLink(base, levelCode, {
    nick: ui.nickBox.value,
    time: world.time,
    score: result.total,
    rank: result.rank,
  });
}


/* =========================================================
   ЭКРАНЫ
   ========================================================= */

function showVeil(config) {
  ui.veilKicker.textContent = config.kicker || '';
  ui.veilTitle.textContent = config.title || '';
  ui.veilText.textContent = config.text || '';
  ui.veilStats.innerHTML = config.stats || '';
  ui.veilAction.textContent = config.action || 'ДАЛЬШЕ';
  ui.veilSecond.textContent = config.second || '';
  ui.veilSecond.hidden = !config.second;
  ui.veilCode.hidden = !config.code;
  if (config.code) ui.codeBox.value = config.code;

  ui.veilScore.hidden = !config.result;
  if (config.result) fillScore(config.result, config.best, config.record);

  ui.veilShare.hidden = !config.share;
  if (config.share) {
    ui.nickBox.value = readNick();
    refreshLink();
  }
  ui.veil.hidden = false;
  ui.veil.dataset.tone = config.tone || 'call';
  audio.setMenu(true);
}

function hideVeil() {
  ui.veil.hidden = true;
  audio.setMenu(false);
}

/*
 * Разбор забега. Строки приходят из score.js уже посчитанными — здесь
 * только вёрстка, чтобы правила начисления жили в одном месте.
 */
function fillScore(final, best, record) {
  ui.veilScore.dataset.rank = final.rank;
  ui.rankLetter.textContent = final.rank;

  ui.scoreLines.innerHTML = final.lines
    .map((line) => `<li><span>${line.label}</span><b>${line.value ? '+' + line.value : '—'}</b></li>`)
    .join('');

  ui.scoreTotal.textContent = final.total;

  if (record) {
    ui.scoreBest.textContent = 'НОВЫЙ РЕКОРД ЭТАЖА';
    ui.scoreBest.dataset.record = '1';
  } else if (best) {
    ui.scoreBest.textContent = `ЛУЧШЕЕ: ${best.total} · РАНГ ${best.rank}`;
    ui.scoreBest.dataset.record = '0';
  } else {
    ui.scoreBest.textContent = '';
    ui.scoreBest.dataset.record = '0';
  }
}

function setToast(text, seconds = 2) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  toastTimer = seconds;
}

/*
 * Подсказка перечисляет только то, что этаж даёт. Перечислять все пять
 * стихий на этаже, где их две, — верный способ научить человека жать
 * кнопки, которые молчат.
 */
/* Пальцем играют или клавишами — от этого зависит каждая подсказка в игре.
   Одна дверь на все места, где это надо знать. */
function byTouch() {
  return input.isTouch() || matchMedia('(pointer: coarse)').matches;
}

function controlsHint() {
  const given = (level.elements || ELEMENT_ORDER)
    .map((id) => `${ELEMENTS[id].key} ${ELEMENTS[id].name}`)
    .join(' ');

  return byTouch()
    ? 'ЛЕВЫЙ ПАЛЕЦ ПО ПОЛЮ ВЕДЁТ, ПРАВЫЙ ЦЕЛИТ И БЬЁТ САМ. '
      + 'КНОПКИ ВНИЗУ НАБИРАЮТ СТИХИИ, БОЛЬШАЯ ВЫПУСКАЕТ.'
    : `WASD — ИДТИ. СТИХИИ: ${given} — ИЛИ МЫШЬЮ ПО КНОПКАМ ВНИЗУ. `
      + 'КЛИК ПО БОЧКЕ ИЛИ ВРАГУ НАВОДИТ НА НЕГО, TAB МЕНЯЕТ ЦЕЛЬ ПО КРУГУ, '
      + 'КЛИК ПО ПУСТОМУ МЕСТУ СНИМАЕТ. ПРОБЕЛ ИЛИ ПУСК ВЫПУСКАЕТ, Q СБРАСЫВАЕТ. '
      + 'СОСТАВ РЕШАЕТ, ЧТО ВЫЛЕТИТ, ПОРЯДОК — КАКОЙ ФОРМЫ. B — КНИГА, R — ЗАНОВО.';
}

/*
 * Панель пяти клавиш. Подписи берутся из самих стихий, поэтому смена
 * раскладки не требует править разметку: молния переехала со слэша на
 * шифт — панель узнала об этом сама.
 *
 * Недоступное на этаже тушится, а не прячется: игрок должен видеть, что
 * стихий пять, и какие ещё впереди. Обещания тут нет — по такой кнопке
 * сразу видно, что она закрыта.
 */
function syncElementButtons() {
  const given = level.elements || ELEMENT_ORDER;

  for (const id of ELEMENT_ORDER) {
    const button = $(`btn-${id}`);
    if (!button) continue;

    const element = ELEMENTS[id];
    const open = given.includes(id);

    button.innerHTML = `<b>${element.key}</b><i>${element.name}</i>`;
    button.style.color = open ? element.colour : '#8fa39b';
    button.dataset.locked = open ? '0' : '1';
    button.disabled = !open;
  }
}

/* Подсветка нажатой стихии: набирается — горит. Иначе панель остаётся
   картинкой, а она должна отвечать. */
function markCharging() {
  const charging = world && world.player.alive ? world.player.charging : null;
  for (const id of ELEMENT_ORDER) {
    const button = $(`btn-${id}`);
    if (button) button.dataset.active = id === charging ? '1' : '0';
  }
}

/*
 * Находка объявляется крупно и по центру. Всё остальное в этой игре можно
 * прочитать потом в книге; новое заклинание — единственное, что надо
 * заметить сейчас, иначе игрок так и не узнает, что нашёл его.
 */
function showFound(kicker, name, note, colour) {
  ui.foundKicker.textContent = kicker;
  ui.foundName.textContent = name;
  ui.foundName.style.color = colour;
  ui.foundNote.textContent = note || '';
  ui.found.hidden = false;

  /* Пересборка анимации: без неё вторая находка подряд не «щёлкает». */
  ui.found.style.animation = 'none';
  void ui.found.offsetWidth;
  ui.found.style.animation = '';

  foundTimer = 2.6;
}


/* =========================================================
   ЗАПУСК ЭТАЖА
   ========================================================= */

function startLevel(next, { silent } = {}) {
  const changed = next && next !== level;
  level = next || level;
  if (changed || !levelCode) levelCode = encode(level);

  world = createWorld(level);
  syncElementButtons();
  tutorStart();
  view = { x: world.player.x, y: world.player.y };
  renderer.invalidate();
  scene = 'play';
  hideVeil();
  attempts += 1;
  result = null;
  locked = null;
  picked = null;
  score = createScore(level, attempts);
  if (!silent) audio.playTrack(level.track || 0);

  trace = createTrace();

  /* Начало попытки. Номер попытки здесь важнее всего остального: он и
     отвечает на вопрос, сколько раз человек готов вернуться. */
  pulse('etazh-nachat', { etazh: level.title, popytka: attempts });
  updateHud(true);
}

function callScreen() {
  scene = 'call';
  const best = readBest(levelCode);

  showVeil({
    tone: 'call',
    kicker: 'СООБЩЕНИЕ · 03:14',
    title: level.title,
    text: level.call,
    stats: `<span>${controlsHint()}</span>`
      + (best ? `<span>ЛУЧШЕЕ ЗДЕСЬ: ${best.total} · РАНГ ${best.rank} · ${formatTime(best.time)}</span>` : '')
      /* Выключенный звук переживает перезагрузку, и молчащая игра выглядит
         сломанной. Пусть об этом будет сказано там, где на это смотрят. */
      + (audio.isMuted() ? '<span data-warn="1">ЗВУК ВЫКЛЮЧЕН — КЛАВИША M ВКЛЮЧАЕТ</span>' : ''),
    action: 'ВЗЯТЬ КЛЮЧИ',
  });
}

function deathScreen() {
  scene = 'dead';

  /*
   * Смерть от своей же руки — не то же самое, что смерть от чужой, и
   * называться должна иначе. Считаем своей ту, что случилась в пределах
   * пары секунд после собственного пожара или своего разряда: дальше это
   * уже совпадение, а не причина.
   */
  const ownDeath = selfHarm && world.time - selfHarm.at < 2.5 ? selfHarm.kind : null;
  selfHarm = null;

  /* Смерть с числами: сколько успел вырезать и сколько прожил. По ним
     видно разницу между «не понял управление» и «не хватило чуть-чуть». */
  pulse('smert', {
    etazh: level.title,
    popytka: attempts,
    vyrezano: world.kills,
    vsego: world.total,
    sekund: Math.round(world.time),
  });
  showVeil({
    tone: 'dead',
    kicker: `ПОПЫТКА ${attempts}`,
    title: ownDeath ? 'САМ' : 'ТЕБЯ УБИЛИ',
    text: ownDeath
      ? (ownDeath === 'fire'
        ? 'Ты сгорел в своём собственном костре. Огонь не смотрит, кто его позвал: он просто идёт по соломе дальше — и по тебе тоже.'
        : 'Ты сам разлил воду, сам в неё встал и сам пустил по ней разряд. Ток не спрашивает, чья лужа.')
      : 'Здесь умирают с одного удара — и ты, и они. Разница только в том, кто ударил первым.',
    stats: `<span>ВЫРЕЗАНО ${world.kills} ИЗ ${world.total}</span><span>${formatTime(world.time)}</span>`
      + `<span>СГОРЕЛО ОЧКОВ: ${score.state.score}</span>`,
    action: 'ЗАНОВО',
  });
}

function hasNextFloor() {
  return !custom && levelIndex + 1 < CAMPAIGN.length;
}

function clearScreen() {
  scene = 'clear';

  result = score.finish(world);

  if (world.operation) {
    const facts = operationResult(world);
    const hostage = facts.hostage === 'rescued' ? 'СПАСЁН'
      : facts.hostage === 'dead' ? 'ПОГИБ' : 'ОСТАВЛЕН';
    showVeil({
      tone: 'clear',
      kicker: 'ОПЕРАЦИЯ ЗАВЕРШЕНА',
      title: 'ЯДРО У ТЕБЯ',
      text: 'Мир запомнил не способ, а последствия.',
      stats: `<span>ЗАЛОЖНИК: ${hostage}</span>`
        + `<span>МИРНЫЕ: ЖИВЫ ${facts.civiliansAlive} · ПОГИБЛИ ${facts.civiliansDead}</span>`
        + `<span>ОХРАНА: ДЕЙСТВУЕТ ${facts.guardsActive} · БЕЗ СОЗНАНИЯ ${facts.guardsUnconscious} · ПОГИБЛА ${facts.guardsDead}</span>`
        + `<span>ШУМНЫЕ ИНЦИДЕНТЫ ${facts.alerts} · ВРЕМЯ ${formatTime(facts.time)}</span>`,
      action: 'ЕЩЁ РАЗ',
      second: 'СТАРЫЕ ЭТАЖИ',
    });
    return;
  }

  pulse('etazh-zachischen', {
    etazh: level.title,
    popytka: attempts,
    sekund: Math.round(world.time),
    rang: result.rank,

    /*
     * След решения. Отвечает не на «прошёл ли», а на «чем прошёл», и
     * только он позволяет посчитать, сколькими разными способами комнату
     * проходят. Про человека в нём нет ничего.
     */
    sled: traceKey(trace),
    pravil: trace.rules.size,
    chem: traceDelivery(trace),
  });
  const record = writeBest(levelCode, result, world.time);
  const more = hasNextFloor();

  /* Вызов принят или нет — это первое, что должно быть видно на экране. */
  const duel = compare({ time: world.time, score: result.total }, challenge);
  const verdict = duel
    ? (duel.beaten
      ? `ВЫЗОВ ПРИНЯТ: БЫСТРЕЕ ${challenge.nick} НА ${formatTime(duel.delta)}`
      : `${challenge.nick} ВСЁ ЕЩЁ БЫСТРЕЕ НА ${formatTime(duel.delta)}`)
    : '';

  showVeil({
    tone: 'clear',
    kicker: duel ? (duel.beaten ? 'ВЫЗОВ ОТБИТ' : 'ВЫЗОВ НЕ ВЗЯТ') : 'ЭТАЖ СДАН',
    title: duel ? (duel.beaten ? 'ТЫ БЫСТРЕЕ' : 'ПОКА МЕДЛЕННЕЕ') : (more ? 'СЛЕДУЮЩЕЕ СООБЩЕНИЕ' : 'ТИХО'),
    text: duel
      ? 'Отправь ссылку обратно — в ней твой результат и тот же самый этаж.'
      : (more
        ? 'Автоответчик уже мигает. Очки платят за темп: цепочка обрывается через четыре секунды без убийства.'
        : 'Этаж сдан. Отправь его кому-нибудь: ссылка несёт и уровень, и твоё время.'),
    stats: `<span>ВРЕМЯ ${formatTime(world.time)}</span><span>ПОПЫТОК ${attempts}</span>`
      + (verdict ? `<span>${verdict}</span>` : ''),
    share: true,
    action: more ? 'СЛЕДУЮЩИЙ ЭТАЖ' : 'ПРОЙТИ ЧИЩЕ',
    second: more ? 'ПРОЙТИ ЭТОТ ЧИЩЕ' : 'ВЫЙТИ В МЕНЮ',
    result,
    best: record.best,
    record: record.record,
  });
}

function pauseScreen() {
  scene = 'pause';
  showVeil({
    tone: 'pause',
    kicker: 'ПАУЗА',
    title: level.title,
    text: 'Этаж целиком помещается в эту строку. Скопируй её — и тот, кому дашь, откроет ровно этот же этаж.',
    stats: `<span>${controlsHint()}</span>`,
    action: 'ПРОДОЛЖИТЬ',
    second: 'НАЧАТЬ ЭТАЖ ЗАНОВО',
    code: levelCode,
  });
}

function formatTime(seconds) {
  const total = Math.floor(seconds * 10) / 10;
  const minutes = Math.floor(total / 60);
  const rest = (total - minutes * 60).toFixed(1).padStart(4, '0');
  return `${minutes}:${rest}`;
}


/* =========================================================
   ПРИЦЕЛ
   ========================================================= */

function buildIntent(raw) {
  const player = world.player;
  const intent = {
    moveX: raw.moveX,
    moveY: raw.moveY,
    aimAngle: null,
    attack: false,
    charge: null,
    /* Сброс набранного: время потрачено, но выпустить не туда — хуже. */
    dump: input.tookKey('KeyQ') || input.tookKey('Backspace'),
  };

  /* Забираем все три нажатия, а не первое: иначе непрочитанное всплывёт кадром позже. */
  for (const code of Object.keys(CHARGE_KEYS)) {
    if (input.tookKey(code)) intent.charge = CHARGE_KEYS[code];
  }

  /*
   * Тап и клик по полю выбирают цель — то же, что Tab, только сразу в
   * нужную, а не по кругу. Промах по пустому месту снимает выбор: иначе
   * от навязанной цели нельзя было бы избавиться, не убив её.
   */
  const tapped = input.tookTap();
  if (tapped) {
    const at = renderer.toWorld(tapped.x, tapped.y, lastView);
    const target = targetNear(world, at.x, at.y);
    if (target) {
      picked = target;
      audio.sfx('spot');
    } else {
      picked = null;
    }
  }

  /* Мёртвое и разбитое перестаёт быть целью само — но подменять его на
     соседнее нельзя: выбор делал игрок. */
  if (picked && picked.alive === false) picked = null;
  if (picked) picked = keepPicked(world, picked);

  if (raw.aimStick !== null) {
    /* Стик — это прямое прицеливание рукой, и оно главнее выбранной цели. */
    picked = null;
    locked = null;
    world.locked = null;
    intent.aimAngle = assistAim(world, raw.aimStick, AIM_CONE.stick);
  } else if (picked) {
    /*
     * Выбранная руками цель держится, чем бы игрок ни водил. Раньше её
     * стирало любое движение мыши — то есть на настольном компьютере
     * выбор не работал вовсе, ни тапом, ни клавишей: следующий же кадр
     * возвращал прицел под курсор.
     */
    locked = picked;
    world.locked = picked;
    intent.aimAngle = Math.atan2(picked.y - player.y, picked.x - player.x);
  } else if (!raw.touch && raw.mouse.moved) {
    locked = null;
    world.locked = null;
    /* Курсор показывает на ромб, а мир считает по квадрату: перевод знает
       только отрисовка, у неё и спрашиваем. */
    const at = renderer.toWorld(raw.mouse.x, raw.mouse.y, lastView);
    intent.aimAngle = assistAim(world, Math.atan2(at.y - player.y, at.x - player.x), AIM_CONE.mouse);
  } else {
    /*
     * Мышь не трогают — значит, играют с клавиатуры, и прицел держится за
     * живую цель сам. Бежать при этом можно куда угодно: направление бега
     * больше не решает, куда смотрит игрок.
     */
    locked = lockTarget(world, locked, player.angle);
    world.locked = locked;

    if (locked) {
      intent.aimAngle = Math.atan2(locked.y - player.y, locked.x - player.x);
    } else if (raw.moveX || raw.moveY) {
      intent.aimAngle = assistAim(world, Math.atan2(raw.moveY, raw.moveX), AIM_CONE.run);
    } else {
      intent.aimAngle = closeThreat(world, player.stack.length ? 300 : 130);
    }
  }

  /* Удержание — это очередь ударов, а не один: темп задаёт откат оружия. */
  const fired = input.tookKey('Fire') || input.tookKey('Space')
    || input.tookKey('Enter') || input.tookKey('KeyJ');
  intent.attack = fired || raw.attackHeld;

  /*
   * Палец не умеет одновременно целиться стиком и жать кнопку: это один и
   * тот же большой палец. Поэтому наведённый на цель стик бьёт сам —
   * но только когда цель действительно под прицелом, иначе обойма
   * уходит в стену за две секунды.
   */
  if (!intent.attack && raw.aimStick !== null && intent.aimAngle !== null) {
    intent.attack = hasTargetUnderAim(world, intent.aimAngle);
  }

  return intent;
}

/* =========================================================
   ОБУЧАЛКА
   =========================================================
   Первый этаж учит не кнопкам, а главному правилу игры:
   стихии работают друг через друга. Огонь вскрывает бочку,
   вода из неё разливается под ногами у врагов, разряд в
   лужу забирает троих разом.

   Подсказки идут по событиям мира, а не по таймеру: игрок
   узнаёт про бочку, когда убил первого, и про молнию —
   когда вода уже на полу. Сказанное заранее не запоминается.
   ========================================================= */

let tutorStep = 0;

/*
 * ОБУЧАЛКА
 * =========================================================
 * Две фразы, и обе в первых двух комнатах. Дальше молчим.
 *
 * Так просил автор дословно: «выстрели в эту точку, чтобы понять, как
 * работает магия; тут собери линию — а потом тебя отпускают в уровень, и
 * там ты уже сам барахтайся». Ключевое слово — отпускают. Подсказка,
 * которая идёт весь этаж, отменяет игру: придумывать нечего, за игрока
 * уже придумали, а предвкушение связки и есть то, ради чего в это играют.
 *
 * Последняя фраза — «ДАЛЬШЕ САМ» — не украшение. Игрок должен знать, что
 * подсказок больше не будет, иначе он будет их ждать и не начнёт пробовать.
 */
/*
 * ПОДКОЛЫ
 * =========================================================
 * Игра про то, как убить всех разом, — и ровно в той же мере про то, как
 * при этом уцелеть. Собственный пожар и своя лужа под током не изъян, а
 * половина тактики, поэтому наказывать за них скучной строкой нельзя:
 * над этим надо смеяться.
 *
 * Первый раз, впрочем, объясняем. Игрок, который горит впервые, не знает,
 * что делать, и шутка вместо инструкции — это издевательство, а не юмор.
 * Дальше объяснять нечего, и слово переходит к насмешке.
 */
const JABS = {
  ignite: [
    'ГОРИШЬ КРАСИВО, НО НЕДОЛГО',
    'ОГОНЬ НЕ РАЗБИРАЕТ, КТО ЕГО ЗВАЛ',
    'ЗАЖИГАЛКА СРАБОТАЛА. НА ТЕБЕ',
    'ТЁПЛО? ЭТО ТЫ',
    'СВОЙ ЖЕ КОСТЁР. ПОЗДРАВЛЯЕМ',
  ],
  shock: [
    'ТОК НЕ СПРАШИВАЕТ, ЧЬЯ ЛУЖА',
    'САМ НАЛИЛ, САМ И ВСТАЛ',
    'ФИЗИКА РАБОТАЕТ В ОБЕ СТОРОНЫ',
    'ГЕНИАЛЬНО. ТЕПЕРЬ ЕЩЁ РАЗ, НО В СТОРОНЕ',
    'ВОДА ПРОВОДИТ. ДАЖЕ ТЕБЯ',
  ],
  sleep: [
    'ДЫШИТ. ЗАПОМНИ, ГДЕ ЛЁГ',
    'МИЛОСЕРДИЕ С ТАЙМЕРОМ',
    'ЖИВОЙ. ЭТО БЫЛ ТВОЙ ВЫБОР',
    'ОДНА СТИХИЯ — ОДИН ОБМОРОК',
    'СПИТ. НЕ ВЕЧНО',
  ],
  wake: [
    'ОТОСПАЛСЯ',
    'ПОДНЯЛСЯ. И НЕ В ДУХЕ',
    'ВСПОМНИЛ ТВОЁ ЛИЦО',
    'ВОТ И ОН',
  ],
  held: [
    'НЕ ВПЕЧАТЛИЛО',
    'ОН ТАКОЕ НА ЗАВТРАК ЕСТ',
    'ИСКРА ЕМУ НЕ СОПЕРНИК — НУЖНО ВЕЩЕСТВО',
    'ЩЕКОТНО. ПОПРОБУЙ СЕРЬЁЗНЕЕ',
  ],
  gust: [
    'ПОЛЕТЕЛ. КУДА — ТВОЁ ДЕЛО',
    'ОДНА СТИХИЯ ТОЛЬКО ДВИГАЕТ',
    'ВЕТЕР ГОТОВИТ, УБИВАЕТ ЧТО-ТО ДРУГОЕ',
    'ТЕПЕРЬ ОН СНАРЯД',
  ],
  slam: [
    'ПРИЛОЖИЛО',
    'СТЕНА ВЫИГРАЛА',
    'ЛЁД ДОВЁЗ',
    'РАЗОГНАЛСЯ И ПРИЕХАЛ',
  ],
  fling: [
    'КЕГЛЯ',
    'ОДНИМ ТЕЛОМ ДВОИХ',
    'ОН ПРИЛЕТЕЛ НЕ ОДИН',
    'БИЛЬЯРД',
  ],
  hack: [
    'У ЩИТКА НИКТО НЕ УСЛЫШАЛ',
    'СОСТАВ ДАЁТ ТОЧНОСТЬ, А НЕ СИЛУ',
    'ЩИТОК ЖИВ — МОЖНО ВЕРНУТЬ ОБРАТНО',
    'НИКОГО ТУДА НЕ ПОЗВАЛО',
  ],
  panel: [
    'ПУСТЬ СХОДЯТ ПОСМОТРЯТ',
    'ИСКРИТ ТАМ. ТЫ ЗДЕСЬ',
    'ЛУЧШИЙ ВЫСТРЕЛ — В СТОРОНУ',
    'ШУМ БЕЗ СВИДЕТЕЛЕЙ',
  ],
  backfire: [
    'ВСПЫШКА В ТЕСНОТЕ — ПРИВЕТ ОТ СЕБЯ',
    'РАДИУС БОЛЬШЕ КОМНАТЫ. КАК И ЗАДУМАНО?',
    'ВЗОРВАЛ ВСЕХ. СЕБЯ В ТОМ ЧИСЛЕ',
  ],
};

const jabSeen = {};

/* Чем игрок навредил себе последний раз и когда. Экран смерти
   спрашивает об этом, чтобы не говорить «тебя убили» тому, кто убил
   себя сам: это разные события и разного тона. */
let selfHarm = null;

/* Чем прошли эту попытку. Живёт от начала этажа до его конца. */
let trace = createTrace();

/* Сколько стихий было в очереди на прошлом кадре: по разнице видно, что
   одна только что легла, и её ячейку надо зажечь. */
let landed = 0;

/* Идёт съёмка витрины. Пока не null — игра стоит, а кадр рисует сцена. */
let shooting = null;

function jab(kind, first) {
  const seen = jabSeen[kind] || 0;
  jabSeen[kind] = seen + 1;

  /* Первый раз — что делать. Дальше — что о тебе думают. */
  if (!seen) return first;

  const lines = JABS[kind];
  return lines[Math.floor(Math.random() * lines.length)];
}

const TUTOR_STEPS = [
  {
    on: (event) => event.type === 'kill',
    say: 'СОБЕРИ ЛИНИЮ: ТРИ ОДИНАКОВЫХ — ЛУЧ. ОН ИДЁТ НАСКВОЗЬ',
  },
  {
    on: (event) => event.type === 'crystal',
    say: 'ДАЛЬШЕ САМ',
  },
];

function tutorStart() {
  tutorStep = level.tutorial ? 1 : 0;
  /* Клавиши берутся из самих стихий: раскладка уже переезжала, и вшитый
     в текст слэш пережил бы переезд и врал бы игроку. */
  if (!tutorStep) return;

  setToast(byTouch()
    ? 'ЖМИ ОГОНЬ ВНИЗУ, ПОТОМ ПУСК'
    : `НАБЕРИ ${ELEMENTS.fire.key} ОГОНЬ, ЖМИ ПРОБЕЛ. ${ELEMENTS.bolt.key} — МОЛНИЯ`,
  3.6);
}

function tutorFeed(event) {
  if (!tutorStep) return;

  const step = TUTOR_STEPS[tutorStep - 1];
  if (!step || !step.on(event)) return;

  tutorStep += 1;
  setToast(step.say, 4.2);
}


/* =========================================================
   КНИГА
   ========================================================= */

function renderTome() {
  const pages = bookPages(book);
  const count = bookCount(book);

  ui.tomeCount.textContent =
    `${count.substances}/${count.substancesTotal} · ИМЕННЫХ ${count.signatures}/${count.signaturesTotal}`
    + ` · МИР ${count.observations}/${count.observationsTotal}`;

  ui.tomeSubstances.innerHTML = pages.substances.map((entry) => {
    const marks = elementMarks(entry.elements)
      .map((element) => `<i style="background:${entry.known ? element.colour : '#4a4358'}"></i>`)
      .join('');

    /* Неоткрытое показывает размер состава: это и есть подсказка, где
       искать, — и единственная, какую книга даёт. */
    const name = entry.known
      ? `<b class="tome-name" style="color:${entry.colour}">${entry.name}</b>`
      : `<b class="tome-name">${'?'.repeat(entry.size + 2)}</b>`;
    const note = entry.known && entry.note
      ? `<span class="tome-note">${entry.note}</span>`
      : '';

    /* Значок только у открытого: закрытая клетка обязана оставаться
       вопросом, а картинка выдала бы ответ раньше времени. */
    const icon = entry.known ? iconTag(entry.name) : '';

    return `<div class="tome-cell" data-known="${entry.known ? 1 : 0}">`
      + `<span class="tome-marks">${marks}</span>${icon}${name}${note}</div>`;
  }).join('');

  /*
   * Заклинание попадает в список, как только известно его вещество: игрок
   * должен видеть, что в ЛАВЕ что-то есть, и искать порядок, а не гадать,
   * существует ли то, что он ищет. Остальные сворачиваются в одну строку —
   * десять одинаковых «???» подряд не сообщают ничего, кроме длины списка.
   */
  const shown = pages.signatures.filter((entry) => entry.known || entry.hinted);
  const rest = pages.signatures.length - shown.length;

  ui.tomeSignatures.innerHTML = shown.map((entry) => {
    if (entry.known) {
      return `<li data-known="1" style="border-left-color:${entry.colour}">`
        + iconTag(entry.name)
        + `<b class="tome-sign" style="color:${entry.colour}">${entry.name}</b> `
        + `<span class="tome-recipe">${entry.substance} · ${entry.form}</span>`
        + `<br><span class="tome-note">${entry.note}</span></li>`;
    }

    return `<li data-known="0" style="border-left-color:${entry.colour}">`
      + `<b class="tome-sign">???</b> `
      + `<span class="tome-recipe">${entry.substance} · ${entry.form}</span>`
      + `<br><span class="tome-note">${entry.formHint}</span></li>`;
  }).join('')
    + (rest
      ? `<li data-known="0"><span class="tome-note">`
        + `ещё ${rest} — их вещества пока не открыты</span></li>`
      : '');

  ui.tomeObservations.innerHTML = pages.observations.map((entry) => (
    entry.known
      ? `<li data-known="1"><b class="tome-sign">${entry.name}</b>`
        + `<br><span class="tome-note">${entry.note}</span></li>`
      : '<li data-known="0"><b class="tome-sign">???</b>'
        + '<br><span class="tome-note">Наблюдай последствия действий.</span></li>'
  )).join('');
}

function showTome() {
  /* Книга — половина игры, и до сих пор неизвестно, открывает ли её
     кто-нибудь вообще. Считаем только сам факт открытия и сколько к тому
     моменту найдено: что именно найдено — это уже про человека. */
  pulse('kniga-otkryta', { naydeno: bookCount(book).substances });

  renderTome();
  ui.tome.hidden = false;
  tomeVisible = true;
}

function hideTome() {
  ui.tome.hidden = true;
  tomeVisible = false;
}

function toggleTome() {
  if (tomeVisible) hideTome();
  else showTome();
}


/* =========================================================
   HUD
   ========================================================= */

function updateHud(force) {
  const player = world.player;

  const player2 = world.player;
  const loaded = spellOf(player2.stack);
  const key = player2.stack.join('') + (player2.charging || '')
    + (player2.chargeLeft > 0 ? Math.round((1 - player2.chargeLeft / CHARGE_STEP) * 6) : '');

  if (force || ui.stack.dataset.key !== key) {
    ui.stack.dataset.key = key;
    let slots = '';
    for (let i = 0; i < STACK_LIMIT; i += 1) {
      const element = player2.stack[i];
      if (element) {
        /*
         * Только что легшая стихия помечается отдельно и вспыхивает.
         * Набор из трёх — это три события, а не одно действие: между
         * ними и живёт предвкушение связки, ради которого в игру играют.
         * Пока ячейка просто оказывалась заполненной, три нажатия
         * читались как одно движение руки.
         */
        const fresh = i === player2.stack.length - 1 && landed === player2.stack.length;
        slots += `<i class="${fresh ? 'is-landed' : ''}" style="background:${colourOf(element)};`
          + `box-shadow:0 0 8px ${colourOf(element)}"></i>`;
      } else if (i === player2.stack.length && player2.chargeLeft > 0) {
        const fill = 1 - player2.chargeLeft / CHARGE_STEP;
        slots += `<i class="is-charging" style="border-color:${colourOf(player2.charging)};`
          + `background:linear-gradient(to top, ${colourOf(player2.charging)} ${Math.round(fill * 100)}%, transparent 0)"></i>`;
      } else {
        slots += '<i></i>';
      }
    }
    ui.stack.innerHTML = slots;

    /*
     * Подпись говорит две разные вещи и потому не молчит никогда: пока
     * стихия набирается — её имя, как только легла — имя формы, которая
     * вылетит. Раньше здесь было пусто ровно в тот момент, когда игрок
     * больше всего хотел знать, что у него в руке.
     */
    if (player2.chargeLeft > 0) {
      ui.form.textContent = `${ELEMENTS[player2.charging].name}…`;
      ui.form.style.color = colourOf(player2.charging);
      ui.form.hidden = false;
    } else if (loaded) {
      /*
       * Две оси набора показываются врозь, потому что и решаются врозь:
       * состав говорит, что вылетит, узор — какой формы. Игрок, видящий
       * «СТУЖА · ВЫДОХ», понимает, что вторая половина зависит от порядка,
       * а первая — нет.
       */
      ui.form.textContent = `${loaded.substance.name} · ${loaded.form.name}`;
      ui.form.style.color = loaded.substance.colour;
      ui.form.hidden = false;
    } else {
      ui.form.hidden = true;
    }
  }

  ui.kills.textContent = `${world.kills}/${world.total}`;
  ui.clock.textContent = formatTime(world.time);

  if (world.operation) {
    ui.operationHud.hidden = false;
    ui.operationGoal.textContent = world.operation.coreTaken
      ? 'ВЕРНУТЬСЯ К ВЫХОДУ' : 'УКРАСТЬ ЯДРО';
    ui.operationOptional.textContent = world.hostage?.rescued
      ? 'ЗАЛОЖНИК: СПАСЁН' : world.hostage?.alive
        ? 'ЗАЛОЖНИК: НЕОБЯЗАТЕЛЬНО' : 'ЗАЛОЖНИК: ПОГИБ';
    ui.operationLesson.hidden = world.operation.waterLesson;
    ui.operationLesson.textContent = world.operation.candleLesson
      ? 'ЛУЖА ПРОВОДИТ РАЗРЯД ПО ВСЕМ, КТО С НЕЙ СОЕДИНЁН'
      : 'ЗАЖГИ СВЕЧУ ТОЧНО. ШИРОКИЙ ОГОНЬ ЗАДЕНЕТ ВСЁ РЯДОМ';
  } else {
    ui.operationHud.hidden = true;
  }

  const observation = physicalHint(world, picked);
  ui.physicalObservation.textContent = observation;
  ui.physicalObservation.hidden = !observation;

  if (challenge) {
    ui.target.hidden = false;
    ui.targetTime.textContent = `${challenge.nick} ${formatTime(challenge.time)}`;
    ui.target.dataset.late = world.time > challenge.time ? '1' : '0';
  } else if (!ui.target.hidden) {
    ui.target.hidden = true;
  }

  ui.score.textContent = score.state.score;

  if (world.systemic) {
    ui.systemic.hidden = false;
    ui.systemicActions.textContent = world.systemic.actions;
  } else {
    ui.systemic.hidden = true;
  }

  const combo = score.state.combo;
  if (combo > 1) {
    if (ui.combo.hidden || ui.combo.dataset.value !== String(combo)) {
      ui.combo.hidden = false;
      ui.combo.dataset.value = String(combo);
      ui.combo.firstElementChild.textContent = `×${combo}`;
      /* Пересборка анимации: без неё каждое следующее убийство не «щёлкает». */
      ui.combo.style.animation = 'none';
      void ui.combo.offsetWidth;
      ui.combo.style.animation = '';
    }
    ui.combo.lastElementChild.style.transform = `scaleX(${Math.max(0, score.state.comboLeft / 4)})`;
  } else if (!ui.combo.hidden) {
    ui.combo.hidden = true;
    ui.combo.dataset.value = '';
  }
}

function drainEvents() {
  for (const event of world.events) {
    /* След решения собирается здесь же: все правила, какие срабатывают,
       проходят через события, и второго места для этого не нужно. */
    traceEvent(trace, event);

    const name = SFX_BY_EVENT[event.type];
    if (name) audio.sfx(name, event);

    const observation = noteObservation(book, event);
    if (observation) {
      showFound('НАБЛЮДЕНИЕ МИРА', observation.name, observation.note, '#7ffcff');
      audio.sfx('spot');
    }

    if (event.type === 'daemon') {
      /* Очередь ушла в выстрел — метка «только что легла» больше ни к
         чему не относится и должна погаснуть вместе с ней. */
      landed = 0;

      audio.sfx(event.form === 'beam' ? 'beam' : event.form === 'nova' ? 'nova' : 'zap', event);
      if (event.form === 'nova') vibrate(30);

      /*
       * Находка объявляется один раз — в тот момент, когда случилась.
       * Именное заклинание перебивает вещество: если игрок сразу попал в
       * сигнатуру, важнее сказать про неё.
       */
      const found = noteSpell(book, event);
      if (found.signature) {
        showFound('НАЙДЕНО ЗАКЛИНАНИЕ', found.signature.name, found.signature.note, '#ffe14d');
        audio.sfx('spot');
        vibrate([20, 40, 20]);
      } else if (found.substance) {
        showFound('НОВОЕ ВЕЩЕСТВО', found.substance.name,
          found.substance.note, found.substance.colour);
        audio.sfx('pickup');
      }
    } else if (event.type === 'backfire') {
      setToast(jab('backfire', 'ВСПЫШКА В ТЕСНОТЕ — СВОИМ ЖЕ'), 2.4);
    } else if (event.type === 'charge') {
      landed = event.size;
      updateHud(true);
    } else if (event.type === 'gust') {
      /* Ветер один никого не убивает — и сказать это надо ровно один раз,
         иначе игрок решит, что промахнулся. */
      setToast(jab('gust', 'ВЕТЕР НЕ УБИВАЕТ — ОН ОТПРАВЛЯЕТ'), 2);
      vibrate(8);
    } else if (event.type === 'slam') {
      setToast(jab('slam', 'В СТЕНУ. СТЕНА НЕ МЯГЧЕ ЧЕЛОВЕКА'), 1.8);
      vibrate([14, 22]);
    } else if (event.type === 'fling') {
      /* Новый глагол, и о нём надо сказать: врагами можно бросаться. */
      setToast(jab('fling', 'ТЕЛО ТОЖЕ СНАРЯД'), 1.8);
      vibrate([10, 20]);
    } else if (event.type === 'sleep') {
      /*
       * Новый исход, которого игрок раньше не видел: он ударил, враг не
       * умер и при этом не отбился. Без слов это читается как промах,
       * а не как милосердие. Поэтому первая строка несёт факт, а не
       * шутку: не убит; поднимется ли он, сообщает само событие.
       */
      setToast(jab('sleep', event.permanent
        ? 'НЕ УБИТ — БЕЗ СОЗНАНИЯ. НЕ ПОДНИМЕТСЯ'
        : 'НЕ УБИТ — В ОТКЛЮЧКЕ. ЧЕРЕЗ ВРЕМЯ ВСТАНЕТ'), 2.4);
      vibrate(10);
    } else if (event.type === 'wake' && event.subdued) {
      /* Сбитого с ног в ближнем бою не объявляем — он встаёт каждые две
         секунды, и экран превратился бы в ленту. Объявляем только того,
         кого игрок сознательно оставил в живых. */
      setToast(jab('wake', 'ТОТ САМЫЙ. ПОДНЯЛСЯ'), 2);
      vibrate([8, 14]);
    } else if (event.type === 'held') {
      /* Промаха не было — был неподходящий удар, и сказать это надо
         сразу, иначе игрок решит, что игра его обманула. */
      setToast(jab('held', 'ДЕРЖИТ УДАР — НУЖЕН СОСТАВ, ДОРОГАЯ ФОРМА ИЛИ ДОБИВАНИЕ'), 2.2);
      vibrate(12);
    } else if (event.type === 'resist') {
      setToast(`${ELEMENTS[event.element].name} ЕГО НЕ БЕРЁТ — БЕЙ ДРУГИМ`, 1.8);
    } else if (event.type === 'ignite' && event.player) {
      /* У горящего есть полсекунды и один выход — вода. Сказать об этом
         надо ровно один раз и ровно тогда, а не в подсказках перед боем. */
      setToast(jab('ignite', 'ГОРИШЬ — В ВОДУ ИЛИ В ГРЯЗЬ'), 1.6);
      selfHarm = { kind: 'fire', at: world.time };
      vibrate(20);
    } else if (event.type === 'locked') {
      setToast(`${ELEMENTS[event.element].name} — НЕ НА ЭТОМ ЭТАЖЕ`, 1.4);
    } else if (event.type === 'shocked-self') {
      setToast(jab('shock', 'СВОЯ ЖЕ ЛУЖА ПОД ТОКОМ'), 2.4);
      selfHarm = { kind: 'shock', at: world.time };
    } else if (event.type === 'chain' && event.size > 1) {
      /* Цепь — единственное место, где одно нажатие стоит нескольких, и
         число обязано быть на экране: без него игрок не поймёт, что
         сделал что-то большее, чем обычный выстрел. */
      setToast(`ЦЕПЬ ×${event.size}`, 1.8);
      vibrate([15, 25, 15]);
    } else if (event.type === 'consequence') {
      setToast(`СВЯЗЬ ${event.actions} · ${systemicLabel(event.kind)}`, 1.8);
      vibrate(12);
    } else if (event.type === 'barrel') {
      /* Про воду больше не пишем: она теперь растекается на глазах, и
         подпись успевала объявить её раньше, чем она появлялась. */
      setToast('БОЧКА ВСКРЫТА', 1.4);
    } else if (event.type === 'power') {
      setToast(event.on ? 'ПИТАНИЕ ЕСТЬ — СИЛОВЫЕ ЗАКРЫЛИСЬ'
        : `ПИТАНИЯ НЕТ — СИЛОВЫХ ${event.doors} ОТКРЫЛОСЬ`, 2.4);
    } else if (event.type === 'panel') {
      /* Первый шум, который звучит не там, где игрок. Сказать об этом
         надо один раз: дальше он сам увидит, куда пошла стража. */
      if (event.точно) {
        /* Взлом — не громкая победа, а её отсутствие: сказать надо ровно
           то, чем он отличается, иначе игрок не поймёт, за что платил. */
        setToast(jab('hack', 'ВЗЛОМАНО — ЩИТОК ЦЕЛ, МОЖНО ВЕРНУТЬ'), 2.4);
        vibrate(10);
      } else {
        setToast(jab('panel', 'ЩИТОК ЗАМКНУЛО — ШУМ ТАМ, А НЕ ЗДЕСЬ'), 2.4);
        vibrate([12, 18, 12]);
      }
    } else if (event.type === 'crystal') {
      setToast('КРИСТАЛЛ ОТДАЛ РАЗРЯД', 1.6);
    } else if (event.type === 'hay') {
      setToast('СОЛОМА ЗАНЯЛАСЬ', 1.6);
    } else if (event.type === 'engaged') {
      /* Тихая фаза кончилась, и сказать об этом надо один раз: дальше
         этаж ведёт себя как обычно, и объяснять это второй раз незачем. */
      setToast('ЭТО ВИДЕЛИ — ТЕПЕРЬ ОНИ ЗНАЮТ', 2);
    }

    tutorFeed(event);

    if (event.type === 'kill') {
      vibrate(12);
    } else if (event.type === 'death') {
      vibrate([40, 30, 90]);
      deathHold = 0.32;
    } else if (event.type === 'cleared') {
      setToast('ЭТАЖ ЧИСТ — К ВЫХОДУ', 3);
    } else if (event.type === 'dry') {
      setToast('СНАЧАЛА НАБЕРИ: ← ОГОНЬ ↑ ВОДА → ВЕТЕР ↓ ЗЕМЛЯ / МОЛНИЯ', 1.8);
    } else if (event.type === 'exit') {
      clearScreen();
    }
  }
}

function vibrate(pattern) {
  if (navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch (error) { /* браузер против */ }
  }
}


/* =========================================================
   КАДР
   ========================================================= */

let previous = performance.now();

/*
 * Кадр не имеет права убить игру.
 *
 * Пока планирование следующего кадра стояло последней строкой самого
 * кадра, любая ошибка внутри останавливала цикл навсегда: мир замирал,
 * кнопки переставали отвечать, и снаружи это выглядело как «игра просто не
 * двигается» — без единой строчки в консоли, потому что ошибка случалась
 * один раз и больше некому было её повторить.
 *
 * Теперь следующий кадр планируется всегда, а ошибка показывается игроку
 * и запоминается в window.technomagic.error. Сломанная игра должна об этом
 * говорить, а не молчать.
 */
function frame(now) {
  requestAnimationFrame(frame);

  try {
    step(now);
  } catch (error) {
    if (!window.technomagic.error) {
      window.technomagic.error = error;
      setToast(`СБОЙ: ${String(error && error.message || error).slice(0, 60)}`, 6);
      console.error('кадр упал', error);
    }
  }
}

function step(now) {
  const dt = Math.min(0.05, (now - previous) / 1000);
  previous = now;

  resize();

  /*
   * На съёмке свой цикл игры молчит, но отрисовка работает. Останавливать
   * надо ход, а не рисование: холст очищается при любом изменении размера,
   * и остановленная отрисовка даёт пустой кадр вместо сцены.
   */
  if (shooting) {
    shooting.render();
    return;
  }

  const raw = input.read();

  if (input.tookKey('KeyB')) toggleTome();

  /* Tab перебирает цели: живых сначала, предметы следом. Без него до
     бочки с клавиатуры было не добраться — прицел держится за живого. */
  if (world && scene === 'play' && input.tookKey('Tab')) {
    picked = cycleTarget(world, picked || locked, world.player.angle);
    locked = picked;
    world.locked = picked;
  }

  if (input.tookKey('Escape') || input.tookKey('KeyP')) {
    if (tomeVisible) hideTome();
    else if (scene === 'play') pauseScreen();
    else if (scene === 'pause') { hideVeil(); scene = 'play'; }
  }

  if (input.tookKey('KeyM')) toggleMute();

  if (scene === 'play' && !tomeVisible) {
    const intent = buildIntent(raw);
    update(world, dt, intent);
    /*
     * Плата за способ показывается сразу и на месте. До сих пор весь счёт
     * игрок видел только в конце этажа — то есть узнавал, что его ход
     * засчитан, через минуту после того, как перестал на него смотреть.
     */
    for (const award of score.feed(world.events)) {
      if (!award.x && !award.y) continue;
      world.marks.push({
        x: award.x,
        y: award.y - 14,
        text: `+${award.gain} ${award.reason}`,
        big: award.combo > 1,
        life: 1.1,
        max: 1.1,
      });
    }
    score.update(dt);
    drainEvents();

    const alerted = world.enemies.filter((e) => e.alive && e.state === 'chase').length;
    audio.setIntensity(world.total ? alerted / world.total : 0);

    if (world.state === 'dead') {
      deathHold = 0.32;
      scene = 'dying';
    }

    updateHud(false);
  } else if (scene === 'dying') {
    update(world, dt, { moveX: 0, moveY: 0, aimAngle: null, attack: false });
    drainEvents();
    deathHold -= dt;
    if (deathHold <= 0) deathScreen();
  } else if (world && (scene !== 'call' || tomeVisible)) {
    /* На паузе, в книге и после смерти мир не двигается, но кадр рисуем. */
    update(world, 0, { moveX: 0, moveY: 0, aimAngle: null, attack: false });
  }

  /* R перезапускает этаж откуда угодно, кроме экрана звонка. */
  const restart = input.tookKey('KeyR');
  if (scene === 'dead' || scene === 'dying') {
    /* После смерти перезапускает всё, что под рукой: R, пробел, удар. */
    if (restart || input.tookKey('Fire') || input.tookKey('Enter') || input.tookKey('Space')) {
      startLevel(level, { silent: true });
    }
  } else if (restart && (scene === 'play' || scene === 'pause')) {
    startLevel(level, { silent: true });
  } else if (scene === 'call' && !tomeVisible
      && (input.tookKey('Fire') || input.tookKey('Enter') || input.tookKey('Space'))) {
    /* Стартовый экран тоже открывается тем, что под рукой. Единственный вход
       в игру не должен зависеть от одной кнопки: пока он от неё зависел,
       пропавший стиль этой кнопки означал, что игру нельзя начать вовсе. */
    ui.veilAction.click();
  }

  if (world) {
    /* Камера смотрит чуть вперёд по прицелу и догоняет быстро: на этой
       скорости мягкое слежение отстаёт и игрок упирается в край кадра. */
    const player = world.player;
    const lead = 52;
    view.x += (player.x + Math.cos(player.angle) * lead - view.x) * Math.min(1, dt * 11);
    view.y += (player.y + Math.sin(player.angle) * lead - view.y) * Math.min(1, dt * 11);
    lastView = renderer.draw(world, view);

    /*
     * Сколько мира влезло в экран — знает только камера, а нужно это ИИ.
     * Кладём радиус в мир: стрелки не станут бить из невидимого.
     */
    /*
     * В изометрии экранный пиксель короче мирового по вертикали вдвое, и
     * прямой перевод дал бы стрелкам вдвое большую дальность, чем игрок
     * видит. Берём меньшую из сторон и делим на диагональ ромба.
     */
    world.viewRadius = Math.min(
      canvas.clientWidth / (2 * lastView.zoom),
      canvas.clientHeight / lastView.zoom,
    ) / 1.42 - 24;
    drawSticks(raw);
  }

  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) ui.toast.hidden = true;
  }

  if (foundTimer > 0) {
    foundTimer -= dt;
    if (foundTimer <= 0) ui.found.hidden = true;
  }

  markCharging();

  input.endFrame();
}


/* Призраки стиков: палец должен видеть, что игра его поняла. */
function drawSticks(raw) {
  for (const [ghost, stick] of [[ui.ghostMove, raw.sticks.move], [ui.ghostAim, raw.sticks.aim]]) {
    if (!stick.active) { ghost.hidden = true; continue; }
    ghost.hidden = false;
    ghost.style.left = `${stick.baseX}px`;
    ghost.style.top = `${stick.baseY}px`;
    ghost.firstElementChild.style.transform = `translate(${stick.dx}px, ${stick.dy}px)`;
  }
}


/* =========================================================
   ОБВЯЗКА
   ========================================================= */

function toggleMute() {
  audio.setMuted(!audio.isMuted());
  ui.mute.dataset.off = audio.isMuted() ? '1' : '0';
  ui.mute.textContent = audio.isMuted() ? 'ЗВУК ВЫКЛ' : 'ЗВУК ВКЛ';
}

/*
 * Размер сверяется каждый кадр, а не только по событию resize: в Safari
 * адресная строка меняет высоту окна без события, а в фоновой вкладке
 * окно какое-то время сообщает нули.
 */
function resize() {
  /*
   * Размер берётся у самого холста, а не у окна. На телефоне холст занимает
   * не весь экран: снизу отведена полоса под кнопки, и мир, нарисованный по
   * высоте окна, уезжал бы под них.
   */
  const width = canvas.clientWidth || window.innerWidth || document.documentElement.clientWidth;
  const height = canvas.clientHeight || window.innerHeight || document.documentElement.clientHeight;
  if (width < 1 || height < 1) return;
  /* Повтор ничего не стоит: холст сам отбросит вызов, если размер тот же. */
  renderer.resize(width, height, window.devicePixelRatio || 1);
}

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));

ui.veilAction.addEventListener('click', (event) => {
  audio.unlock();
  audio.sfx('ui');
  /* Снимаем фокус: иначе пробел в бою повторно нажимал бы эту кнопку. */
  event.currentTarget.blur();

  if (scene === 'call') startLevel(level);
  else if (scene === 'dead') startLevel(level, { silent: true });
  else if (scene === 'clear') {
    attempts = 0;
    if (world.operation) {
      startLevel(level, { silent: true });
      return;
    }
    if (hasNextFloor()) {
      levelIndex += 1;
      /* Следующий этаж — уже не тот, на который звали: цель снимается. */
      challenge = null;
      level = CAMPAIGN[levelIndex];
      levelCode = encode(level);
      world = createWorld(level);
      score = createScore(level, 0);
      view = { x: world.player.x, y: world.player.y };
      renderer.invalidate();
      updateHud(true);
      callScreen();
    } else {
      startLevel(level, { silent: true });
    }
  } else if (scene === 'pause') { hideVeil(); scene = 'play'; }
});

ui.veilSecond.addEventListener('click', (event) => {
  audio.sfx('ui');
  event.currentTarget.blur();
  if (scene === 'pause') startLevel(level, { silent: true });
  else if (scene === 'clear') {
    attempts = 0;
    if (world.operation && CAMPAIGN.length > 1) {
      levelIndex = 1;
      level = CAMPAIGN[levelIndex];
      world = createWorld(level);
      score = createScore(level, 0);
      levelCode = encode(level);
      view = { x: world.player.x, y: world.player.y };
      renderer.invalidate();
      updateHud(true);
      callScreen();
    } else startLevel(level, { silent: true });
  }
});

ui.codeBox.addEventListener('focus', () => ui.codeBox.select());

ui.nickBox.addEventListener('input', () => {
  const clean = cleanNick(ui.nickBox.value);
  if (ui.nickBox.value !== clean) ui.nickBox.value = clean;
  rememberNick(clean);
  refreshLink();
});

$('copyLink').addEventListener('click', async () => {
  refreshLink();
  ui.linkBox.select();
  try {
    await navigator.clipboard.writeText(ui.linkBox.value);
    setToast('ССЫЛКА СКОПИРОВАНА — ОТПРАВЬ ЕЁ', 2.4);
  } catch (error) {
    document.execCommand('copy');
  }
});

ui.linkBox.addEventListener('focus', () => ui.linkBox.select());

$('copyCode').addEventListener('click', async () => {
  ui.codeBox.select();
  try {
    await navigator.clipboard.writeText(ui.codeBox.value);
    setToast('КОД СКОПИРОВАН', 1.6);
  } catch (error) {
    document.execCommand('copy');
  }
});

/* На телефоне клавиши B нет — и обещать её на кнопке незачем. */
if (byTouch()) ui.tomeOpen.textContent = 'КНИГА';

ui.tomeOpen.addEventListener('click', () => { toggleTome(); ui.tomeOpen.blur(); });
ui.tomeClose.addEventListener('click', hideTome);

/* Щелчок мимо карточки закрывает книгу: она перекрывает игру целиком, и
   искать кнопку в такой ситуации не должно быть обязательным. */
ui.tome.addEventListener('click', (event) => { if (event.target === ui.tome) hideTome(); });

ui.mute.addEventListener('click', () => {
  audio.unlock();
  toggleMute();
});

for (const element of ELEMENT_ORDER) input.bindButton($(`btn-${element}`), element);
input.bindButton($('btnAttack'), 'attack');

document.addEventListener('visibilitychange', () => {
  if (document.hidden && scene === 'play') pauseScreen();
});

/* Первое касание экрана разрешает звук: без жеста браузер его не пустит. */
const wake = () => { audio.unlock(); window.removeEventListener('pointerdown', wake); };
window.addEventListener('pointerdown', wake);

/*
 * Диагностический вход. Через него проверяется то, что не проверить
 * снаружи: дошло ли нажатие до мира и в каком состоянии игра. Ничего не
 * меняет — только отдаёт ссылки на живые объекты.
 */
/*
 * ВХОД СНАРУЖИ
 * =========================================================
 * Имя своё, а не общее. Раньше здесь стояло window.avto — наследство от
 * прежнего названия игры, — и ровно такое же имя оказалось у соседнего
 * проекта. Две разные игры, две разные сцены, одно имя: на разных
 * страницах это не ломается само, но тот, кто снимает шесть игр по
 * записанному рецепту, применит к одной порядок вызовов другой. Ошибка
 * будет выглядеть как «сцена не работает», а искать её станут в сцене.
 *
 * Старое имя оставлено синонимом: на него могли уже сослаться.
 */
window.technomagic = {
  get world() { return world; },
  get scene() { return scene; },
  get level() { return level; },

  /* Ввод и отрисовка — тоже наружу. Проверить, доходит ли касание до мира
     и во что обходится кадр, иначе нечем: кадровый цикл в отладочных окнах
     не крутится, а спросить напрямую можно всегда. */
  get input() { return input; },
  get renderer() { return renderer; },

  /*
   * ЗВУК НАРУЖУ
   * ---------------------------------------------------------
   * Про звук спорят дольше всего именно потому, что его нельзя
   * предъявить: один говорит «молчит», другой «играет», и оба правы в
   * своём окне. Ручка превращает спор в команду — `technomagic.audio()`
   * отдаёт живой узел, а `.sfx(имя)` роняет в него один звук, и дальше
   * меряется выход, а не намерение.
   *
   * Заведена по просьбе соседней сессии, которая замером на бою нашла у
   * нас неработающий немой флаг. Их довод простой: у ПЕРИМЕТРА такая
   * ручка есть, и она превратила двухчасовой спор двух измерителей в
   * одну строчку.
   */
  audio() { return audio; },
  get view() { return lastView; },
  get picked() { return picked; },
  state() {
    return {
      scene,
      worldState: world?.state ?? null,
      operation: world ? operationResult(world) : null,
      coreTaken: Boolean(world?.core?.taken),
      candleLit: Boolean(world?.props.find((prop) => prop.kind === 'candle')?.lit),
    };
  },

  /*
   * СНАРЯД ДЛЯ ВИТРИНЫ
   * ---------------------------------------------------------
   * Ставит сцену и отдаёт рычаги: шаг, отрисовку, состояние. Снимает
   * другой — это разделение труда, а не лень: сцену умеет поставить
   * только тот, кто знает игру.
   *
   *   const s = window.technomagic.showcase({ width: 960, height: 540 });
   *   while (s.state().упавших < 2) s.step(1/60);
   *   s.render();                           // кадр в холсте
   *   s.stop();                             // вернуть игру
   *
   * Без аргументов сцена ещё и играет сама, с постоянным шагом: этого
   * хватает, чтобы снять петлю простым захватом холста.
   */
  showcase(options = {}) {
    const seed = options.seed || 20260830;

    /*
     * Размер холста ставит кадровый цикл — а на съёмке он молчит, и без
     * этой строки сцена рисуется в холст по умолчанию, триста на сто
     * пятьдесят. Кадр при этом выходит не пустой, а хуже: почти
     * правильный, только мелкий, и заметить это можно лишь замерив.
     * Поймано счётчиком прозрачных пикселей: их оказалось не ноль.
     *
     * Размер можно задать и прямо — снимающему обычно нужен постоянный
     * кадр, не зависящий от того, каким окном его открыли. А в скрытой
     * вкладке холст вообще не имеет размера, и спросить его не у кого.
     */
    if (options.width && options.height) {
      canvas.style.width = `${options.width}px`;
      canvas.style.height = `${options.height}px`;
      renderer.resize(options.width, options.height, options.dpr || 1);
    } else {
      resize();
    }

    const made = withSeed(seed, () => (
      options.episode
        ? createEpisodeShowcase(CAMPAIGN[0], renderer, {
          width: options.width || window.innerWidth,
          height: options.height || window.innerHeight,
        })
        : createShowcase(CAMPAIGN[0], renderer)
    ));

    document.body.classList.add('is-shooting');

    /* Каждый шаг и каждая отрисовка идут под тем же сидом: иначе искры
       и дым разойдутся на втором прогоне, и «детерминировано» окажется
       неправдой ровно там, где это важнее всего. */
    const wrapped = {
      world: made.world,
      step: (dt) => withSeed((seed + Math.round(made.state().секунд * 1000)) >>> 0,
        () => made.step(dt)),
      /*
       * Сид отрисовки свой на каждый кадр сцены, а не один на все: при
       * общем сиде искры и дуги замирали — каждый кадр рисовал ту же
       * «случайность», и остаточное электричество стояло как картинка.
       * Детерминизм не теряется: номер кадра при повторном прогоне тот же.
       */
      render: () => withSeed((seed + Math.round(made.state().секунд * 60)) >>> 0,
        () => made.render()),
      state: () => made.state(),
      stop() {
        shooting = null;
        document.body.classList.remove('is-shooting');
        canvas.style.width = '';
        canvas.style.height = '';
        resize();
        renderer.invalidate();
      },
    };

    /* Кадр рисует обёртка, а не сама сцена: подменять её собственный
       метод — верный способ получить бесконечную рекурсию, что и вышло
       с первой попытки. */
    shooting = wrapped;

    if (options.play !== false) {
      const tick = () => {
        if (shooting !== wrapped) return;
        wrapped.step(1 / 60);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    return wrapped;
  },
};


/*
 * Синоним под прежним именем — временный, до 6 сентября 2026 года.
 * Держится ради ссылок, которые могли остаться снаружи.
 *
 * Срок стоит здесь не для порядка: одна вещь под двумя именами — ровно та
 * болезнь, из-за которой это переименование и понадобилось. Синоним без
 * срока живёт вечно, и через полгода никто не помнит, какое имя
 * настоящее.
 */
window.avto = window.technomagic;
const fromHash = levelFromHash();
if (fromHash) { level = fromHash; custom = true; }

loadArt();

/*
 * ВЫХОД С НАЧАТОЙ ПАРТИИ СПРАШИВАЕТ
 * =========================================================
 * Кнопка «НА САЙТ» висит поверх игрового поля, то есть под большим
 * пальцем, и уводит со страницы одним касанием. Владелец так уже потерял
 * партию в другой нашей игре — вышел мимоходом, и прогресс исчез молча.
 *
 * Спрашиваем только при идущей партии: на заставке, после смерти и на
 * зачищенном этаже терять нечего, и лишний вопрос там — помеха.
 *
 * Оба исхода обязаны работать: «отмена» удерживает адрес (для этого
 * `preventDefault` стоит ДО вопроса, а не после), «выйти» уводит. Проверка,
 * знающая только один исход, зелёная на сломанном.
 */
function партияИдёт() {
  return (scene === 'play' || scene === 'pause') && world && world.state === 'play';
}

const выход = document.querySelector('.game-home-menu');
if (выход) {
  выход.addEventListener('click', (event) => {
    if (!партияИдёт()) return;
    event.preventDefault();
    if (window.confirm('Точно выйти? Партия и прогресс потеряются.')) {
      window.location.href = выход.href;
    }
  });
}

resize();
levelCode = encode(level);
world = createWorld(level);
score = createScore(level, 0);
syncElementButtons();
view = { x: world.player.x, y: world.player.y };
updateHud(true);
callScreen();
ui.mute.dataset.off = audio.isMuted() ? '1' : '0';
ui.mute.textContent = audio.isMuted() ? 'ЗВУК ВЫКЛ' : 'ЗВУК ВКЛ';
requestAnimationFrame(frame);

/*
 * СЪЁМОЧНЫЙ АДРЕС: ?scena — сцена витрины стартует сама, без рук.
 * Снимающему не нужно знать пульт: открыл адрес — идёт бой для петли
 * (подход → заряд → разряд → остаточное электричество, ~4.5 с).
 * Сама глушит звук: съёмочный адрес обязан молчать без отдельного
 * параметра (снимающий всё равно дублирует это ключом браузера).
 * Проверка, что режим включился, — не «страница открылась», а признак
 * в состоянии: у window.technomagic.scena() есть поле «этап».
 */
if (/(^|[?&#])(scena|сцена)([=&#]|$)/i.test(`${location.search}${location.hash}`)) {
  audio.setMuted(true);
  const съёмка = window.technomagic.showcase({ width: 960, height: 540 });
  window.technomagic.scena = () => съёмка.state();
}
