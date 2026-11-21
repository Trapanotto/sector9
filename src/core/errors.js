// German error screens: missing WebGL 2, context loss, fatal load errors. Owner: core.
export function webgl2Available() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGL2RenderingContext && c.getContext('webgl2'));
  } catch { return false; }
}

let box = null;
export function showMessage(title, text, { button = null, onButton = null } = {}) {
  if (!box) {
    box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.86);color:#ddd;font:15px/1.5 system-ui,sans-serif';
    document.body.appendChild(box);
  }
  box.innerHTML = '';
  const card = document.createElement('div');
  card.style.cssText = 'max-width:520px;padding:28px 32px;border:1px solid #444;background:#111';
  const h = document.createElement('h2'); h.textContent = title; h.style.cssText = 'margin:0 0 10px;font-size:20px;color:#fff';
  const p = document.createElement('p'); p.textContent = text; p.style.margin = '0';
  card.append(h, p);
  if (button) {
    const b = document.createElement('button');
    b.textContent = button;
    b.style.cssText = 'margin-top:18px;padding:8px 18px;font:inherit;background:#222;color:#fff;border:1px solid #666;cursor:pointer';
    b.onclick = onButton ?? (() => location.reload());
    card.append(b);
  }
  box.append(card);
  box.style.display = 'flex';
}
export function hideMessage() { if (box) box.style.display = 'none'; }

export const MSG = {
  noWebgl2: ['WebGL 2 nicht verfügbar',
    'Dieser Browser oder dieses Gerät unterstützt kein WebGL 2. SECTOR 9 benötigt einen aktuellen Browser (Chrome, Edge, Firefox oder Safari) mit aktivierter Hardwarebeschleunigung.'],
  contextLost: ['Grafikkontext verloren',
    'Die Grafikkarte hat den Kontext zurückgesetzt (Treiber-Neustart oder Speichermangel). Die Darstellung wird wiederhergestellt …'],
  contextGone: ['Grafikkontext nicht wiederhergestellt',
    'Die Grafik konnte nicht automatisch wiederhergestellt werden. Bitte die Seite neu laden.'],
  loadFailed: ['Laden fehlgeschlagen', 'Beim Laden ist ein Fehler aufgetreten: '],
};
