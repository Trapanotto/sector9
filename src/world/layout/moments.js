// Staged moments (trigger volumes) and the extraction point. Owner: F (director).
// The core trigger system (src/world/triggers.js) emits 'trigger:enter' / 'trigger:exit' with { id } when the
// player's feet point enters/leaves a box [x0,y0,z0,x1,y1,z1]. The director implements the `beats`; the beats
// below are the binding design brief (ids of doors, circuits, machines and enemies refer to the layout).
//
// World hooks a beat may use (see CONTRACT.md): ctx.world.doors.set(id, state), ctx.world.lights.setCircuit(id,
// level, fadeSeconds), ctx.machines.conveyor(id).start(), ctx.machines.agv(id).dispatch(), ctx.machines.robot(id)
// .start(), ctx.enemies.alert(ids, pos), ctx.audio.playAt(soundId, pos), ctx.events.emit('radio', {...}).

const T = (id, box, title, beats, o = {}) => ({ id, box, title, beats, once: true, ...o });

export const MOMENTS = [
  T('m01_ankunft', [38, -1, 95, 54, 4, 104], 'Ankunft', [
    'Funk: Zentrale bestätigt Einsatzbeginn, Verstärkung in 20 min (Spannung: allein).',
    'Gedämpfte Musik aus dem Wareneingang (Tor 2 offen), Hund bellt in der Ferne.',
    'e02 patrouilliert im Hof; e01 raucht vor Tor 2 (Lichtkegel/Silhouette gegen das helle Tor).',
  ]),
  T('m02_tor_faellt', [10, -1, 57.5, 14, 4, 63.5], 'Tor fällt', [
    'Rolltor d_dock2 rauscht hinter dem Spieler herunter (doors.set("d_dock2","closed"), laut, 1.2 s).',
    'Wareneingang wird dunkler (Tageslicht durch Tor weg: nur Oberlichter) – Blendung → Augen gewöhnen sich (Auto-Belichtung).',
    'e03/e04 alarmiert ("Wer ist da?"), e05 kommt von seiner Runde.',
  ]),
  T('m03_packerei', [8, -1, 35, 14, 4, 38], 'Hinterhalt Packerei', [
    'Radio in der Packerei verstummt abrupt (Stille als Warnung).',
    'e08 springt hinter dem Kartonstapel deckung_pack hervor (Schrotflinte), e06/e07 gehen in Deckung hinter Packtische.',
  ]),
  T('m04_keller_licht', [14.1, -3.8, 46.6, 17, -1, 48.6], 'Stromausfall Keller', [
    'Kellerlicht flackert und fällt aus: lights.setCircuit("keller", 0, 0.4). Nur noch Taschenlampe.',
    'Schweres Atmen / Schritte im Technikraum, e20 wacht auf und schleicht zur Tür d_technik.',
  ]),
  T('m05_halle_dunkel', [28.15, -1, 27.6, 34, 4, 31.4], 'Halle dunkel', [
    'Hallenbeleuchtung fällt aus: lights.setCircuit("halle", 0, 1.5) – nur Oberlichter, tiefe Gänge werden dunkel.',
    'e15/e16 schalten Taschenlampen ein (sichtbar zwischen Regalen), e17 wartet in der Regallücke Gang 3/4 Süd.',
  ]),
  T('m06_foerderband', [72.1, -1, 22, 83.9, 4, 30], 'Förderband startet', [
    'Sorter + Förderschleife c_loop starten schlagartig (machines.conveyor("c_loop").start()), lauter Motoranlauf.',
    'Der Lärm überdeckt Schritte (Audio: Maskierung), e18 kommt aus der Schleife.',
  ]),
  T('m07_agv', [60, -1, 53, 70, 4, 64], 'AGV kreuzt', [
    'AMR agv2 fährt mit Warnton und Blinklicht dicht vor dem Spieler quer (machines.agv("agv2").dispatch()).',
    'Erschrecken, kein Feind – aber e16 hört den Warnton und kommt nachsehen.',
  ]),
  T('m08_schrei', [8, 4.0, 9.1, 14, 7, 11.9], 'Schrei', [
    'Schrei und Schläge hinter der Tür d_geld (Geldzählraum).',
    'Tür ist verriegelt (doors.set("d_geld","locked")) – Spieler muss über den Leitstand/Flur umgehen oder aufbrechen.',
    'e11/e12 in der Schlafecke wachen vom Lärm auf.',
  ]),
  T('m09_roboter', [89, -1, 47, 92.5, 4, 49.5], 'Roboter', [
    'Palettierroboter roboter1 schwenkt unerwartet an (machines.robot("roboter1").start()), Hydraulikzischen.',
    'e19 nutzt die Ablenkung und eröffnet das Feuer aus der Zelle.',
  ]),
  T('m10_kuehl', [84, -1, 55.5, 86.3, 4, 58], 'Kühlraum', [
    'Kühlraumtür d_kuehl gleitet auf, Kältenebel, Kompressor brummt, Licht flackert (circuit kuehl).',
    'e22 wartet zwischen den Paletten.',
  ]),
];

// Extraction: reachable once the director declares the area clear (or at any time = mission end, F decides).
export const EXTRACTION = {
  id: 'extract', box: [72, -1, -13, 82, 4, -4], zone: 'nord', name: 'Einsatzwagen Nordseite',
  beats: ['Funk: "Bereich gesichert?" – Spieler erreicht den Einsatzwagen → Einsatz beendet, Auswertung.'],
};
