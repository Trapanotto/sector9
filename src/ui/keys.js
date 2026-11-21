// German key names for the controls panel (KeyboardEvent.code → label). Owner: F.
const NAMES = {
  ArrowUp: 'Pfeil ↑', ArrowDown: 'Pfeil ↓', ArrowLeft: 'Pfeil ←', ArrowRight: 'Pfeil →',
  ShiftLeft: 'Umschalt links', ShiftRight: 'Umschalt rechts', ControlLeft: 'Strg links', ControlRight: 'Strg rechts',
  AltLeft: 'Alt', AltRight: 'Alt Gr', Space: 'Leertaste', Enter: 'Eingabe', Backspace: 'Rücktaste', Tab: 'Tab',
  Delete: 'Entf', Insert: 'Einfg', PageUp: 'Bild ↑', PageDown: 'Bild ↓', Home: 'Pos1', End: 'Ende', Escape: 'Esc',
  Backquote: '^', CapsLock: 'Feststell', Minus: 'ß', Equal: '´', BracketLeft: 'Ü', BracketRight: '+', Semicolon: 'Ö',
  Quote: 'Ä', Backslash: '#', Comma: ',', Period: '.', Slash: '-', IntlBackslash: '<', KeyY: 'Z', KeyZ: 'Y',
  NumpadEnter: 'Num Eingabe', NumpadAdd: 'Num +', NumpadSubtract: 'Num −', NumpadMultiply: 'Num ×', NumpadDivide: 'Num ÷',
  NumpadDecimal: 'Num ,',
};
/** label for a code on a German (QWERTZ) layout: event.code is the US position, so Y/Z are swapped */
export function keyName(code) {
  if (!code) return '–';
  if (NAMES[code]) return NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}
