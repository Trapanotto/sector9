// Staged moments, mission flow data (objectives, evidence, checkpoint, breachable door, ambient pacing) and the
// player spawn. Owner: F (director). Pure data: importable from Node (tests) and the browser.
//
// `box` of every moment is also a core trigger volume (ctx.world.triggers → 'trigger:enter'); D's ambushers that
// name a moment in `trigger` (actors.js) may react to it. The director itself starts a moment from its own `vols`
// (default [box]; null = global), `pre` and `when` conditions, then runs one of its `variants` (seeded per run).
// Timeline syntax: see src/director/runtime.js; conditions/positions: src/director/cond.js.
//
// PACING CURVE (expected route; every moment also works out of order — preconditions keep the climax late):
//   dread      m01 Hof (radio: alone)             → contact   m02 Tor fällt (trapped, eyes still adjusting)
//   contact    m03 Packerei (radio stops → ambush) → dread     m04 Keller (blackout, door swings open)
//   escalation m05 Halle dunkel (torches, crawl-gap ambush, or a runner)
//   false alarm m07 AGV (glides out of the dark)  → false calm m11 Telefon (rings in the empty office)
//   dread      m08 Schrei (behind the locked door, silence when you come close)
//   climax 1   m12 Geldraum (breach → siren + strobe, surrender or bait)
//   tension    m13 Steg (magazine clatters on the catwalk above)
//   escalation m06 Förderband (the automation wakes up: noise masks footsteps, powder carton)
//   contact    m09 Roboter → dread/contact m10 Kühlraum (fog) → climax 2 m14 Verladung (last stand at the docks)
//   extraction 'extract' (van, north side)

// Player start (feet position, yaw as in actors.js)
export const PLAYER_SPAWN = { pos: [45, 0, 107.5], yaw: 0, zone: 'hof' };

// enemy groups usable in timelines as '@name'
export const GROUPS = {
  hof: ['e01', 'e02'], we: ['e03', 'e04', 'e05'], pack: ['e06', 'e07', 'e08'], west: ['e09', 'e10'],
  schlaf: ['e11', 'e12'], og: ['e11', 'e12', 'e13', 'e14'], halle: ['e15', 'e16', 'e17'], patrouille: ['e15', 'e16'],
  auto: ['e18', 'e19'], keller: ['e20'], versand: ['e21', 'e22'],
};

const HALL_ZONES = ['halle_n', 'halle_m', 'halle_s', 'steg', ...Array.from({ length: 9 }, (_, i) => [`gang${i}_n`, `gang${i}_s`]).flat()];
const AISLES = Array.from({ length: 7 }, (_, i) => [`gang${i + 1}_n`, `gang${i + 1}_s`]).flat();
const AUTO_ZONES = ['auto_n', 'auto_s', 'buehne', 'akl', 'roboter', 'versand', 'kuehl'];
const RADIO_SND = 'loop.radio|voice.muffled.laugh';   // E: a muffled pocket-radio music loop would be ideal
const TV_SND = 'loop.tv|loop.static';

const M = (o) => ({ once: true, tension: 0.15, ...o, title: o.title });

export const MOMENTS = [
  // ------------------------------------------------------------------------------------------------ 1 dread
  M({
    id: 'm01_ankunft', order: 1, phase: 'dread', title: 'Ankunft',
    box: [38, -1, 95, 54, 4, 104], vols: [[34, -1, 90, 56, 4, 110]], when: [['time', 1.5]], tension: 0.05,
    brief: ['Funk: allein, Verstärkung spät. Geräusche aus dem offenen Tor 2 ziehen den Blick zum Gebäude.'],
    variants: [
      { id: 'musik', note: 'Funk, dann Gelächter hinter Tor 2, ein Rückfahrwarner drinnen', tl: [
        [0, 'radio', 'Zentrale', 'S9-17, Zugriff frei. Verstärkung frühestens in zwanzig Minuten.'],
        [[6, 1.5], 'sound', 'we_stimmen', 'voice.muffled.laugh', [12, 1.6, 61], { loop: true, vol: 0.7 }],
        [[14, 3], 'sound', 'we_warner', 'loop.beeper', [18, 1.2, 56], { loop: true, vol: 0.45 }],
        [[21, 2], 'stop', 'we_warner', 0.6],
      ] },
      { id: 'stille', note: 'Objektschutz antwortet nicht; irgendwo rattelt ein Rolltor', tl: [
        [0, 'radio', 'Zentrale', 'Der Objektschutz meldet sich seit 14:50 nicht mehr. Vorsicht.'],
        [[10, 3], 'sound', '-', 'door.roller.rattle', [82, 1.5, 64.4], { vol: 0.6 }],
        [[16, 3], 'sound', 'we_stimmen', 'voice.muffled.talk', [12, 1.6, 61], { loop: true, vol: 0.5 }],
      ] },
      { id: 'husten', note: 'Zeuge: fünf Bewaffnete; e01 hustet vor Tor 2', tl: [
        [0, 'radio', 'Zentrale', 'Ein Zeuge spricht von mindestens fünf Bewaffneten. Sie sind vorerst allein.'],
        [[7, 2], 'sound', '-', 'voice.cough', 'e01', { vol: 0.8 }],
        [[11, 2], 'sound', 'we_stimmen', 'voice.muffled.talk', [12, 1.6, 61], { loop: true, vol: 0.6 }],
      ] },
    ],
  }),
  // ------------------------------------------------------------------------------------------------ 2 trap
  M({
    id: 'm02_tor_faellt', order: 2, phase: 'contact', title: 'Tor fällt',
    box: [9, -1, 55, 15, 4, 62],
    // only once the player is inside and looks into the hall (or after 3.5 s) — never onto the player
    when: [['any', ['away', { door: 'd_dock2' }, -0.2], ['far', { door: 'd_dock2' }, 7]]], whenTimeout: 3.5, tension: 0.3,
    brief: ['Aus der Sonne ins dunkle Lager: die Kamera regelt noch nach, als hinter dem Spieler das Tor fällt.',
      'Fail-safe: Tor 2 bleibt verriegelt; Tor 1/3, Seitentür West und Tür Süd bleiben benutzbar.'],
    persist: [],
    variants: [
      { id: 'tor', w: 1.3, note: 'Tor 2 kracht herunter, Stimmen verstummen, e03/e04 kommen', tl: [
        [0, 'stop', 'we_stimmen', 0], [0, 'door', 'd_dock2', 'locked', 1.6],
        [0, 'sound', '-', 'door.roller.slam', { door: 'd_dock2' }, { vol: 1 }],
        [[1.3, 0.3], 'sound', '-', 'voice.alert', 'e03'],
        [1.5, 'alert', ['e03', 'e04'], 'player'],
        [[5, 1.5], 'alert', ['e05'], 'player'],
      ], persist: [[0, 'door', 'd_dock2', 'locked']] },
      { id: 'licht', note: 'Tor bleibt offen, aber das Licht im Westflügel geht auf Notbeleuchtung', tl: [
        [0, 'stop', 'we_stimmen', 0],
        [0.2, 'sound', '-', 'foley.switch', [1, 2.5, 60]],
        [0.3, 'light', 'west_eg', 0.3, 0.8, 1],
        [[2.2, 0.8], 'sound', '-', 'voice.distant.shout', [14, 1.6, 40]],
        [3, 'stage', ['e05'], 'investigate', { pos: [12, 0, 57] }],
      ], persist: [[0, 'light', 'west_eg', 0.3, 0]] },
      { id: 'spaet', note: 'erst tiefer drin fällt das Tor; e03/e04 gehen zum Tor, also hinter den Spieler', tl: [
        [0, 'until', ['far', { door: 'd_dock2' }, 10], 12],
        [0, 'stop', 'we_stimmen', 0.3],
        [[0.4, 0.4], 'door', 'd_dock2', 'locked', 1.2],
        [0.4, 'sound', '-', 'door.roller.slam', { door: 'd_dock2' }, { vol: 1 }],
        [3, 'sound', '-', 'voice.alert', 'e04'],
        [3.2, 'stage', ['e03', 'e04'], 'investigate', { pos: [12, 0, 60] }],
      ], persist: [[0, 'door', 'd_dock2', 'locked']] },
    ],
  }),
  // ------------------------------------------------------------------------------------------------ 3 first contact
  M({
    id: 'm03_packerei', order: 3, phase: 'contact', title: 'Hinterhalt Packerei',
    box: [6, -1, 30, 22, 4, 36],
    vols: [[3, -1, 36.1, 25, 4, 44], [22, -1, 24, 27.85, 4, 35.9], [0, -1, 12.1, 22, 4, 24]],
    actors: ['@pack'], tension: 0.2,
    brief: ['Das Radio in der Packerei spielt seit Einsatzbeginn – bis es abrupt verstummt. Stille als Warnung.',
      'e08 hinter dem Kartonstapel (deckung_pack). Variante: e07 ergibt sich – als Köder.'],
    variants: [
      { id: 'stille', note: 'Radio aus, Rascheln, e08 bricht aus der Deckung', setup: [[0, 'sound', 'pack_radio', RADIO_SND, [12, 1.1, 28], { loop: true, vol: 0.8 }]], tl: [
        [0, 'stop', 'pack_radio', 0], [0, 'tension', 0.15],
        [[1.4, 0.6], 'sound', '-', 'foley.cloth', 'e08', { vol: 0.7 }],
        [1.6, 'until', ['any', ['inBox', [6, -1, 30, 22, 4, 36]], ['near', 'e08', 6], ['look', 'e08', 0.97, 14]], 25],
        [[0.3, 0.2], 'ambush', ['e08']], [0.7, 'alert', ['e06', 'e07'], 'player'],
      ] },
      { id: 'musik', note: 'Radio spielt weiter; e06 bemerkt den Spieler, e08 wartet auf kurze Distanz', setup: [[0, 'sound', 'pack_radio', RADIO_SND, [12, 1.1, 28], { loop: true, vol: 0.8 }]], tl: [
        [0, 'until', ['any', ['inBox', [6, -1, 30, 22, 4, 36]], ['look', 'e06', 0.93, 16]], 30],
        [0.4, 'alert', ['e06'], 'player'], [0.9, 'stop', 'pack_radio', 0.1],
        [1, 'until', ['any', ['near', 'e08', 5], ['dead', ['e06', 'e07']]], 25],
        [0.2, 'ambush', ['e08']], [0.5, 'alert', ['e07'], 'player'],
      ] },
      { id: 'koeder', w: 0.8, note: 'e07 hebt die Hände – e08 schießt, wenn der Spieler nah heran geht', setup: [[0, 'sound', 'pack_radio', RADIO_SND, [12, 1.1, 28], { loop: true, vol: 0.8 }]], tl: [
        [0, 'stop', 'pack_radio', 0],
        [0, 'until', ['inBox', [6, -1, 30, 22, 4, 36]], 25],
        [0.2, 'stage', ['e07'], 'surrender', { bait: true }],
        [0.3, 'sound', '-', 'voice.plead', 'e07'],
        [0.5, 'until', ['any', ['near', 'e07', 4.5], ['dead', ['e07']]], 12],
        [[0.6, 0.4], 'ambush', ['e08']], [1.2, 'alert', ['e06'], 'player'],
      ] },
    ],
  }),
  // ------------------------------------------------------------------------------------------------ 4 dread
  M({
    id: 'm04_keller_licht', order: 4, phase: 'dread', title: 'Stromausfall Keller',
    box: [14.1, -3.8, 46.6, 17, -1, 48.6], vols: [[14.1, -3.8, 46.6, 17, -1, 48.6], [25, -3.8, 46.6, 28.6, -1, 48.6]], tension: 0.2,
    brief: ['Im Versorgungsgang: Licht stirbt, nur Notlicht und die Taschenlampe. Die Tür zum Technikraum schwingt langsam auf.'],
    variants: [
      { id: 'ausfall', note: 'Flackern, Sicherung, Notlicht; Tür schwingt auf, e20 wach', tl: [
        [0, 'sound', '-', 'machine.light.flicker', [13.3, -0.6, 47.6]],
        [0.1, 'light', 'keller', 0, 0.7, 1],
        [0.9, 'sound', '-', 'foley.switch', [11.5, -2, 43]],
        [2.2, 'light', 'keller', 0.07, 1.5],
        [[3.5, 1], 'door', 'd_technik', 'open', 0.22],
        [6, 'alert', ['e20'], 'player'],
        [6.2, 'sound', '-', 'voice.breath.panic', 'e20'],
      ], persist: [[0, 'light', 'keller', 0.07, 0], [0, 'door', 'd_technik', 'open']] },
      { id: 'schnarchen', note: 'Schnarchen hinter der Tür, verstummt beim Näherkommen, dann Licht aus', tl: [
        [0, 'sound', 'keller_schnarchen', 'voice.snore', 'e20', { loop: true, vol: 0.8 }],
        [0, 'until', ['any', ['near', { door: 'd_technik' }, 4], ['dead', ['e20']]], 40],
        [0, 'stop', 'keller_schnarchen', 0],
        [[1.8, 0.6], 'light', 'keller', 0, 0.15],
        [2.6, 'light', 'keller', 0.07, 2],
        [3, 'alert', ['e20'], 'player'],
      ], persist: [[0, 'light', 'keller', 0.07, 0]] },
      { id: 'flackern', w: 0.7, note: 'Fehlalarm: Licht flackert und kommt wieder, Tür steht plötzlich halb offen', tl: [
        [0, 'light', 'keller', 0.15, 0.3, 1],
        [0.1, 'sound', '-', 'machine.light.flicker', [18, -0.6, 47.6]],
        [2.5, 'light', 'keller', 1, 2.5, 1],
        [4, 'door', 'd_technik', 'half', 0.15],
      ], persist: [[0, 'door', 'd_technik', 'half']] },
    ],
  }),
  // ------------------------------------------------------------------------------------------------ 5 escalation
  M({
    id: 'm05_halle_dunkel', order: 5, phase: 'escalation', title: 'Halle dunkel',
    box: [28.15, -1, 27.6, 34, 4, 31.4],
    vols: [[28.15, -1, 27.6, 34, 4, 31.4], [28.15, -1, 53, 38, 4, 64], [28.15, -1, 0, 36, 4, 6]], tension: 0.25,
    brief: ['Hallenlicht fällt abschnittsweise aus – nur Oberlichter. Taschenlampen der Patrouille zwischen den Regalen.',
      'e17 wartet in der Regallücke. Variante: ein Läufer kreuzt den Quergang, irgendwo piept ein Stapler.'],
    variants: [
      { id: 'abschnitte', note: 'zwei Schaltgeräusche, Licht geht in Stufen aus, Patrouille mit Lampen', tl: [
        [0, 'sound', '-', 'foley.switch', [50, 8, 32]],
        [0, 'light', 'halle', 0.5, 0.4, 1],
        [1.4, 'sound', '-', 'foley.switch', [50, 8, 32]],
        [1.4, 'light', 'halle', 0.1, 1.2, 1],
        [2.5, 'radio', 'Zentrale', 'Der Netzbetreiber meldet eine Abschaltung im Objekt. Das waren nicht wir.'],
        [3, 'stage', '@patrouille', 'flashlight', { on: true }],
        [3.2, 'stage', '@patrouille', 'investigate', { pos: 'player' }],
        [3.5, 'until', ['any', ['near', 'e17', 7], ['look', 'e17', 0.96, 14], ['dead', ['e17']]], 60],
        [0.2, 'ambush', ['e17']],
      ], persist: [[0, 'light', 'halle', 0.1, 0]] },
      { id: 'laeufer', note: 'Licht bleibt; jemand sprintet über den Quergang, dann ein Rückfahrwarner', tl: [
        [[1, 0.5], 'stage', ['e16'], 'runner', { from: [50.1, 0, 20], to: [50.1, 0, 40] }],
        [1, 'steps', 'step.concrete', [50.1, 0.1, 21], [50.1, 0.1, 37], 7, 0.28],
        [4, 'sound', 'halle_warner', 'loop.beeper', [40, 1.2, 62.5], { loop: true, vol: 0.55 }],
        [12, 'stop', 'halle_warner', 0.4],
        [12, 'until', ['any', ['near', 'e17', 6], ['dead', ['e17']]], 60],
        [0.3, 'ambush', ['e17']],
      ] },
      { id: 'ploetzlich', note: 'erst im Regalgang: Licht schlagartig aus, e15 macht die Lampe an', tl: [
        [0, 'until', ['zone', AISLES], 45],
        [0, 'light', 'halle', 0.08, 0],
        [0, 'sound', '-', 'foley.switch', [44, 8, 30]],
        [0.3, 'tension', 0.3],
        [1.5, 'stage', ['e15'], 'flashlight', { on: true }],
        [2, 'until', ['any', ['near', 'e17', 6], ['dead', ['e17']]], 60],
        [0.3, 'ambush', ['e17']],
      ], persist: [[0, 'light', 'halle', 0.08, 0]] },
    ],
  }),
  // ------------------------------------------------------------------------------------------------ 6 false alarm
  M({
    id: 'm07_agv', order: 6, phase: 'false_alarm', title: 'AGV kreuzt',
    box: [56, -1, 53, 71.8, 4, 64], tension: 0.12,
    brief: ['Ein fahrerloses Fahrzeug gleitet mit Warnton aus dem Dunkel quer durch den Gang. Meist harmlos.'],
    variants: [
      { id: 'nur_agv', note: 'nur das Fahrzeug', tl: [[0, 'machine', 'agv', 'agv2', 'dispatch']] },
      { id: 'neugierig', note: 'e16 hört den Warnton und kommt nachsehen', tl: [
        [0, 'machine', 'agv', 'agv2', 'dispatch'],
        [[4, 1], 'stage', ['e16'], 'investigate', { pos: [60, 0, 58] }],
      ] },
      { id: 'stillstand', note: 'AGV bleibt mitten im Gang stehen und piept weiter', tl: [
        [0, 'machine', 'agv', 'agv2', 'dispatch'],
        [[5, 1.5], 'machine', 'agv', 'agv2', 'stop'],
        [5.1, 'sound', 'agv_piepen', 'loop.beeper', { agv: 'agv2' }, { loop: true, vol: 0.5 }],
        [14, 'stop', 'agv_piepen', 1],
      ] },
    ],
  }),
  // ------------------------------------------------------------------------------------------------ 7 false calm
  M({
    id: 'm11_telefon', order: 7, phase: 'calm', title: 'Telefon',
    box: [22.1, 4.2, 11.9, 27.85, 7, 17.06], tension: 0.08,
    brief: ['Oben angekommen: im leeren Büro klingelt das Festnetztelefon. Niemand geht ran. Oder doch.'],
    variants: [
      { id: 'klingeln', note: 'klingelt lange, hört auf', tl: [
        [0, 'sound', 'og_telefon', 'machine.phone', [13.5, 5.4, 2.5], { loop: true, vol: 0.9 }],
        [[16, 4], 'stop', 'og_telefon', 0],
      ] },
      { id: 'geweckt', note: 'das Klingeln weckt e11, er schlurft zum Büro', tl: [
        [0, 'sound', 'og_telefon', 'machine.phone', [13.5, 5.4, 2.5], { loop: true, vol: 0.9 }],
        [9, 'stage', ['e11'], 'investigate', { pos: [12.5, 4.5, 10] }],
        [9.5, 'sound', '-', 'voice.cough', 'e11'],
        [12, 'stop', 'og_telefon', 0],
      ] },
      { id: 'fernseher', note: 'kein Telefon: Fernseher in der Schlafecke läuft – und geht aus, wenn man näher kommt', tl: [
        [0, 'sound', 'og_tv', TV_SND, [10, 5.2, 19.8], { loop: true, vol: 0.6 }],
        [0, 'until', ['near', [9, 5.5, 17], 6], 60],
        [0, 'stop', 'og_tv', 0],
        [1.5, 'sound', '-', 'foley.cloth', [6, 5.2, 17]],
        [2, 'alert', ['e12'], 'player'],
      ] },
    ],
  }),
  // ------------------------------------------------------------------------------------------------ 8 dread
  M({
    id: 'm08_schrei', order: 8, phase: 'dread', title: 'Schrei',
    box: [8, 4.0, 9.1, 14, 7, 11.9], vols: [[9, 4.2, 9.1, 22.1, 7, 11.9]], tension: 0.2,
    brief: ['Hinter der verriegelten Tür des Geldzählraums: Streit, ein Schrei, Schläge. Kommt man näher – Stille.',
      'Tür ist verriegelt: zweimal "Benutzen" kurz hintereinander tritt sie auf, oder das Schloss zerschießen.'],
    variants: [
      { id: 'streit', note: 'Streit, Schrei, Schlag gegen die Tür, dann Stille', tl: [
        [0, 'sound', 'geld_stimmen', 'voice.muffled.argue', [4.5, 5.5, 5], { loop: true, vol: 0.9 }],
        [[3, 1], 'sound', '-', 'voice.distant.scream', [4.5, 5.5, 5]],
        [4, 'sound', '-', 'impact.wood', [7.5, 5.2, 8.6]],
        [4.5, 'until', ['near', { door: 'd_geld' }, 3.2], 40],
        [0, 'stop', 'geld_stimmen', 0], [0, 'tension', 0.25],
        [[2.5, 1], 'sound', '-', 'foley.cloth', [6, 5.2, 7], { vol: 0.6 }],
      ] },
      { id: 'flehen', note: 'jemand fleht, ein Schmerzlaut; Stille beim Näherkommen', tl: [
        [0, 'sound', '-', 'voice.plead', [4.5, 5.5, 5]],
        [2.5, 'sound', '-', 'voice.pain', [4.5, 5.5, 5]],
        [4, 'sound', 'geld_stimmen', 'voice.muffled.talk', [4.5, 5.5, 5], { loop: true, vol: 0.8 }],
        [5.5, 'sound', '-', 'voice.plead', [4.5, 5.5, 5]],
        [6, 'until', ['near', { door: 'd_geld' }, 3.5], 40],
        [0, 'stop', 'geld_stimmen', 0],
        [[4, 1.5], 'sound', '-', 'voice.dying', [4.5, 5.2, 5], { vol: 0.4 }],
      ] },
      { id: 'fluestern', note: 'leises Gemurmel, verstummt; später klopft es von innen', tl: [
        [0, 'sound', 'geld_stimmen', 'voice.muffled.talk', [4.5, 5.5, 5], { loop: true, vol: 0.45 }],
        [0, 'until', ['near', { door: 'd_geld' }, 4], 40],
        [0, 'stop', 'geld_stimmen', 0],
        [[6, 2], 'sound', '-', 'impact.wood', { door: 'd_geld' }, { vol: 0.8 }],
        [6.5, 'tension', 0.2],
      ] },
    ],
  }),
  // ------------------------------------------------------------------------------------------------ 9 climax 1
  M({
    id: 'm12_geldraum', order: 9, phase: 'climax', title: 'Geldraum Alarm',
    box: [0.5, 4.2, 0.5, 8.5, 7, 8.5], vols: null, when: [['breach', 'd_geld']], tension: 0.5,
    brief: ['Die Tür gibt nach: Sirene und Blitzlicht der Einbruchmeldeanlage, danach Notlicht im OG.',
      'e13 ergibt sich – oder es ist ein Köder. Die Schlafecke und der Leitstand werden wach.'],
    common: [
      [0, 'sound', 'og_alarm', 'machine.alarm', [4.5, 7, 4.5], { loop: true, vol: 1 }],
      [0.1, 'strobe', 'og', 16, 2.2, 0.12],
      [1.2, 'radio', 'Zentrale', 'Einbruchmeldeanlage Hafenstraße ausgelöst. S9-17, Lage?'],
    ],
    persist: [[0, 'light', 'og', 0.12, 0]],
    variants: [
      { id: 'aufgabe', note: 'e13 ergibt sich; e11/e12 und e14 kommen', tl: [
        [0.6, 'stage', ['e13'], 'surrender', {}],
        [0.8, 'sound', '-', 'voice.plead', 'e13'],
        [2.5, 'stage', '@schlaf', 'investigate', { pos: [7.5, 4.5, 10] }],
        [3, 'stage', ['e14'], 'investigate', { pos: [22.5, 4.5, 10] }],
        [18, 'stop', 'og_alarm', 0.2],
      ] },
      { id: 'koeder', note: 'e13 hebt die Hände – und zieht, wenn man nah ist oder wegschaut', tl: [
        [0.6, 'stage', ['e13'], 'surrender', { bait: true }],
        [0.8, 'sound', '-', 'voice.plead', 'e13'],
        [1, 'until', ['any', ['near', 'e13', 3], ['away', 'e13', 0.3], ['dead', ['e13']]], 15],
        [0.2, 'ambush', ['e13']],
        [0.5, 'alert', ['e11', 'e12', 'e14'], 'player'],
        [16, 'stop', 'og_alarm', 0.2],
      ] },
      { id: 'feuer', w: 0.7, note: 'e13 schießt sofort', tl: [
        [0.4, 'ambush', ['e13']],
        [1.5, 'alert', ['e11', 'e12', 'e14'], 'player'],
        [20, 'stop', 'og_alarm', 0.2],
      ] },
    ],
  }),
  // ------------------------------------------------------------------------------------------------ 10 tension
  M({
    id: 'm13_steg', order: 10, phase: 'tension', title: 'Laufsteg',
    box: [34, -1, 2.6, 70, 4, 9], vols: [[34, -1, 2.6, 70, 4, 9], [34, 4.2, 0, 70, 7, 1.6]], actors: ['e14'], tension: 0.15,
    brief: ['Über (oder unter) dem Spieler fällt auf dem Gitterrost ein Magazin. Schritte entfernen sich.'],
    variants: [
      { id: 'magazin', note: 'Magazin klappert, Schritte, e14 sucht', tl: [
        [0, 'sound', '-', 'weapon.pistol.mag', { catwalk: -5 }, { vol: 0.9 }],
        [0.5, 'steps', 'step.metal', { catwalk: -5 }, { catwalk: -14 }, 5, 0.34],
        [2.5, 'stage', ['e14'], 'investigate', { pos: 'player' }], [2.5, 'tension', 0.2],
      ] },
      { id: 'schritte', note: 'Fehlalarm: nur Schritte auf dem Gitter', tl: [
        [0, 'steps', 'step.metal', { catwalk: 4 }, { catwalk: -8 }, 6, 0.4],
        [3, 'tension', 0.12],
      ] },
      { id: 'nachladen', note: 'Magazin, Schlitten – e14 lädt nach und kommt', tl: [
        [0, 'sound', '-', 'weapon.pistol.mag', { catwalk: -6 }, { vol: 0.9 }],
        [0.6, 'sound', '-', 'weapon.pistol.slide', { catwalk: -6 }, { vol: 0.8 }],
        [1, 'alert', ['e14'], 'player'],
      ] },
    ],
  }),
  // ------------------------------------------------------------------------------------------------ 11 escalation
  M({
    id: 'm06_foerderband', order: 11, phase: 'escalation', title: 'Förderband startet',
    box: [72.1, -1, 22, 83.9, 4, 30], vols: [[72.1, -1, 22, 83.9, 4, 30], [72.1, -1, 12, 83.9, 4, 22], [72.1, -1, 30, 83.9, 4, 46]], tension: 0.25,
    brief: ['Die Anlage erwacht: Förderschleife, AKL-Band, Regalbediengerät. Der Lärm verdeckt Schritte – auch die von e18.',
      'Der Sorter wirft einen Karton aus, er platzt: weißes Pulver.'],
    variants: [
      { id: 'anlauf', note: 'alles läuft an, Karton platzt, e18 kommt im Lärm', tl: [
        [0, 'sound', '-', 'foley.switch', [78, 3, 4]],
        [0.4, 'machine', 'conveyor', 'c_loop', 'start'], [0.6, 'machine', 'conveyor', 'c_akl', 'start'],
        [0.8, 'machine', 'crane', 'rbg1', 'start'], [0.5, 'tension', 0.2],
        [[3, 1], 'fx', 'powder', [80.35, 0.8, 24]], [3, 'sound', '-', 'impact.cardboard', [80.35, 0.6, 24]],
        [[6, 2], 'ambush', ['e18']],
      ], persist: [[0, 'machine', 'conveyor', 'c_loop', 'start'], [0, 'machine', 'conveyor', 'c_akl', 'start'], [0, 'machine', 'crane', 'rbg1', 'start']] },
      { id: 'hupe', note: 'Warnhupe, dann Anlauf; e18 alarmiert', tl: [
        [0, 'sound', '-', 'machine.alarm', [78, 4, 20], { vol: 0.6 }],
        [2.5, 'machine', 'conveyor', 'c_loop', 'start'], [3, 'machine', 'crane', 'rbg1', 'start'],
        [7, 'alert', ['e18'], 'player'],
      ], persist: [[0, 'machine', 'conveyor', 'c_loop', 'start'], [0, 'machine', 'crane', 'rbg1', 'start']] },
      { id: 'fehlstart', w: 0.8, note: 'Band läuft an und stoppt wieder – Stille danach; Pulver', tl: [
        [0, 'machine', 'conveyor', 'c_loop', 'start'],
        [[4, 1], 'fx', 'powder', [80.35, 0.8, 24]], [4, 'sound', '-', 'impact.cardboard', [80.35, 0.6, 24]],
        [[5.5, 1.5], 'machine', 'conveyor', 'c_loop', 'stop'],
        [5.6, 'sound', '-', 'machine.pneumatic', [77, 1, 26]],
        [6, 'tension', 0.15],
      ] },
    ],
  }),
  // ------------------------------------------------------------------------------------------------ 12 contact
  M({
    id: 'm09_roboter', order: 12, phase: 'contact', title: 'Roboter',
    box: [89, -1, 47, 92.5, 4, 49.5], vols: [[89, -1, 47, 92.5, 4, 49.5], [85, -1, 34.1, 89, 4, 37]], tension: 0.2,
    brief: ['Der Palettierroboter schwenkt unerwartet an; e19 nutzt den Moment. Variante: der Roboter bleibt still.'],
    variants: [
      { id: 'schwenk', note: 'Roboter schwenkt sofort, e19 feuert aus der Zelle', tl: [
        [0, 'machine', 'robot', 'roboter1', 'start'], [0, 'sound', '-', 'machine.pneumatic', [90, 1.5, 41]],
        [0.2, 'tension', 0.2], [[0.9, 0.4], 'ambush', ['e19']],
      ], persist: [[0, 'machine', 'robot', 'roboter1', 'start']] },
      { id: 'zelle', note: 'erst in/vor der Zelle läuft er an; e19 wartet', tl: [
        [0, 'until', ['any', ['near', [90, 0, 41], 5.5], ['look', [90, 1.2, 41], 0.92, 14]], 40],
        [0, 'machine', 'robot', 'roboter1', 'start'],
        [1.5, 'until', ['any', ['near', 'e19', 5], ['look', 'e19', 0.95, 12], ['dead', ['e19']]], 30],
        [0.2, 'ambush', ['e19']],
      ], persist: [[0, 'machine', 'robot', 'roboter1', 'start']] },
      { id: 'still', w: 0.7, note: 'nur Druckluft und ein Servo-Zucken; e19 wartet', tl: [
        [0, 'sound', '-', 'machine.pneumatic', [90, 1.5, 41]],
        [2, 'sound', '-', 'machine.servo', [90, 1.5, 41]],
        [2.5, 'until', ['any', ['near', 'e19', 6], ['dead', ['e19']]], 35],
        [0.4, 'ambush', ['e19']],
      ] },
    ],
  }),
  // ------------------------------------------------------------------------------------------------ 13 dread → contact
  M({
    id: 'm10_kuehl', order: 13, phase: 'dread', title: 'Kühlraum',
    box: [84, -1, 55.5, 86.3, 4, 58], vols: [[81, -1, 52, 86, 4, 62]], tension: 0.2,
    brief: ['Die Kühlraumtür gleitet auf, Kältenebel, der Kompressor brummt. e22 wartet zwischen den Paletten.'],
    variants: [
      { id: 'nebel', note: 'Tür öffnet sich von selbst, Nebel, Licht flackert', tl: [
        [0, 'sound', '-', 'machine.pneumatic', { door: 'd_kuehl' }],
        [0.2, 'door', 'd_kuehl', 'open', 0.3], [0.4, 'fx', 'fog', { door: 'd_kuehl' }],
        [0.5, 'light', 'kuehl', 0.3, 2, 1],
        [1, 'sound', 'kuehl_kompressor', 'loop.fridge', [91, 1.5, 57], { loop: true, vol: 0.9 }],
        [2, 'until', ['any', ['near', 'e22', 6], ['look', 'e22', 0.95, 10], ['dead', ['e22']]], 45],
        [0.3, 'ambush', ['e22']],
      ], persist: [[0, 'door', 'd_kuehl', 'open'], [0, 'light', 'kuehl', 0.3, 0]] },
      { id: 'klopfen', note: 'Klopfen von innen; öffnet der Spieler, kommt e22 heraus', tl: [
        [0, 'sound', '-', 'impact.sheetmetal', { door: 'd_kuehl' }], [1.1, 'sound', '-', 'impact.sheetmetal', { door: 'd_kuehl' }],
        [1.9, 'sound', '-', 'impact.sheetmetal', { door: 'd_kuehl' }],
        [2.5, 'until', ['doorOpen', 'd_kuehl'], 60],
        [0, 'fx', 'fog', { door: 'd_kuehl' }],
        [0.5, 'door', 'd_kuehl', 'open', 0.8],
        [0.6, 'ambush', ['e22']],
      ], persist: [[0, 'door', 'd_kuehl', 'open']] },
      { id: 'dunkel', note: 'Kühlraum dunkel, Tür auf, nur Nebel und Taschenlampe', tl: [
        [0, 'light', 'kuehl', 0, 0.2],
        [0.2, 'door', 'd_kuehl', 'open', 0.25], [0.5, 'fx', 'fog', { door: 'd_kuehl' }],
        [1, 'until', ['any', ['near', 'e22', 5], ['dead', ['e22']]], 45],
        [0.2, 'ambush', ['e22']],
      ], persist: [[0, 'door', 'd_kuehl', 'open'], [0, 'light', 'kuehl', 0, 0]] },
    ],
  }),
  // ------------------------------------------------------------------------------------------------ 14 climax 2
  M({
    id: 'm14_verladung', order: 14, phase: 'climax', title: 'Letzte Stellung Verladung',
    box: [74, -1, 58, 84, 4, 63.5], vols: [[74, -1, 58, 84, 4, 63.5], [72.1, -1, 48, 86, 4, 58]],
    pre: { afterAny: ['m09_roboter', 'm10_kuehl', 'm06_foerderband'], orTime: 600 }, tension: 0.4,
    brief: ['Funk: das Fahrzeug steht Nordseite. Tor 4 fährt auf – Gegenlicht – die Verbliebenen sammeln sich an den Docks.',
      'Variante: ein Verwundeter am Boden als Köder; oder Tor 5 wird zugezogen.'],
    common: [[0, 'radio', 'Zentrale', 'Ihr Fahrzeug steht an der Nordseite. Verstärkung in fünf Minuten.']],
    variants: [
      { id: 'tor4', note: 'Tor 4 fährt auf, Gegenlicht, Gruppe sammelt sich', tl: [
        [2, 'door', 'd_dock4', 'open', 0.16], [2.5, 'tension', 0.3],
        [4, 'alertNear', [78, 0, 58], 45, 5],
      ], persist: [[0, 'door', 'd_dock4', 'open']] },
      { id: 'verwundet', note: 'e21 liegt verwundet und fleht – nah heran, dann feuern e22/e19', tl: [
        [1, 'stage', ['e21'], 'wounded', { bait: true }],
        [1, 'sound', '-', 'voice.dying', 'e21'],
        [1.5, 'until', ['any', ['near', 'e21', 3.5], ['dead', ['e21']]], 30],
        [0.4, 'alertNear', [80, 0, 56], 40, 4],
        [0.4, 'ambush', ['e22', 'e19']],
        [2, 'door', 'd_dock4', 'open', 0.2],
      ], persist: [[0, 'door', 'd_dock4', 'open']] },
      { id: 'tor5', note: 'Tor 5 wird von außen zugezogen, dann Sammeln', tl: [
        [1.5, 'sound', '-', 'door.roller.rattle', { door: 'd_dock5' }],
        [2, 'door', 'd_dock5', 'locked', 0.6], [2.5, 'tension', 0.3],
        [3, 'alertNear', [80, 0, 58], 50, 5],
        [6, 'door', 'd_dock4', 'open', 0.16],
      ], persist: [[0, 'door', 'd_dock5', 'locked'], [0, 'door', 'd_dock4', 'open']] },
    ],
  }),
];

// Extraction: always ends the mission (debrief). Arriving before the control room was reached = "abgebrochen".
export const EXTRACTION = {
  id: 'extract', box: [72, -1, -13, 82, 4, -4], zone: 'nord', name: 'Einsatzwagen Nordseite',
  beats: ['Spieler erreicht den Einsatzwagen → Einsatz beendet, nüchterne Auswertung.'],
};

// Objectives (one faint OSD line). `done` = condition (cond.js); the current objective is the first not done.
export const OBJECTIVES = [
  { id: 'o_we', text: 'Wareneingang sichern', done: ['any', ['dead', ['@we']], ['zone', ['packerei', 'labor', 'sozial', 'lager_w', 'treppe_w', 'tunnel', 'technik', 'keller_treppe_h', ...HALL_ZONES]]] },
  { id: 'o_leit', text: 'Leitstand OG erreichen', done: ['zone', ['leitstand']] },
  { id: 'o_doku', text: 'Bargeld und Ware dokumentieren', count: 'evidence', done: ['any', ['evidence', 3], ['zone', AUTO_ZONES]] },
  { id: 'o_fz', text: 'Zum Fahrzeug Nordseite' },
];
export const EARLY_EXIT_UNLESS = 'o_leit';

// Optional evidence: stand within r and look at it for dwellTime seconds (bodycam documents it).
export const EVIDENCE = [
  { id: 'ev_ware', name: 'Ware Packerei', pos: [12, 1.0, 29.5], r: 3.4, dwellTime: 1.1, zone: 'packerei' },
  { id: 'ev_labor', name: 'Labor', pos: [3, 1.0, 4.5], r: 3.6, dwellTime: 1.1, zone: 'labor' },
  { id: 'ev_waffen', name: 'Waffenkisten', pos: [23.4, 1.0, 10.5], r: 3.0, dwellTime: 1.1, zone: 'lager_w' },
  { id: 'ev_geld', name: 'Bargeld', pos: [4.5, 5.5, 4.5], r: 3.4, dwellTime: 1.1, zone: 'geld' },
];

// Breachable locked doors: `kicks` uses within `window` s, or `lockShots` hits on the door.
export const BREACH = { d_geld: { kicks: 2, window: 6, lockShots: 2, rattle: 'impact.wood' } };

// Single checkpoint: the first time the player stands in the racking hall after the dock door moment.
// Why one, here: the yard → goods-in → packing opening (~3–4 min) is the most scripted part and loses its
// effect on repeats; after it, the run is 8–11 min of hall/mezzanine/automation that stays a continuous whole.
export const CHECKPOINT = { name: 'Halle', after: 'm02_tor_faellt', zones: HALL_ZONES };

// Ambient pacing (src/director/pacing.js): spots [x, y, z, cueSet], one-shot cues only (no loops).
export const AMBIENT = {
  firstDelay: [50, 80], interval: [38, 75], maxTension: 0.32, quietAfterContact: 40, quietAfterMoment: 25,
  cues: {
    hall: ['voice.distant.shout', 'impact.metal', 'machine.forklift.start', 'weapon.casing', 'voice.cough', 'door.slam'],
    office: ['door.close', 'voice.cough', 'foley.lightswitch', 'impact.wood', 'door.open'],
    basement: ['machine.pneumatic', 'impact.metal', 'voice.cough', 'foley.switch'],
    auto: ['machine.sorter.clack', 'machine.pneumatic', 'machine.servo', 'impact.metal'],
    yard: ['door.slam', 'voice.distant.shout', 'machine.forklift.start'],
  },
  spots: [
    [14, 1.2, 50, 'hall'], [22, 1.2, 40, 'hall'], [10, 1.2, 20, 'office'], [5, 1.2, 6, 'office'], [16, 1.2, 6, 'office'],
    [25, 1.2, 6, 'office'], [6, 5.5, 18, 'office'], [13, 5.5, 4, 'office'], [23, 5.5, 4, 'office'],
    [6, -2.5, 46, 'basement'], [21, -2.5, 47.6, 'basement'],
    [50, 1.2, 3, 'hall'], [39.3, 1.2, 15, 'hall'], [60.9, 1.2, 40, 'hall'], [44.7, 1.2, 45, 'hall'], [66.3, 1.2, 20, 'hall'],
    [45, 1.2, 60, 'hall'], [55, 5, 0.8, 'hall'],
    [78, 1.2, 12, 'auto'], [76, 1.2, 40, 'auto'], [90, 2, 20, 'auto'], [90, 1.2, 42, 'auto'], [78, 1.2, 58, 'auto'], [91, 1.2, 57, 'basement'],
    [30, 1.2, 80, 'yard'], [80, 1.2, 80, 'yard'], [-8, 1.2, 30, 'yard'], [104, 1.2, 20, 'yard'],
  ],
  // masking: zone → [[machine kind, id, level]] while that machine runs
  masking: {
    auto_n: [['conveyor', 'c_loop', 0.8], ['crane', 'rbg1', 0.3]], auto_s: [['conveyor', 'c_loop', 0.9]],
    buehne: [['conveyor', 'c_loop', 0.6]], akl: [['crane', 'rbg1', 0.6], ['conveyor', 'c_akl', 0.5]],
    roboter: [['robot', 'roboter1', 0.6], ['conveyor', 'c_akl', 0.3]], versand: [['conveyor', 'c_loop', 0.3], ['robot', 'roboter1', 0.25]],
  },
};

// Machine state the director sets at every mission start so moments can wake them (A's defaults may run them).
export const MISSION_START = [[0, 'machine', 'crane', 'rbg1', 'stop']];
