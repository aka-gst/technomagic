/*
 * ТЕХНОМАГИЯ — отрисовка. Вид сверху.
 *
 * Изометрию пробовали и убрали. Объём она давала, но забирала то, ради
 * чего эта игра существует: читаемость поля. Всё здесь решается по
 * клеткам — где лужа, докуда достанет цепь, попадёт ли конус, — а ромб
 * заставляет глаз пересчитывать сетку в уме и врёт о расстояниях: путь по
 * диагонали выглядит вдвое длиннее, чем он есть. Плюс любая ограда перед
 * игроком закрывала его самого, и это лечилось прозрачностью, то есть
 * ещё одним слоем условности поверх первого.
 *
 * Сверху клетка есть клетка. Ни одного пересчёта, ни одного заслона.
 *
 * От изометрии остались палитра и маги: ночной кибер-парк никуда не делся,
 * поменялась только точка, с которой на него смотрят.
 *
 * Пол печётся один раз в отдельный холст: он не меняется, пока не разбили
 * стекло или не вскрыли бочку, а тысяча клеток каждый кадр — чистая трата.
 */

import { TILE, TILE_SIZE, weakTo, brokenBy } from './level.js';
import { BODY } from './world.js';
import { colourOf, CHARGE_STEP, spellOf } from './magic.js';
import { GROUND, FIRE_CATCH, groundAt, conducts } from './field.js';
import { art, tinted, drawAuto, drawDirFrame, neighbourMask } from './art.js';

const HALF = TILE_SIZE / 2;

/*
 * Фонари стоят по клеткам ограды детерминированно, а не случайно: этаж
 * обязан выглядеть одинаково при каждом заходе, иначе выученная комната
 * перестаёт быть выученной.
 */
function hasLamp(tx, ty) {
  return ((tx * 7 + ty * 13) % 11) === 0;
}

/*
 * Кибер-парк ночью. Палитра держится на одном правиле: земля тёмная и
 * холодная, светятся только кромки и стихии. Стихии — единственный
 * источник насыщенного цвета в кадре, потому что по цвету здесь читают
 * правила: чем светится враг, тем его не убить.
 */
export const THEMES = [
  {
    name: 'парк',
    sky: '#050b0c',
    ground: '#16342d', groundAlt: '#1a3d34',
    path: '#1f343c', pathAlt: '#243c46',
    seam: '#0b1e1b',
    wall: '#030c0a', wallTop: '#0a1c17', wallEdge: '#3dffb4',
    wallSheet: 'wall-fence',
    gate: '#2de0ff',
    glass: '#8ff5ff',
    bench: '#33463c', benchEdge: '#ffc95a',
    rug: '#10463f', rugEdge: '#3dffb4',
    exit: '#3dffb4',
  },

  /* Подстанция: бетон и лиловый свет. Здесь не растёт ничего. */
  {
    name: 'подстанция',
    sky: '#08070e',
    ground: '#242430', groundAlt: '#2a2a37',
    path: '#2d2c3c', pathAlt: '#333143',
    seam: '#141320',
    wall: '#0c0a14', wallTop: '#191428', wallEdge: '#c07bff',
    wallSheet: 'wall-concrete',
    gate: '#c07bff',
    glass: '#c8b6ff',
    bench: '#3d3750', benchEdge: '#ffb347',
    rug: '#2e2450', rugEdge: '#c07bff',
    exit: '#7dffdc',
  },
];

/* Одежда магов. Игрок светлее всех: его надо находить в свалке мгновенно. */
const ROBES = {
  player: { robe: '#2b5f86', robeLit: '#59a8cf', trim: '#9df9ff', hood: '#0d1c28' },
  thug:   { robe: '#3a2030', robeLit: '#6b3b53', trim: '#ff6a86', hood: '#1d0f18' },
  caster: { robe: '#2a2340', robeLit: '#4d4175', trim: '#b98cff', hood: '#150f22' },
  carrier:{ robe: '#20323a', robeLit: '#3a5c6c', trim: '#8fe6ff', hood: '#101d22' },
  civil:  { robe: '#4a463d', robeLit: '#817667', trim: '#d7c9a7', hood: '#29261f' },
  hostage:{ robe: '#3c4b45', robeLit: '#678277', trim: '#b9ffe4', hood: '#202a26' },
  dead:   { robe: '#22242a', robeLit: '#2c2f36', trim: '#4a4e57', hood: '#141519' },
};


export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');

  /* Слой света: ночь кладётся сплошняком, а источники прожигают в ней
     дыры — так тьма получается общей, а не набором пятен. */
  const lightLayer = document.createElement('canvas');
  const lightCtx = lightLayer.getContext('2d');

  let viewW = 0;
  let viewH = 0;
  let dpr = 1;

  /*
   * Потолок плотности пикселей. Телефон рапортует три, и на трёх холст
   * выходит в одиннадцать мегапикселей — по нему каждый кадр гуляют два
   * полноэкранных прохода света. Двойки хватает: разницы на глаз нет, а
   * работы вчетверо меньше.
   */
  const MAX_DPR = 2;

  function resize(cssW, cssH, ratio) {
    const next = Math.min(ratio || 1, MAX_DPR);
    if (viewW === cssW && viewH === cssH && dpr === next) return;

    dpr = next;
    viewW = cssW;
    viewH = cssH;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }

  /*
   * Масштаб от короткой стороны экрана. По ней же считается, как далеко
   * игрок видит, — а от этого зависит, с какого расстояния враги
   * открывают огонь. Иначе на телефоне убивают из-за края кадра.
   */
  /*
   * Масштаб от короткой стороны — и от того, влезает ли этаж целиком.
   *
   * Прежняя формула смотрела только на экран, и на телефоне выходило
   * издевательство: этаж в одиннадцать клеток высотой занимал треть
   * вытянутого экрана, а остальное было чёрным. Теперь масштаб доводится
   * до того, при котором мир закрывает холст: чёрных полей не остаётся,
   * а фигуры делаются крупнее ровно там, где экран меньше.
   *
   * Потолок нужен, чтобы на совсем маленьком этаже камера не уткнулась
   * носом в две клетки.
   */
  function zoomFor(world) {
    /*
     * Съёмка просит крупный план и получает его напрямую. Иначе камера
     * считает так, чтобы этаж влез целиком, — а на витрине от этого
     * фигура доезжает до зрителя размером в двенадцать пикселей, и по
     * кадру нельзя понять, во что играют. Приближение — не свет, светом
     * это не чинится.
     */
    if (world && world.zoomOverride) return world.zoomOverride;

    const short = Math.min(viewW, viewH);
    const base = Math.max(1.05, Math.min(2, short / 520));
    if (!world) return base;

    const fill = Math.max(viewW / (world.w * TILE_SIZE), viewH / (world.h * TILE_SIZE));
    return Math.min(2.6, Math.max(base, fill));
  }


  /* =======================================================
     ПОЛ
     ======================================================= */

  /*
   * Пол рисуется каждый кадр, а не печётся один раз.
   *
   * Печь его было дёшево, пока клетка была квадратом краски. С картинкой в
   * 128 пикселей на клетку печь пришлось бы в разрешении мира — то есть
   * выбросить всю деталь ровно ради экономии, которой больше нет: видимых
   * клеток около трёхсот, а не тысяча, и они рисуются за один проход.
   */
  function tileRange(world, camX, camY, halfW, halfH) {
    return {
      x0: Math.max(0, Math.floor((camX - halfW) / TILE_SIZE) - 1),
      y0: Math.max(0, Math.floor((camY - halfH) / TILE_SIZE) - 1),
      x1: Math.min(world.w - 1, Math.ceil((camX + halfW) / TILE_SIZE) + 1),
      y1: Math.min(world.h - 1, Math.ceil((camY + halfH) / TILE_SIZE) + 1),
    };
  }

  /* Вариант плитки берётся от координат, а не от случая: пол обязан
     выглядеть одинаково при каждом заходе. */
  function floorSprite(tile, tx, ty) {
    const walkway = tile === TILE.DOOR || tile === TILE.EXIT;
    const family = tile === TILE.RUG ? 'floor-paint'
      : walkway ? 'floor-asphalt' : 'floor-grass';
    const count = family === 'floor-paint' ? 2 : 3;
    return art(`${family}-${((tx * 5 + ty * 11) % count) + 1}`);
  }

  function drawFloor(g, world, theme, range) {
    for (let ty = range.y0; ty <= range.y1; ty += 1) {
      for (let tx = range.x0; tx <= range.x1; tx += 1) {
        const tile = world.tiles[ty * world.w + tx];
        if (tile === TILE.WALL) continue;

        const px = tx * TILE_SIZE;
        const py = ty * TILE_SIZE;
        const plate = floorSprite(tile, tx, ty);

        if (plate) {
          g.drawImage(plate, px, py, TILE_SIZE, TILE_SIZE);
          continue;
        }

        const odd = (tx + ty) & 1;
        const walkway = tile === TILE.DOOR || tile === TILE.EXIT;
        g.fillStyle = walkway
          ? (odd ? theme.path : theme.pathAlt)
          : (odd ? theme.ground : theme.groundAlt);
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);

        if (tile === TILE.RUG) {
          g.fillStyle = theme.rug;
          g.fillRect(px + 1, py + 1, TILE_SIZE - 3, TILE_SIZE - 3);
          g.strokeStyle = theme.rugEdge;
          g.globalAlpha = 0.28;
          g.strokeRect(px + 3.5, py + 3.5, TILE_SIZE - 8, TILE_SIZE - 8);
          g.globalAlpha = 1;
        }
      }
    }
  }

  /* Печь больше нечего, но мир по-прежнему сообщает, что стены изменились.
     Дверь оставлена, чтобы вызывающему не пришлось об этом узнавать. */
  function invalidate() {}


  /* =======================================================
     СТЕНЫ, СТЕКЛО, МЕБЕЛЬ, ПРЕДМЕТЫ
     =======================================================
     Сверху высоты нет, и объём подделывается одной вещью —
     подсвеченной кромкой. Её достаточно: стена читается как
     масса, а не как дырка, и при этом не закрывает никого.
     ======================================================= */

  function drawWalls(g, world, theme, range) {
    /* Забор из одной картинки собрать нельзя: у клетки в середине стены и
       у клетки на её конце разные края. Отсюда набор из шестнадцати. */
    const sheet = art(theme.wallSheet) || art('wall-concrete');
    const wallAt = (tile) => tile === TILE.WALL;

    for (let ty = range.y0; ty <= range.y1; ty += 1) {
      for (let tx = range.x0; tx <= range.x1; tx += 1) {
        const tile = world.tiles[ty * world.w + tx];
        if (tile !== TILE.WALL) continue;

        const px = tx * TILE_SIZE;
        const py = ty * TILE_SIZE;

        if (sheet) {
          /* За краем карты стена продолжается: иначе по периметру этажа
             появлялась бы кайма, которой там нечему быть. */
          drawAuto(g, sheet, neighbourMask(world, tx, ty, wallAt, true),
            px, py, TILE_SIZE);
          if (hasLamp(tx, ty)) drawLamp(g, theme, px, py);
          continue;
        }

        g.fillStyle = theme.wall;
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        g.fillStyle = theme.wallTop;
        g.fillRect(px + 3, py + 3, TILE_SIZE - 6, TILE_SIZE - 6);

        /* Кромка рисуется только там, где рядом пол: сплошной массив
           ограды не должен превращаться в сетку из светящихся квадратов. */
        g.strokeStyle = theme.wallEdge;
        g.globalAlpha = 0.75;
        g.lineWidth = 1.5;
        g.beginPath();
        if (ty + 1 < world.h && world.tiles[(ty + 1) * world.w + tx] !== TILE.WALL) {
          g.moveTo(px, py + TILE_SIZE - 0.5); g.lineTo(px + TILE_SIZE, py + TILE_SIZE - 0.5);
        }
        if (tx + 1 < world.w && world.tiles[ty * world.w + tx + 1] !== TILE.WALL) {
          g.moveTo(px + TILE_SIZE - 0.5, py); g.lineTo(px + TILE_SIZE - 0.5, py + TILE_SIZE);
        }
        if (ty > 0 && world.tiles[(ty - 1) * world.w + tx] !== TILE.WALL) {
          g.moveTo(px, py + 0.5); g.lineTo(px + TILE_SIZE, py + 0.5);
        }
        if (tx > 0 && world.tiles[ty * world.w + tx - 1] !== TILE.WALL) {
          g.moveTo(px + 0.5, py); g.lineTo(px + 0.5, py + TILE_SIZE);
        }
        g.stroke();
        g.globalAlpha = 1;

        if (hasLamp(tx, ty)) drawLamp(g, theme, px, py);
      }
    }
  }

  function drawLamp(g, theme, px, py) {
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = theme.wallEdge;
    g.globalAlpha = 0.45;
    g.beginPath();
    g.arc(px + HALF, py + HALF, 7, 0, 6.29);
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(px + HALF, py + HALF, 2.4, 0, 6.29);
    g.fill();
    g.restore();
  }

  /* Какому предмету какая картинка. Всё, чего тут нет, рисуется фигурами. */
  const PROP_SPRITES = {
    [TILE.TABLE]: 'prop-bench',
    [TILE.BARREL]: 'prop-barrel',
    [TILE.BOULDER]: 'prop-block',
    [TILE.CRYSTAL]: 'prop-neon',
    [TILE.HAY]: 'prop-junk',
  };

  function drawProps(g, world, theme, range) {
    for (let ty = range.y0; ty <= range.y1; ty += 1) {
      for (let tx = range.x0; tx <= range.x1; tx += 1) {
      const i = ty * world.w + tx;
      const tile = world.tiles[i];
      if (tile === TILE.FLOOR || tile === TILE.WALL || tile === TILE.RUG) continue;

      const px = tx * TILE_SIZE;
      const py = ty * TILE_SIZE;
      const cx = px + HALF;
      const cy = py + HALF;

      /*
       * Предмет с картинкой рисуется картинкой и крупнее клетки: бочка,
       * куча хлама и остов машины торчат за её края, и обрезать их по
       * клетке значило бы превратить двор обратно в шахматную доску.
       */
      const sprite = art(PROP_SPRITES[tile]);
      if (sprite) {
        const size = TILE_SIZE * 1.5;
        g.drawImage(sprite, cx - size / 2, cy - size / 2, size, size);
        continue;
      }

      if (tile === TILE.GLASS) {
        g.fillStyle = hexToRgba(theme.glass, 0.16);
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        g.strokeStyle = hexToRgba(theme.glass, 0.7);
        g.lineWidth = 1;
        g.strokeRect(px + 0.5, py + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
        continue;
      }

      if (tile === TILE.TABLE) {
        g.fillStyle = theme.bench;
        g.fillRect(px + 2, py + 2, TILE_SIZE - 4, TILE_SIZE - 4);
        g.strokeStyle = theme.benchEdge;
        g.globalAlpha = 0.55;
        g.lineWidth = 1;
        g.strokeRect(px + 2.5, py + 2.5, TILE_SIZE - 5, TILE_SIZE - 5);
        g.globalAlpha = 1;
        continue;
      }

      if (tile === TILE.DOOR) {
        /* Створка светом, а не массой: проход должен читаться как проход. */
        g.strokeStyle = theme.gate;
        g.globalAlpha = 0.7;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(px + 1, py + 1); g.lineTo(px + TILE_SIZE - 1, py + TILE_SIZE - 1);
        g.moveTo(px + TILE_SIZE - 1, py + 1); g.lineTo(px + 1, py + TILE_SIZE - 1);
        g.stroke();
        g.globalAlpha = 1;
        continue;
      }

      if (tile === TILE.WOOD) {
        g.fillStyle = '#563523';
        g.fillRect(px + 3, py + 1, TILE_SIZE - 6, TILE_SIZE - 2);
        g.strokeStyle = '#d09052';
        g.lineWidth = 2;
        for (let x = px + 8; x < px + TILE_SIZE; x += 8) {
          g.beginPath(); g.moveTo(x, py + 3); g.lineTo(x, py + TILE_SIZE - 3); g.stroke();
        }
        continue;
      }

      if (tile === TILE.EXIT) {
        const pulse = 0.4 + Math.sin(world.time * 3 + i) * 0.18;
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = hexToRgba(theme.exit, world.exitOpen ? pulse : 0.08);
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        g.restore();
        g.strokeStyle = hexToRgba(theme.exit, world.exitOpen ? 0.9 : 0.28);
        g.lineWidth = 1.5;
        g.strokeRect(px + 2.5, py + 2.5, TILE_SIZE - 5, TILE_SIZE - 5);
        continue;
      }

      if (tile === TILE.BARREL) {
        /*
         * Бочка с водой. Форма обязана обещать содержимое: тёмный обод и
         * светящаяся вода внутри — «в ней жидкость», а не «ещё одна
         * коробка». Иначе игрок не догадается, зачем в неё бить.
         */
        g.fillStyle = '#0f2c34';
        g.beginPath();
        g.arc(cx, cy, 13, 0, 6.29);
        g.fill();

        g.save();
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = 'rgba(60,190,235,.45)';
        g.beginPath();
        g.arc(cx, cy, 9, 0, 6.29);
        g.fill();
        g.restore();

        g.strokeStyle = '#8ff0ff';
        g.lineWidth = 1.6;
        g.beginPath();
        g.arc(cx, cy, 13, 0, 6.29);
        g.stroke();
        continue;
      }

      if (tile === TILE.HAY) {
        /*
         * Стог. Рисуется во всю клетку и с нахлёстом, чтобы несколько
         * стогов читались одной копной, а не рядом кубиков: за копной
         * прячутся, и её край должен быть неровным.
         */
        g.fillStyle = '#5a4520';
        g.beginPath();
        g.ellipse(cx, cy, 17, 16, 0, 0, 6.29);
        g.fill();
        g.fillStyle = '#8a6a2c';
        g.beginPath();
        g.ellipse(cx - 1, cy - 2, 14, 12, 0, 0, 6.29);
        g.fill();

        g.strokeStyle = '#c69a42';
        g.lineWidth = 1;
        g.globalAlpha = 0.65;
        for (let k = 0; k < 5; k += 1) {
          const a = (i * 7 + k * 13) % 10 / 10 * 6.29;
          g.beginPath();
          g.moveTo(cx + Math.cos(a) * 4, cy + Math.sin(a) * 4);
          g.lineTo(cx + Math.cos(a) * 15, cy + Math.sin(a) * 13);
          g.stroke();
        }
        g.globalAlpha = 1;
        continue;
      }

      if (tile === TILE.BOULDER) {
        /* Валун — многоугольник: камень узнаётся силуэтом, а по силуэту
           игрок вспоминает, что берёт его только земля. */
        g.fillStyle = '#3b332a';
        g.beginPath();
        g.moveTo(cx - 14, cy - 4);
        g.lineTo(cx - 6, cy - 14);
        g.lineTo(cx + 7, cy - 13);
        g.lineTo(cx + 14, cy - 1);
        g.lineTo(cx + 6, cy + 13);
        g.lineTo(cx - 8, cy + 12);
        g.closePath();
        g.fill();

        g.fillStyle = '#5d5243';
        g.beginPath();
        g.moveTo(cx - 6, cy - 14);
        g.lineTo(cx + 7, cy - 13);
        g.lineTo(cx + 2, cy - 2);
        g.lineTo(cx - 7, cy - 3);
        g.closePath();
        g.fill();
        continue;
      }

      if (tile === TILE.FORCE) {
        /*
         * Силовая дверь светится и сквозь неё видно: она обещает то, чего
         * не даёт, — вот проход, и вот ты в него не пройдёшь. Гаснет
         * вместе с питанием, и тогда её здесь просто нет.
         */
        const hum = 0.55 + Math.sin(world.time * 6 + i) * 0.3;
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = `rgba(90,200,255,${0.12 + hum * 0.1})`;
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        g.strokeStyle = `rgba(150,230,255,${0.5 + hum * 0.4})`;
        g.lineWidth = 2;
        for (let k = 0; k < 3; k += 1) {
          const oy = py + (k + 0.5) * (TILE_SIZE / 3);
          g.beginPath();
          g.moveTo(px + 2, oy);
          g.lineTo(px + TILE_SIZE - 2, oy);
          g.stroke();
        }
        g.restore();
        continue;
      }

      if (tile === TILE.METAL) {
        /* Металл глухой: ни огня, ни взгляда. Только вмятины. */
        g.fillStyle = '#4a5462';
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        g.strokeStyle = '#69768a';
        g.lineWidth = 1.4;
        g.strokeRect(px + 2.5, py + 2.5, TILE_SIZE - 5, TILE_SIZE - 5);
        g.fillStyle = '#8d9aad';
        g.fillRect(px + TILE_SIZE / 2 - 5, py + TILE_SIZE / 2 - 1.5, 10, 3);
        continue;
      }

      if (tile === TILE.PANEL) {
        /*
         * Щиток. Коробка на стене с двумя лампами и рубильником — вещь
         * техническая, а не магическая, и по виду её не спутаешь ни с
         * бочкой, ни с кристаллом. Лампы мигают вразнобой: живое питание
         * должно быть видно издалека, потому что бьют по нему издалека.
         */
        const blink = 0.5 + Math.sin(world.time * 5 + i) * 0.5;

        g.fillStyle = '#2b3340';
        g.fillRect(cx - 11, cy - 9, 22, 18);
        g.strokeStyle = '#5d6b7e';
        g.lineWidth = 1.4;
        g.strokeRect(cx - 11, cy - 9, 22, 18);

        g.fillStyle = `rgba(255,226,77,${0.45 + blink * 0.55})`;
        g.beginPath();
        g.arc(cx - 5, cy - 3, 2.4, 0, 6.29);
        g.fill();

        g.fillStyle = `rgba(110,240,180,${0.9 - blink * 0.5})`;
        g.beginPath();
        g.arc(cx + 5, cy - 3, 2.4, 0, 6.29);
        g.fill();

        /* Рубильник вниз — щиток под напряжением. */
        g.strokeStyle = '#c9d6e2';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(cx - 4, cy + 4);
        g.lineTo(cx + 4, cy + 6);
        g.stroke();
        continue;
      }

      if (tile === TILE.CRYSTAL) {
        /* Кристалл светится сам: перепутать его с камнем нельзя, потому
           что бить в него надо ровно противоположным. */
        // eslint-disable-next-line no-unused-vars
        const pulse = 0.55 + Math.sin(world.time * 3 + i) * 0.2;
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = `rgba(255,226,90,${0.14 * pulse})`;
        g.beginPath();
        g.arc(cx, cy, 22, 0, 6.29);
        g.fill();
        g.restore();

        g.fillStyle = '#6a5a1e';
        g.beginPath();
        g.moveTo(cx, cy - 14);
        g.lineTo(cx + 9, cy + 2);
        g.lineTo(cx, cy + 13);
        g.lineTo(cx - 9, cy + 2);
        g.closePath();
        g.fill();

        g.fillStyle = `rgba(255,242,160,${0.6 + pulse * 0.3})`;
        g.beginPath();
        g.moveTo(cx, cy - 14);
        g.lineTo(cx + 9, cy + 2);
        g.lineTo(cx, cy + 4);
        g.closePath();
        g.fill();
      }
      }
    }
  }


  /* =======================================================
     ПОЛЕ
     =======================================================
     То, что вещество оставило на полу. Рисуется клетками по
     той же сетке, по которой считается: по краю клетки
     проходит разница между «цепь достала» и «не достала»,
     и мягкое пятно об этом соврало бы.
     ======================================================= */

  /* Картинка вещества: у каждого своя и полноцветная. Красить их нечем —
     цвет лужи в игре не меняется, он у неё один и навсегда. */
  const FIELD_SHEETS = {
    [GROUND.WATER]: 'field-water',
    [GROUND.ICE]: 'field-ice',
    [GROUND.MUD]: 'field-mud',
    [GROUND.FIRE]: 'field-fire',
  };

  /*
   * Наэлектризованная вода. Свет бежит наружу от точки удара с той же
   * скоростью, с какой разряд назначает удары по телам, — поэтому клетка
   * под врагом загорается ровно тогда, когда врага бьёт.
   *
   * Рисуется поверх воды и до тел: игрок должен прочитать «залило →
   * зарядило → ударило» именно в этом порядке, иначе три смерти через
   * полкомнаты выглядят необъяснимыми.
   */
  function drawCharge(g, world, range) {
    const live = world.charged;
    if (!live) return;

    const gone = live.max - live.life;
    const front = gone * 900;
    const fade = Math.min(1, live.life / (live.max * 0.6));

    g.save();
    g.globalCompositeOperation = 'lighter';

    for (let ty = range.y0; ty <= range.y1; ty += 1) {
      for (let tx = range.x0; tx <= range.x1; tx += 1) {
        const i = ty * world.w + tx;
        if (!live.tiles.has(i)) continue;

        const px = tx * TILE_SIZE;
        const py = ty * TILE_SIZE;
        const gap = Math.hypot(px + TILE_SIZE / 2 - live.x, py + TILE_SIZE / 2 - live.y);
        if (gap > front) continue;

        /* Ярче всего на самом фронте, дальше остаётся ровное свечение. */
        const edge = Math.max(0, 1 - (front - gap) / 90);
        const power = (0.22 + edge * 0.5) * fade;

        g.fillStyle = `rgba(150,235,255,${power})`;
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);

        if (edge > 0.35 && Math.random() < 0.5) {
          g.strokeStyle = `rgba(220,250,255,${power})`;
          g.lineWidth = 1.4;
          g.beginPath();
          g.moveTo(px + Math.random() * TILE_SIZE, py);
          g.lineTo(px + Math.random() * TILE_SIZE, py + TILE_SIZE);
          g.stroke();
        }
      }
    }

    g.restore();
  }

  /*
   * Остаточное электричество на воде (просьба Сергея): после того как
   * фронт разряда прошёл, лужа ещё пару секунд дышит слабым светом и
   * изредка выбрасывает короткие искры. Рисуется заметно тише drawCharge:
   * это память о разряде, а не сам разряд — иначе двух событий не отличить.
   */
  function drawResidual(g, world, range) {
    const rez = world.residual;
    if (!rez) return;

    const fade = rez.life / rez.max;
    g.save();
    g.globalCompositeOperation = 'lighter';

    for (let ty = range.y0; ty <= range.y1; ty += 1) {
      for (let tx = range.x0; tx <= range.x1; tx += 1) {
        const i = ty * world.w + tx;
        if (!rez.tiles.has(i)) continue;

        const px = tx * TILE_SIZE;
        const py = ty * TILE_SIZE;

        /* Дыхание, а не ровный свет: у каждой клетки своя фаза, иначе всё
           поле мигает как одна лампа. */
        const puls = 0.5 + 0.5 * Math.sin(world.time * 7 + i * 1.7);
        g.fillStyle = `rgba(150,235,255,${((0.04 + 0.08 * puls) * fade).toFixed(3)})`;
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);

        if (Math.random() < 0.05 * fade) {
          const sx = px + Math.random() * TILE_SIZE;
          const sy = py + Math.random() * TILE_SIZE;
          g.strokeStyle = `rgba(220,250,255,${(0.35 + 0.45 * fade).toFixed(3)})`;
          g.lineWidth = 1.2;
          g.beginPath();
          g.moveTo(sx, sy);
          g.lineTo(sx + (Math.random() - 0.5) * 9, sy + (Math.random() - 0.5) * 9);
          g.lineTo(sx + (Math.random() - 0.5) * 14, sy + (Math.random() - 0.5) * 14);
          g.stroke();
        }
      }
    }

    g.restore();
  }

  function drawGround(g, world, range) {
    if (!world.ground) return;

    for (let ty = range.y0; ty <= range.y1; ty += 1) {
      for (let tx = range.x0; tx <= range.x1; tx += 1) {
      const i = ty * world.w + tx;
      const kind = world.ground[i];
      if (!kind) continue;

      const px = tx * TILE_SIZE;
      const py = ty * TILE_SIZE;
      const fade = Math.min(1, world.groundLife[i] / 2);

      /*
       * Лужа не квадратная. Где сосед такой же — край гладкий, где нет —
       * кайма: ровно то, что отличает разлитую воду от плитки, и ровно то,
       * по чему игрок читает, докуда достанет цепь.
       */
      const sheet = art(FIELD_SHEETS[kind]);
      if (sheet) {
        const mask = neighbourMask(world, tx, ty,
          (tile, at) => world.ground[at] === kind, false);
        g.save();
        g.globalAlpha = fade;
        if (kind === GROUND.FIRE) {
          const caught = Math.min(1, world.groundAge[i] / FIRE_CATCH);
          g.globalAlpha = fade * (0.45 + caught * 0.55);
        }
        drawAuto(g, sheet, mask, px, py, TILE_SIZE);
        g.restore();
        continue;
      }

      if (kind === GROUND.FIRE) {
        /*
         * Огонь рисуется на сложение: свет складывается с любым полом и
         * остаётся огнём на всех темах. С прозрачностью он на тёмной
         * земле давал тот же бурый, что и грязь, — а одно убивает,
         * другое нет.
         */
        const caught = Math.min(1, world.groundAge[i] / FIRE_CATCH);
        const flicker = 0.75 + Math.random() * 0.25;

        g.save();
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = `rgba(255,${60 + Math.round(caught * 40)},10,${(0.3 + caught * 0.4) * fade * flicker})`;
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);

        if (caught >= 1) {
          g.fillStyle = `rgba(255,200,70,${0.32 * flicker * fade})`;
          for (let k = 0; k < 2; k += 1) {
            const r = 4 + Math.random() * 6;
            g.beginPath();
            g.arc(px + 6 + Math.random() * (TILE_SIZE - 12),
              py + 6 + Math.random() * (TILE_SIZE - 12), r, 0, 6.29);
            g.fill();
          }
        }
        g.restore();
        continue;
      }

      if (kind === GROUND.WATER) {
        g.fillStyle = `rgba(22,86,150,${0.6 * fade})`;
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = `rgba(46,150,220,${0.24 * fade})`;
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        g.restore();
        /* Блик: без него лужа читается как дырка в полу. */
        g.strokeStyle = `rgba(160,235,255,${0.32 * fade})`;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(px + 5, py + TILE_SIZE - 8);
        g.lineTo(px + TILE_SIZE - 7, py + 6);
        g.stroke();
        continue;
      }

      if (kind === GROUND.ICE) {
        g.fillStyle = `rgba(140,215,245,${0.42 * fade})`;
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = `rgba(190,240,255,${0.2 * fade})`;
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        g.restore();
        g.strokeStyle = `rgba(255,255,255,${0.4 * fade})`;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(px + 4, py + TILE_SIZE - 10);
        g.lineTo(px + HALF, py + 8);
        g.lineTo(px + TILE_SIZE - 5, py + TILE_SIZE - 6);
        g.stroke();
        continue;
      }

      if (kind === GROUND.MUD) {
        g.fillStyle = `rgba(48,40,22,${0.78 * fade})`;
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      }
      }
    }
  }

  function drawDecals(g, world) {
    g.fillStyle = '#8d0526';
    for (const decal of world.decals) {
      g.globalAlpha = decal.a * 0.85;
      g.beginPath();
      g.ellipse(decal.x, decal.y, decal.r, decal.r * 0.85, 0, 0, 6.29);
      g.fill();
    }
    g.globalAlpha = 1;
  }


  /* =======================================================
     МАГ
     =======================================================
     Сверху видно плечи, капюшон и посох — и всё. Лица нет
     намеренно: тёмный провал капюшона читается как маг и не
     требует ни одного пикселя мимики.
     ======================================================= */

  /*
   * Лист мага под действие. Замах и каст важнее ходьбы: по ним игрок
   * понимает, что сейчас прилетит, и подменять их шагом значило бы прятать
   * единственное предупреждение.
   */
  function sheetFor(o) {
    if (!o.sheet) return null;
    if (o.sheet === 'corpse') return art('mage-corpse');

    if ((o.cast || 0) > 0.05 || (o.swing || 0) > 0.05) {
      const strike = art(`mage-${o.sheet}-cast`) || art(`mage-${o.sheet}-swing`);
      if (strike) return strike;
    }
    if (o.moving) {
      const walk = art(`mage-${o.sheet}-walk`);
      if (walk) return walk;
    }
    return art(`mage-${o.sheet}-idle`);
  }

  /* На экране тело — около двадцати шести пикселей; кадр рисуется крупнее,
     потому что посох и ирокез выходят за пределы фигуры. */
  const MAGE_SIZE = 46;

  function mage(g, o) {
    const { x, y } = o;
    const palette = o.palette;
    const dx = Math.cos(o.angle);
    const dy = Math.sin(o.angle);

    /* Тень под фигурой — единственное, что подделывает объём сверху.
       Рисует её игра, а не картинка: у восьми направлений тень одна. */
    g.fillStyle = 'rgba(0,0,0,.4)';
    g.beginPath();
    g.ellipse(x + 1.5, y + 2, BODY + 3, BODY + 2, 0, 0, 6.29);
    g.fill();

    /*
     * Спрайт не вращается: у него восемь готовых сторон. Вращаемая фигура
     * не может иметь ни света сверху, ни ирокеза, ни асимметрии — а ровно
     * из этого и состоит вид законченной игры.
     */
    if (o.corpse) {
      const corpseSheet = art('mage-corpse');
      if (corpseSheet) {
        drawDirFrame(g, corpseSheet, o.angle, 0, x, y, MAGE_SIZE);
      } else {
        g.save();
        g.translate(x, y);
        g.rotate(o.angle);
        g.fillStyle = palette.robe;
        g.beginPath();
        g.ellipse(0, 0, BODY + 5, BODY - 1, 0, 0, 6.29);
        g.fill();
        g.strokeStyle = '#d7cbd7';
        g.globalAlpha = 0.65;
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(-5, -5); g.lineTo(5, 5);
        g.moveTo(5, -5); g.lineTo(-5, 5);
        g.stroke();
        g.restore();
      }
      return;
    }

    if (o.downed) {
      const proneSheet = o.sheet && art(`mage-${o.sheet}-idle`);
      const breath = 1 + Math.sin((o.phase || 0) * 0.7) * 0.025;
      g.save();
      g.translate(x, y);
      g.rotate(o.angle + Math.PI / 2);
      g.scale(1.08, breath * 0.72);
      if (proneSheet) {
        drawDirFrame(g, proneSheet, 0, 0, 0, 0, MAGE_SIZE);
      } else {
        g.fillStyle = palette.robe;
        g.beginPath();
        g.ellipse(0, 0, BODY + 5, BODY - 1, 0, 0, 6.29);
        g.fill();
        g.fillStyle = palette.hood;
        g.beginPath();
        g.arc(BODY + 5, 0, 5, 0, 6.29);
        g.fill();
        g.strokeStyle = palette.trim;
        g.globalAlpha = 0.8;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(-BODY - 7, -BODY + 2);
        g.lineTo(BODY + 10, -BODY + 2);
        g.stroke();
      }
      g.restore();
      if (o.breathing) {
        const inhale = 0.45 + Math.sin((o.phase || 0) * 0.7) * 0.25;
        g.strokeStyle = `rgba(127,252,255,${inhale})`;
        g.lineWidth = 1.4;
        for (let ring = 0; ring < 2; ring += 1) {
          g.beginPath();
          g.arc(x + BODY + 7, y - 4, 3 + ring * 3, -1.1, 1.1);
          g.stroke();
        }
      }
      return;
    }

    const sheet = sheetFor(o);
    if (sheet) {
      drawDirFrame(g, sheet, o.angle, Math.floor((o.phase || 0) * 2), x, y, MAGE_SIZE);

      const heat = (o.charging ? 1 : 0) + (o.cast || 0);
      if (heat > 0.05 && o.glow) {
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = o.glow;
        g.globalAlpha = Math.min(0.8, 0.3 * heat);
        g.beginPath();
        g.arc(x + dx * 15, y + dy * 15, 5 + heat * 3, 0, 6.29);
        g.fill();
        g.restore();
      }
      return;
    }

    /* Плащ: круг, вытянутый назад — по нему видно, куда маг повёрнут. */
    const sway = o.phase ? Math.sin(o.phase) * 0.8 : 0;
    g.save();
    g.translate(x - dx * 2, y - dy * 2);
    g.rotate(o.angle);
    const grad = g.createLinearGradient(BODY, 0, -BODY - 4, 0);
    grad.addColorStop(0, palette.robeLit);
    grad.addColorStop(1, palette.robe);
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(0, 0, BODY + 3 + sway, BODY + 1, 0, 0, 6.29);
    g.fill();

    /* Светящаяся кромка по плечам — та самая «техно» половина техно-мага. */
    g.strokeStyle = o.glow || palette.trim;
    g.globalAlpha = 0.6;
    g.lineWidth = 1.4;
    g.beginPath();
    g.arc(0, 0, BODY + 2, -2.2, 2.2);
    g.stroke();
    g.globalAlpha = 1;
    g.restore();

    /* Капюшон смещён вперёд: сверху это и есть «смотрит туда». */
    g.fillStyle = palette.hood;
    g.beginPath();
    g.arc(x + dx * 3, y + dy * 3, BODY - 3, 0, 6.29);
    g.fill();

    g.fillStyle = o.glow || palette.trim;
    g.globalAlpha = 0.85;
    g.beginPath();
    g.arc(x + dx * 5.5, y + dy * 5.5, 1.6, 0, 6.29);
    g.fill();
    g.globalAlpha = 1;

    /* Посох. Он же показывает замах и выпуск: рука уходит вперёд. */
    const reach = 16 + (o.swing || 0) * 26 + (o.cast || 0) * 6;
    const handX = x + dx * 4 - dy * 7;
    const handY = y + dy * 4 + dx * 7;
    const tipX = handX + dx * reach;
    const tipY = handY + dy * reach;

    g.strokeStyle = '#0d0b12';
    g.lineWidth = 3.4;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(handX - dx * 6, handY - dy * 6);
    g.lineTo(tipX, tipY);
    g.stroke();

    g.strokeStyle = '#6b6274';
    g.lineWidth = 1.4;
    g.stroke();

    const heat = 0.5 + (o.charging ? 0.5 : 0) + (o.cast || 0);
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = o.glow || palette.trim;
    g.globalAlpha = Math.min(1, 0.45 * heat);
    g.beginPath();
    g.arc(tipX, tipY, 4 + heat * 2.4, 0, 6.29);
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(tipX, tipY, 1.5 + heat * 0.8, 0, 6.29);
    g.fill();
    g.restore();
  }

  /*
   * Состояние тела — цветом на самом теле.
   *
   * Поле видно на полу, но решение принимают по телу: кто из этих троих
   * мокрый, а кто уже выбежал из лужи. Считать это глазами по клеткам под
   * ногами нельзя — тела движутся, а мокрым остаются ещё три секунды после
   * того, как вышли. Поэтому свечение живёт на теле, а не под ним.
   *
   * Цвет — того вещества, в котором стоят или которым облиты. Он же и есть
   * ответ на «чем его брать»: синий значит мокрый, а мокрого берёт разряд.
   */
  const STATE_COLOURS = {
    [GROUND.WATER]: '34,170,255',
    [GROUND.FIRE]: '255,90,25',
    [GROUND.ICE]: '160,230,255',
    [GROUND.MUD]: '186,152,72',
  };

  function stateMark(g, world, body_) {
    /* Горящий — не состояние, а приговор: он ярче всего и не мигает. */
    if (body_.burning > 0) {
      const flicker = 0.6 + Math.random() * 0.4;
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = `rgba(255,120,40,${0.45 * flicker})`;
      g.beginPath();
      g.arc(body_.x, body_.y, BODY + 5 + Math.random() * 3, 0, 6.29);
      g.fill();
      g.restore();
      return;
    }

    if ((body_.brittle || 0) > 0) {
      g.save();
      g.strokeStyle = '#b9f4ff';
      g.globalAlpha = 0.75 + Math.sin(world.time * 12) * 0.2;
      g.lineWidth = 2;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.arc(body_.x, body_.y, BODY + 9, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
      g.restore();
    }

    const ground = groundAt(world, body_.x, body_.y);
    const wet = (body_.wet || 0) > 0;
    const colour = STATE_COLOURS[ground] || (wet ? STATE_COLOURS[GROUND.WATER] : null);
    if (!colour) return;

    /* Слабое свечение, а не заливка: метка не должна спорить с кольцом
       стойкости — то говорит, чем НЕ брать, и оно важнее. */
    const pulse = 0.72 + Math.sin(world.time * 4 + body_.x) * 0.28;
    const r = BODY + 11;

    g.save();
    g.globalCompositeOperation = 'lighter';
    const glow = g.createRadialGradient(body_.x, body_.y, 1, body_.x, body_.y, r);
    glow.addColorStop(0, `rgba(${colour},${0.55 * pulse})`);
    glow.addColorStop(0.6, `rgba(${colour},${0.32 * pulse})`);
    glow.addColorStop(1, `rgba(${colour},0)`);
    g.fillStyle = glow;
    g.beginPath();
    g.arc(body_.x, body_.y, r, 0, 6.29);
    g.fill();
    g.restore();

    /*
     * Отдельная метка на мокром: разряд по нему пойдёт дальше, по всей
     * связной воде. Это единственное состояние с готовым ответом, поэтому
     * оно и подписано цветом ответа — молнией. Метка появляется, только
     * если молния у игрока вообще есть: рисовать подсказку к тому, чего
     * нет в руках, — обещание, которого игра не держит.
     */
    if (conducts(world, body_) && world.elements.includes('bolt')) {
      g.strokeStyle = `rgba(255,225,77,${0.35 + pulse * 0.4})`;
      g.lineWidth = 1.6;
      g.setLineDash([3, 4]);
      g.beginPath();
      g.arc(body_.x, body_.y, BODY + 12, 0, 6.29);
      g.stroke();
      g.setLineDash([]);
    }
  }


  /* =======================================================
     ТЕЛА
     ======================================================= */

  const CORPSE_SHEETS = { caster: 'sparker', carrier: 'warden' };

  function drawCorpses(g, world) {
    for (const corpse of world.corpses) {
      const jitter = corpse.twitch > 0 ? (Math.random() - 0.5) * corpse.twitch * 2 : 0;

      /*
       * Падающий рисуется ещё собой, но заваливается: фигура кренится и
       * оседает, и только потом на её месте оказывается тело. Без этого
       * смерть была подменой картинки — стоял и лежит, — а между ними
       * игрок не видел ничего и обобщать ему было не из чего.
       */
      if (corpse.fall > 0) {
        const gone = 1 - corpse.fall / 0.34;
        g.save();
        g.translate(corpse.x + jitter, corpse.y + gone * 3);
        g.rotate(corpse.lean * gone * 2.2);
        g.scale(1 - gone * 0.16, 1 - gone * 0.34);
        mage(g, {
          x: 0, y: 0, angle: corpse.angle,
          palette: ROBES[corpse.kind] || ROBES.thug,
          sheet: CORPSE_SHEETS[corpse.kind] || 'punk',
          phase: 0, downed: false,
        });
        g.restore();
        continue;
      }

      mage(g, {
        x: corpse.x + jitter, y: corpse.y, angle: corpse.angle,
        palette: ROBES.dead, sheet: 'corpse', phase: 0, corpse: true,
      });

      /* Тело после разряда потрескивает — остаточное электричество носят
         не только живые. Чем свежее удар, тем чаще дуги. */
      if ((corpse.zap || 0) > 0 && Math.random() < 0.2 + corpse.zap * 0.35) {
        arcs(g, corpse);
      }
    }
  }

  function drawEnemies(g, world) {
    for (const enemy of world.enemies) {
      if (!enemy.alive) continue;

      /*
       * Пока по телу идёт ток, его трясёт. Смещается весь маг целиком, а
       * не свечение под ним: дёргаться должен человек, иначе непонятно,
       * что с ним происходит, и смерть выглядит беспричинной.
       */
      const jolt = (enemy.zap || 0) > 0;
      if (jolt) {
        g.save();
        g.translate((Math.random() - 0.5) * 3.6, (Math.random() - 0.5) * 3.6);
      }

      stateMark(g, world, enemy);

      /*
       * Стихию врага видно всегда: она же его и защищает, поэтому кольцо
       * вокруг тела — прямая инструкция «этим цветом не бей».
       */
      if (enemy.resist) {
        const colour = colourOf(enemy.resist);
        const pulse = 0.45 + Math.sin(world.time * 6 + enemy.home.x) * 0.2;
        g.strokeStyle = colour;
        g.globalAlpha = enemy.blocked > 0 ? 1 : pulse;
        g.lineWidth = enemy.blocked > 0 ? 3 : 1.8;
        g.beginPath();
        g.arc(enemy.x, enemy.y, BODY + 7, 0, 6.29);
        g.stroke();
        g.globalAlpha = 1;
      }

      /*
       * Крепкого видно до удара. Двойное кольцо значит «одиночная стихия
       * не возьмёт»; когда запас надломлен, внутреннее кольцо рвётся —
       * добить можно чем угодно, и это должно быть видно через полкомнаты.
       */
      if ((enemy.hp || 1) > 1 || enemy.tough) {
        g.save();
        g.strokeStyle = '#d9e2ea';
        g.globalAlpha = 0.55;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(enemy.x, enemy.y, BODY + 3, 0, 6.29);
        g.stroke();
        g.restore();
      } else if (enemy.wasTough) {
        g.save();
        g.strokeStyle = '#ffb0b8';
        g.globalAlpha = 0.6;
        g.lineWidth = 2;
        g.setLineDash([5, 6]);
        g.beginPath();
        g.arc(enemy.x, enemy.y, BODY + 3, 0, 6.29);
        g.stroke();
        g.setLineDash([]);
        g.restore();
      }

      mage(g, {
        x: enemy.x, y: enemy.y, angle: enemy.angle,
        palette: ROBES[enemy.kind] || ROBES.thug,
        sheet: enemy.kind === 'caster' ? 'sparker'
          : enemy.kind === 'carrier' ? 'warden' : 'punk',
        moving: Math.hypot(enemy.vx, enemy.vy) > 12,
        phase: enemy.step * 0.35,
        swing: enemy.swing || 0,
        cast: enemy.windup ? Math.min(1, enemy.windup * 3) : 0,
        charging: enemy.windup > 0,
        downed: enemy.downed > 0,
        breathing: enemy.downed > 0,
        glow: enemy.resist ? colourOf(enemy.resist)
          : (enemy.element ? colourOf(enemy.element) : null),
      });

      if (enemy.hitFlash > 0) {
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = `rgba(255,255,255,${enemy.hitFlash * 3})`;
        g.beginPath();
        g.arc(enemy.x, enemy.y, BODY + 4, 0, 6.29);
        g.fill();
        g.restore();
      }

      /*
       * Замах. Он был виден только позой мага — этого мало: игрок смотрит
       * на своё поле, а не на чужие руки, и удар прилетал ниоткуда.
       * Теперь замах чертит линию туда, куда прилетит, и линия за свои
       * четыре десятых секунды дотягивается до цели. Уйти с неё — и есть
       * ответ на выстрел.
       */
      if ((enemy.windup || 0) > 0.02) drawWindup(g, world, enemy);

      if (jolt) {
        arcs(g, enemy);
        g.restore();
      }
    }
  }

  function drawOperationActors(g, world) {
    const actors = [...(world.civilians || []), ...(world.hostage ? [world.hostage] : [])];
    for (const body of actors) {
      if (!body.alive) continue;
      stateMark(g, world, body);
      mage(g, {
        x: body.x, y: body.y, angle: body.angle || 0,
        palette: ROBES[body.kind], sheet: null,
        moving: Math.hypot(body.vx || 0, body.vy || 0) > 12,
        phase: world.time * 3, downed: body.downed > 0,
        breathing: body.downed > 0,
      });
      if (body.kind === 'hostage' && !body.released) {
        g.strokeStyle = '#ffcc66';
        g.lineWidth = 2;
        g.setLineDash([3, 3]);
        g.beginPath(); g.arc(body.x, body.y, BODY + 7, 0, Math.PI * 2); g.stroke();
        g.setLineDash([]);
      }
    }
  }

  function drawOperationProps(g, world) {
    for (const prop of world.props || []) {
      if (prop.kind === 'core' && !prop.taken) {
        g.save();
        g.translate(prop.x, prop.y);
        g.rotate(world.time * 0.8);
        g.fillStyle = '#7ffcff';
        g.shadowColor = '#32dfff';
        g.shadowBlur = 14;
        g.fillRect(-8, -8, 16, 16);
        g.fillStyle = '#ffffff';
        g.fillRect(-3, -3, 6, 6);
        g.restore();
      }
      if (prop.kind === 'candle') {
        g.fillStyle = '#e7dcc4';
        g.fillRect(prop.x - 2, prop.y - 7, 4, 12);
        g.fillStyle = '#1a1410';
        g.fillRect(prop.x - 0.5, prop.y - 10, 1, 3);
        if (prop.lit) {
          g.save();
          g.fillStyle = '#ffb347';
          g.shadowColor = '#ff7a2a';
          g.shadowBlur = 12;
          g.beginPath();
          g.ellipse(prop.x, prop.y - 12, 3, 6, 0, 0, Math.PI * 2);
          g.fill();
          g.restore();
        }
      }
    }
  }

  /* Ближний бой бьёт по дуге у себя под носом, а не до игрока: линия
     обязана показывать настоящую дальность, иначе она врёт. */
  const WEAPON_REACH = { bat: 38 };

  function drawWindup(g, world, enemy) {
    const player = world.player;
    const melee = WEAPON_REACH[enemy.weapon] || 0;
    const full = melee || Math.hypot(player.x - enemy.x, player.y - enemy.y);
    const grow = Math.min(1, enemy.windup / 0.42);
    const angle = enemy.angle;
    const tint = enemy.element ? colourOf(enemy.element) : '#ff5d7a';

    g.save();
    g.globalCompositeOperation = 'lighter';

    /* Линия удара: тонкая в начале замаха, яркая к выстрелу. */
    g.strokeStyle = tint;
    g.globalAlpha = 0.25 + grow * 0.55;
    g.lineWidth = 1 + grow * 2;
    g.setLineDash([7, 6]);
    g.lineDashOffset = -world.time * 40;
    g.beginPath();
    g.moveTo(enemy.x, enemy.y);
    g.lineTo(enemy.x + Math.cos(angle) * full * grow, enemy.y + Math.sin(angle) * full * grow);
    g.stroke();
    g.setLineDash([]);

    /* Кольцо, стягивающееся к телу: видно, сколько осталось до удара. */
    g.globalAlpha = 0.35 + grow * 0.5;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(enemy.x, enemy.y, BODY + 16 - grow * 12, 0, 6.29);
    g.stroke();

    g.restore();
  }

  /*
   * Дуги вокруг бьющегося током. Рисуются ломаной от края тела наружу и
   * каждый кадр другие: ровные лучи читались бы как заклинание игрока, а
   * это с ним происходит, а не он это делает.
   */
  function arcs(g, body_) {
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = '#9fe8ff';
    g.lineWidth = 1.6;
    for (let i = 0; i < 5; i += 1) {
      const a = Math.random() * 6.29;
      let x = body_.x + Math.cos(a) * (BODY - 2);
      let y = body_.y + Math.sin(a) * (BODY - 2);
      g.globalAlpha = 0.5 + Math.random() * 0.5;
      g.beginPath();
      g.moveTo(x, y);
      for (let k = 0; k < 3; k += 1) {
        x += Math.cos(a) * 5 + (Math.random() - 0.5) * 7;
        y += Math.sin(a) * 5 + (Math.random() - 0.5) * 7;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    g.restore();
  }

  function drawPlayer(g, world) {
    const player = world.player;
    if (!player.alive) return;

    /*
     * Круг под ногами у игрока горит всегда. В свалке из пяти одинаковых
     * плащей найти себя — первая задача кадра, и решать её силуэтом
     * нечестно: свой маг ничем не крупнее чужого.
     */
    const held = player.stack.length ? colourOf(player.stack[player.stack.length - 1]) : null;
    const ring = player.chargeLeft > 0 ? colourOf(player.charging) : (held || '#9df9ff');
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = ring;
    g.globalAlpha = 0.5 + Math.sin(world.time * 5) * 0.12;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(player.x, player.y, BODY + 8, 0, 6.29);
    g.stroke();
    g.restore();

    stateMark(g, world, player);
    if ((player.zap || 0) > 0) arcs(g, player);

    mage(g, {
      x: player.x, y: player.y, angle: player.angle,
      palette: ROBES.player,
      sheet: 'player',
      moving: Math.hypot(player.vx, player.vy) > 12,
      phase: player.step * 0.35,
      cast: player.windup > 0 ? 1 : (player.cooldown > 0 ? player.cooldown * 3 : 0),
      charging: player.chargeLeft > 0,
      glow: player.chargeLeft > 0 ? colourOf(player.charging) : (held || ROBES.player.trim),
    });

    /*
     * Очередь висит над головой, а не только в углу экрана: заряженный маг
     * должен быть виден как угроза — и себе, и в записи чужого боя.
     */
    const top = player.y - BODY - 12;
    for (let i = 0; i < player.stack.length; i += 1) {
      const colour = colourOf(player.stack[i]);
      const ox = player.x + (i - (player.stack.length - 1) / 2) * 9;
      const float = Math.sin(world.time * 4 + i) * 1.2;

      g.save();
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = colour;
      g.globalAlpha = 0.75;
      g.beginPath();
      g.arc(ox, top + float, 5, 0, 6.29);
      g.fill();
      g.restore();

      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(ox, top + float, 1.8, 0, 6.29);
      g.fill();
    }

    if (player.chargeLeft > 0) {
      const fill = 1 - player.chargeLeft / CHARGE_STEP;
      const ox = player.x + (player.stack.length - (player.stack.length - 1) / 2) * 9 - 4;
      g.strokeStyle = colourOf(player.charging);
      g.lineWidth = 2;
      g.beginPath();
      g.arc(ox, top, 5, -Math.PI / 2, -Math.PI / 2 + fill * 6.28);
      g.stroke();
    }
  }

  /* Чем ломается предмет — цветом стихии. Черта переводится в цвет один
     раз здесь: игроку показывают не слово «crush», а комок земли. */
  const WEAKNESS_COLOURS = {
    burn: '#ff5a1f',
    wet: '#4de1ff',
    freeze: '#9fe8ff',
    crush: '#d08a3e',
    shock: '#ffe14d',
  };

/*
 * ОПАСНАЯ ЗОНА
 * =========================================================
 * Игра не только про то, как убить всех разом, но и про то, как при этом
 * уцелеть самому. Второе не работает, если зону поражения видно только
 * после выстрела: тогда это не тактика, а сюрприз, и единственный способ
 * научиться — умереть.
 *
 * Поэтому набранное заклинание рисует круг там, куда прилетит, ещё до
 * нажатия. Круг обычный, пока игрок вне его, и тревожный, когда внутри:
 * вспышка бьёт вокруг себя и накрывает своего всегда, а огонь достаёт
 * дальше места попадания — солома вокруг займётся сама.
 */
  function dangerZone(world) {
    const player = world.player;
    if (!player.stack || !player.stack.length) return null;

    const spell = spellOf(player.stack);
    if (!spell || !spell.form) return null;

    const reach = spell.substance.traits.reach || 1;
    const burns = Boolean(spell.substance.traits.burn);

    /* Вспышка бьёт от себя — центр всегда на игроке. */
    if (spell.form.kind === 'nova') {
      return {
        x: player.x, y: player.y,
        r: (spell.form.radius || 104) * reach,
        colour: spell.substance.colour, burns, self: true,
      };
    }

    /* Остальное прилетает туда, куда смотрит прицел. Точку берём по
       захваченной цели, а без неё — по лучу, как летел бы снаряд. */
    const aim = world.locked
      ? { x: world.locked.x, y: world.locked.y }
      : rayEnd(world, player.x, player.y, player.angle, 320 * reach);

    const r = TILE_SIZE * 0.9 * reach * (burns ? 1.7 : 1);
    return {
      x: aim.x, y: aim.y, r,
      colour: spell.substance.colour, burns,
      self: Math.hypot(aim.x - player.x, aim.y - player.y) < r + BODY,
    };
  }

  /* Докуда долетит: шагаем тем же шагом, что и снаряд. */
  function rayEnd(world, x, y, angle, limit) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    for (let t = 6; t < limit; t += 6) {
      const nx = x + dx * t;
      const ny = y + dy * t;
      const tile = world.tiles[tileRangeIndex(world, nx, ny)];
      if (tile === TILE.WALL) return { x: x + dx * (t - 6), y: y + dy * (t - 6) };
    }
    return { x: x + dx * limit, y: y + dy * limit };
  }

  function tileRangeIndex(world, x, y) {
    const tx = Math.max(0, Math.min(world.w - 1, (x / TILE_SIZE) | 0));
    const ty = Math.max(0, Math.min(world.h - 1, (y / TILE_SIZE) | 0));
    return ty * world.w + tx;
  }

  function drawDanger(g, world) {
    const zone = dangerZone(world);
    if (!zone) return;

    const beat = 0.6 + Math.sin(world.time * 7) * 0.4;

    g.save();
    g.globalCompositeOperation = 'lighter';

    if (zone.self) {
      /* Внутри своей же зоны. Тут не оттенок, тут предупреждение. */
      g.strokeStyle = '#ff4d5e';
      g.globalAlpha = 0.5 + beat * 0.5;
      g.lineWidth = 2.6;
      g.setLineDash([9, 7]);
      g.lineDashOffset = -world.time * 60;
    } else {
      g.strokeStyle = zone.colour;
      g.globalAlpha = 0.45;
      g.lineWidth = 1.6;
      g.setLineDash([6, 8]);
    }

    g.beginPath();
    g.arc(zone.x, zone.y, zone.r, 0, 6.29);
    g.stroke();
    g.setLineDash([]);

    /* У огня рисуем ещё и внешний круг: пожар уходит дальше попадания. */
    if (zone.burns) {
      g.globalAlpha = 0.22;
      g.lineWidth = 1.2;
      g.strokeStyle = zone.self ? '#ff4d5e' : '#ff8a3d';
      g.beginPath();
      g.arc(zone.x, zone.y, zone.r * 1.35, 0, 6.29);
      g.stroke();
    }

    g.restore();
  }

  /*
   * Всплывающая плата. Рисуется в мире, а не в интерфейсе: смотреть в
   * угол экрана игроку некогда, а ответ «твой способ засчитан» нужен ему
   * ровно там, где способ сработал.
   */
/*
 * ПОДХОДЯЩЕЕ ПОДСВЕЧИВАЕТСЯ
 * =========================================================
 * Набрал огонь — обвелась солома и бочка. Набрал молнию — кристалл.
 * Это не подсказка «сделай так», а свойство мира: подсветка говорит «сюда
 * подходит», а решает по-прежнему игрок. Разница принципиальная —
 * подсказку, указывающую на предмет, сегодня убрали нарочно, и возвращать
 * её нельзя.
 *
 * Подходит или нет, решает тот же brokenBy, который решает и само
 * разрушение. Отдельный список «вот эти предметы» рано или поздно
 * разошёлся бы с правилами, и игрок обнаружил бы подсвеченное, которое
 * не ломается, — а это хуже, чем отсутствие подсветки: мир перестаёт
 * быть надёжным, и предвкушение связки исчезает вместе с доверием.
 *
 * Обводка тонкая и без свечения намеренно. Светится в кадре одна вещь —
 * круг опасности; добавить сюда второй ореол значит погасить первый.
 */
  function drawMatching(g, world, range) {
    const player = world.player;
    if (!player.alive || !player.stack || !player.stack.length) return;

    const spell = spellOf(player.stack);
    if (!spell) return;

    const traits = spell.substance.traits;
    const beat = 0.5 + Math.sin(world.time * 4) * 0.18;

    g.save();
    g.strokeStyle = spell.substance.colour;
    g.lineWidth = 1.6;
    g.setLineDash([5, 5]);
    g.lineDashOffset = -world.time * 22;
    g.globalAlpha = beat;

    for (let ty = range.y0; ty <= range.y1; ty += 1) {
      for (let tx = range.x0; tx <= range.x1; tx += 1) {
        const tile = world.tiles[ty * world.w + tx];
        if (!weakTo(tile) || !brokenBy(tile, traits)) continue;
        g.strokeRect(tx * TILE_SIZE + 2.5, ty * TILE_SIZE + 2.5,
          TILE_SIZE - 5, TILE_SIZE - 5);
      }
    }

    g.setLineDash([]);
    g.restore();
  }

  function drawMarks(g, world) {
    if (!world.marks || !world.marks.length) return;

    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    for (const mark of world.marks) {
      const fade = Math.min(1, mark.life / (mark.max * 0.45));
      g.globalAlpha = fade;
      g.font = `800 ${mark.big ? 13 : 11}px ui-monospace, Menlo, monospace`;

      /* Тёмная подложка буквой: подпись ложится и на светлую лужу, и на
         тёмную траву, и читаться должна на обеих. */
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(6,8,14,.85)';
      g.strokeText(mark.text, mark.x, mark.y);

      g.fillStyle = mark.big ? '#ffe14d' : '#e8f2f6';
      g.fillText(mark.text, mark.x, mark.y);
    }

    g.restore();
  }

  function drawLock(g, world) {
    if (!world.locked) return;
    const { x, y } = world.locked;

    g.strokeStyle = '#ffffff';
    g.globalAlpha = 0.8;
    g.lineWidth = 1.6;
    for (const side of [-1, 1]) {
      g.beginPath();
      g.moveTo(x + side * 14, y - 15);
      g.lineTo(x + side * 18, y - 15);
      g.lineTo(x + side * 18, y + 15);
      g.lineTo(x + side * 14, y + 15);
      g.stroke();
    }
    g.globalAlpha = 1;

    /*
     * На захваченном предмете подписано, чем его брать. Без этого игроку
     * пришлось бы помнить наизусть, что валун берёт земля, а кристалл
     * молния, — а список будет расти.
     */
    if (world.locked.prop === undefined) return;
    const need = weakTo(world.tiles[world.locked.prop]);
    if (!need) return;

    need.forEach((trait, k) => {
      const ox = x + (k - (need.length - 1) / 2) * 9;
      const oy = y - 22;
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = WEAKNESS_COLOURS[trait] || '#ffffff';
      g.beginPath();
      g.arc(ox, oy, 3.4, 0, 6.29);
      g.fill();
      g.restore();
    });
  }


  /* =======================================================
     ЛЕТУЧЕЕ
     ======================================================= */

  function drawBullets(g, world) {
    for (const bullet of world.bullets) {
      const colour = bullet.colour || '#ffe06b';
      const r = bullet.nova ? 9 : 5;

      g.save();
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = colour;
      g.globalAlpha = 0.7;
      g.beginPath();
      g.arc(bullet.x, bullet.y, r, 0, 6.29);
      g.fill();
      g.globalAlpha = 1;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(bullet.x, bullet.y, r * 0.4, 0, 6.29);
      g.fill();
      g.restore();
    }
  }

  function drawBlasts(g, world) {
    for (const blast of world.blasts) {
      const t = 1 - blast.life / blast.span;
      const fade = 1 - t;

      if (blast.kind === 'cone') {
        g.beginPath();
        g.moveTo(blast.x, blast.y);
        g.arc(blast.x, blast.y, blast.reach * (0.6 + t * 0.4),
          blast.angle - blast.arc / 2, blast.angle + blast.arc / 2);
        g.closePath();
        g.fillStyle = hexToRgba(blast.colour, fade * 0.45);
        g.fill();
        continue;
      }

      if (blast.kind === 'beam') {
        g.strokeStyle = hexToRgba(blast.colour, fade);
        g.lineWidth = 10 * fade + 2;
        g.beginPath();
        g.moveTo(blast.x, blast.y);
        g.lineTo(blast.x2, blast.y2);
        g.stroke();
        g.strokeStyle = `rgba(255,255,255,${fade})`;
        g.lineWidth = 3 * fade + 1;
        g.stroke();
        continue;
      }

      if (blast.kind === 'nova') {
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.strokeStyle = hexToRgba(blast.tint || '#ffffff', fade);
        g.lineWidth = 6 * fade + 1;
        g.beginPath();
        g.arc(blast.x, blast.y, blast.radius * (0.3 + t * 0.8), 0, 6.29);
        g.stroke();
        g.fillStyle = `rgba(255,255,255,${fade * 0.16})`;
        g.fill();
        g.restore();
      }
    }
  }

  function hexToRgba(hex, alpha) {
    const value = parseInt(hex.slice(1), 16);
    return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
  }

  function drawPops(g, world) {
    for (const ring of world.pops) {
      const t = 1 - ring.life / ring.span;
      g.strokeStyle = `rgba(${ring.colour},${(1 - t) * 0.9})`;
      g.lineWidth = 3 * (1 - t) + 1;
      g.beginPath();
      g.arc(ring.x, ring.y, ring.r + (ring.max - ring.r) * t, 0, 6.29);
      g.stroke();
    }
  }

  function drawParticles(g, world) {
    for (const particle of world.particles) {
      g.globalAlpha = Math.max(0, particle.life / particle.max);
      g.fillStyle = particle.color;
      g.fillRect(particle.x - particle.size / 2, particle.y - particle.size / 2,
        particle.size, particle.size);
    }
    g.globalAlpha = 1;
  }

  /* Пар и пыль — единственное, что рисуется поверх тел: они их и прячут. */
  function drawClouds(g, world) {
    if (!world.clouds) return;

    for (const cloud of world.clouds) {
      const fade = Math.min(1, cloud.life / cloud.span);
      const r = cloud.r * (1 + (1 - fade) * 0.5);
      const core = cloud.kind === 'dust' ? '190,168,120' : '214,232,244';

      const grad = g.createRadialGradient(cloud.x, cloud.y, r * 0.15, cloud.x, cloud.y, r);
      grad.addColorStop(0, `rgba(${core},${0.46 * fade})`);
      grad.addColorStop(0.6, `rgba(${core},${0.28 * fade})`);
      grad.addColorStop(1, `rgba(${core},0)`);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cloud.x, cloud.y, r, 0, 6.29);
      g.fill();
    }
  }


  /* =======================================================
     КАДР
     ======================================================= */

  /*
   * Свет.
   *
   * Ночь здесь не палитра, а слой: поверх кадра ложится тьма, и источники
   * прожигают в ней дыры. Разница с прежним «нарисуем пятно под фонарём»
   * принципиальная. Раньше пятна светлели поверх, и без источника было
   * ровно так же светло; теперь без источника темно, и фонарь, костёр или
   * собственный посох — единственное, что видно.
   *
   * Это же чинит и то, ради чего затевалось поле: пожар освещает комнату,
   * и по зареву видно, что где-то горит, — раньше об этом сообщала только
   * сама клетка, на которую надо было смотреть.
   */
  const NIGHT = 'rgba(3,9,10,0.82)';

  function collectLights(world, theme, camX, camY, halfW, halfH) {
    const lights = [];
    const near = (x, y, pad) => Math.abs(x - camX) < halfW + pad
      && Math.abs(y - camY) < halfH + pad;
    const add = (x, y, r, colour, power) => lights.push({ x, y, r, colour, power });

    /* Фонари на оградах — единственный неподвижный свет в кадре. */
    for (let ty = 0; ty < world.h; ty += 1) {
      for (let tx = 0; tx < world.w; tx += 1) {
        if (world.tiles[ty * world.w + tx] !== TILE.WALL || !hasLamp(tx, ty)) continue;
        const x = tx * TILE_SIZE + HALF;
        const y = ty * TILE_SIZE + HALF;
        if (near(x, y, 200)) add(x, y, 165, theme.wallEdge, 0.72);
      }
    }

    /* Огонь на полу. Клеток бывает много, поэтому светит каждая вторая:
       на глаз разницы нет, а градиентов вдвое меньше. */
    if (world.ground) {
      for (let i = 0; i < world.ground.length; i += 2) {
        if (world.ground[i] !== GROUND.FIRE) continue;
        const x = (i % world.w) * TILE_SIZE + HALF;
        const y = ((i / world.w) | 0) * TILE_SIZE + HALF;
        if (!near(x, y, 160)) continue;
        const caught = Math.min(1, world.groundAge[i] / FIRE_CATCH);
        add(x, y, 105 + Math.random() * 25, '#ff7a2a', 0.45 + caught * 0.5);
      }
    }

    /* Заряженный маг светит сам — и потому в темноте заметен первым. */
    const player = world.player;
    if (player.alive) {
      const held = player.chargeLeft > 0 ? colourOf(player.charging)
        : (player.stack.length ? colourOf(player.stack[player.stack.length - 1]) : '#9df9ff');
      add(player.x, player.y, 155,
        held, Math.min(1, 0.55 + player.stack.length * 0.15));
    }

    for (const enemy of world.enemies) {
      if (!enemy.alive || !near(enemy.x, enemy.y, 120)) continue;
      const colour = enemy.resist ? colourOf(enemy.resist)
        : (enemy.element ? colourOf(enemy.element) : null);
      if (colour) add(enemy.x, enemy.y, 74, colour, 0.5);
      if (enemy.burning > 0) add(enemy.x, enemy.y, 115, '#ff7a2a', 0.9);
    }

    for (const bullet of world.bullets) {
      if (!near(bullet.x, bullet.y, 100)) continue;
      add(bullet.x, bullet.y, bullet.nova ? 135 : 82, bullet.colour || '#ffe06b', 0.8);
    }

    for (const blast of world.blasts) {
      const fade = Math.max(0, blast.life / blast.span);
      if (fade <= 0) continue;
      add(blast.x, blast.y, (blast.radius || blast.reach || 120) * 1.7,
        blast.tint || blast.colour || '#ffffff', fade);
    }

    /*
     * Больше двух десятков источников в кадре не нужно и вредно: каждый —
     * это два радиальных градиента, а на глаз двадцать пятый костёр уже не
     * различить. Оставляем ближние к камере.
     */
    if (lights.length > 22) {
      lights.sort((a, b) => (Math.hypot(a.x - camX, a.y - camY)
        - Math.hypot(b.x - camX, b.y - camY)));
      lights.length = 22;
    }

    return lights;
  }

  /*
   * Свет считается вполовину меньше кадра и растягивается обратно.
   *
   * Пятно света — это мягкое размытое ничто; половина разрешения на нём не
   * видна вообще, а работы вчетверо меньше. На телефоне это разница между
   * игрой и слайд-шоу: два полноэкранных прохода с десятками радиальных
   * градиентов — самое дорогое, что вообще делает кадр.
   */
  const LIGHT_SCALE = 0.5;

/* Ночь снята до отдельной работы по освещению: см. drawLights. */
const DARKNESS = false;

  function drawLights(world, theme, camX, camY, zoom, shakeX, shakeY, halfW, halfH) {
    /*
     * Затемнение выключено. Ночь давала настроение и отнимала игру: на
     * телефоне поле уходило почти в чёрное, и предметы, ради которых сюда
     * и целятся, приходилось угадывать. Цветной проход остался — он
     * только добавляет свет и ничего не прячет, поэтому огонь и разряд
     * по-прежнему подсвечивают своё.
     *
     * Освещение вернётся отдельной работой: тьма имеет смысл, только если
     * в ней видно, что важно, а это надо делать нарочно, а не остатком
     * от полноэкранной заливки.
     */
    if (!DARKNESS) { drawLightColour(world, theme, camX, camY, zoom, shakeX, shakeY, halfW, halfH); return; }

    const lw = Math.max(1, Math.round(canvas.width * LIGHT_SCALE));
    const lh = Math.max(1, Math.round(canvas.height * LIGHT_SCALE));
    if (lightLayer.width !== lw || lightLayer.height !== lh) {
      lightLayer.width = lw;
      lightLayer.height = lh;
    }

    const g = lightCtx;
    const scale = dpr * LIGHT_SCALE;
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, viewW, viewH);
    g.fillStyle = NIGHT;
    g.fillRect(0, 0, viewW, viewH);

    const lights = collectLights(world, theme, camX, camY, halfW, halfH);

    g.save();
    g.translate(viewW / 2, viewH / 2);
    g.scale(zoom, zoom);
    g.translate(-camX + shakeX, -camY + shakeY);

    /* Дыры в темноте. Мягкий край обязателен: резкий круг читается как
       дырка в бумаге, а не как свет. */
    g.globalCompositeOperation = 'destination-out';
    for (const light of lights) {
      const power = Math.min(1, light.power);
      const grad = g.createRadialGradient(light.x, light.y, 1, light.x, light.y, light.r);
      grad.addColorStop(0, `rgba(0,0,0,${power})`);
      grad.addColorStop(0.45, `rgba(0,0,0,${power * 0.55})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(light.x - light.r, light.y - light.r, light.r * 2, light.r * 2);
    }
    g.restore();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(lightLayer, 0, 0, canvas.width, canvas.height);

    drawLightColour(world, theme, camX, camY, zoom, shakeX, shakeY, halfW, halfH, lights);
  }

  /*
   * Проход цветом. Тьма показывает, где светло; этот проход — каким оно
   * светится. Без него огонь и разряд освещают одинаково белым, и цвет
   * стихии, главный язык игры, пропадает.
   *
   * Он только добавляет свет, поэтому работает и без затемнения: горящая
   * лужа отсвечивает оранжевым на светлом полу ровно так же.
   */
  function drawLightColour(world, theme, camX, camY, zoom, shakeX, shakeY, halfW, halfH, ready) {
    const lights = ready || collectLights(world, theme, camX, camY, halfW, halfH);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.translate(viewW / 2, viewH / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-camX + shakeX, -camY + shakeY);
    ctx.globalCompositeOperation = 'lighter';
    for (const light of lights) {
      const grad = ctx.createRadialGradient(light.x, light.y, 1, light.x, light.y, light.r);
      grad.addColorStop(0, hexToRgba(light.colour, 0.15 * Math.min(1, light.power)));
      grad.addColorStop(1, hexToRgba(light.colour, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(light.x - light.r, light.y - light.r, light.r * 2, light.r * 2);
    }
    ctx.restore();
  }

  function draw(world, view) {
    world.rebake = false;

    const theme = THEMES[world.level.theme] || THEMES[0];
    const zoom = zoomFor(world);
    const halfW = viewW / (2 * zoom);
    const halfH = viewH / (2 * zoom);

    let camX = view.x;
    let camY = view.y;
    const worldW = world.w * TILE_SIZE;
    const worldH = world.h * TILE_SIZE;
    camX = worldW <= halfW * 2 ? worldW / 2 : Math.max(halfW, Math.min(worldW - halfW, camX));
    camY = worldH <= halfH * 2 ? worldH / 2 : Math.max(halfH, Math.min(worldH - halfH, camY));

    /* Короткий наезд на попадании: кадр «клюёт» вперёд и возвращается. */
    const punch = 1 + world.fx.punch * 0.035;
    const shake = world.fx.shake;
    const shakeX = shake ? (Math.random() - 0.5) * shake : 0;
    const shakeY = shake ? (Math.random() - 0.5) * shake : 0;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.sky;
    ctx.fillRect(0, 0, viewW, viewH);

    ctx.save();
    ctx.translate(viewW / 2, viewH / 2);
    ctx.scale(zoom * punch, zoom * punch);
    ctx.translate(-camX + shakeX, -camY + shakeY);

    /* Картинки приходят вчетверо крупнее клетки и уменьшаются: сглаживание
       тут не мылит, а наоборот — без него уменьшение рвёт деталь. */
    ctx.imageSmoothingEnabled = true;

    const range = tileRange(world, camX, camY, halfW, halfH);

    drawFloor(ctx, world, theme, range);
    drawGround(ctx, world, range);
    drawCharge(ctx, world, range);
    drawResidual(ctx, world, range);
    drawDanger(ctx, world);
    drawDecals(ctx, world);
    drawCorpses(ctx, world);
    drawProps(ctx, world, theme, range);
    drawOperationProps(ctx, world);
    drawOperationActors(ctx, world);
    drawEnemies(ctx, world);
    drawMatching(ctx, world, range);
    drawLock(ctx, world);
    drawMarks(ctx, world);
    drawPlayer(ctx, world);
    drawBullets(ctx, world);
    drawBlasts(ctx, world);
    drawPops(ctx, world);
    drawParticles(ctx, world);
    drawWalls(ctx, world, theme, range);
    drawClouds(ctx, world);

    ctx.restore();

    drawLights(world, theme, camX, camY, zoom * punch, shakeX, shakeY, halfW, halfH);

    if (world.fx.flash > 0.01) {
      ctx.fillStyle = `rgba(120,255,214,${world.fx.flash * 0.2})`;
      ctx.fillRect(0, 0, viewW, viewH);
    }

    vignette(ctx, theme);

    return { zoom, camX, camY };
  }

  function vignette(g, theme) {
    const grad = g.createRadialGradient(
      viewW / 2, viewH / 2, Math.min(viewW, viewH) * 0.4,
      viewW / 2, viewH / 2, Math.max(viewW, viewH) * 0.78);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, hexToRgba(theme.sky, 0.6));
    g.fillStyle = grad;
    g.fillRect(0, 0, viewW, viewH);
  }

  /* Сверху экран и мир смотрят в одну сторону, и перевод для мыши —
     обычный сдвиг с масштабом. Отдельной дверью он остаётся потому, что
     звать его должен тот, кто не обязан знать про камеру. */
  function toWorld(screenX, screenY, last) {
    return {
      x: last.camX + (screenX - viewW / 2) / last.zoom,
      y: last.camY + (screenY - viewH / 2) / last.zoom,
    };
  }

  return { resize, draw, invalidate, toWorld };
}
