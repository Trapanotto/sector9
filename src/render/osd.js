// Bodycam on-screen display (DOM, inside #overlay): timestamp, device id, blinking REC dot.

export const OSD_DEVICE_ID = 'AX-9 CAM 04 · UNIT 7C21';

const pad = (n) => String(n).padStart(2, '0');

export function createOSD(overlay) {
  if (!overlay) return { update() {}, el: null };

  const root = document.createElement('div');
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText = [
    'position:absolute', 'top:2.4vh', 'right:2.2vw', 'text-align:right',
    'font-family:"DejaVu Sans Mono","Consolas","Menlo","Courier New",monospace',
    'font-weight:600', 'font-size:clamp(11px,1.02vw,16px)', 'line-height:1.38',
    'letter-spacing:0.06em', 'color:rgba(244,246,242,0.86)',
    'text-shadow:0 0 1px rgba(0,0,0,0.9),0 1px 3px rgba(0,0,0,0.65),0 0 8px rgba(0,0,0,0.35)',
    'filter:blur(0.25px)', 'white-space:pre', 'user-select:none', 'pointer-events:none',
  ].join(';');

  const line1 = document.createElement('div');
  const dot = document.createElement('span');
  dot.style.cssText = 'display:inline-block;width:0.62em;height:0.62em;border-radius:50%;' +
    'background:#e3241b;box-shadow:0 0 4px rgba(255,40,30,0.8);margin-right:0.45em;vertical-align:0.02em';
  const recLabel = document.createElement('span');
  recLabel.textContent = 'REC';
  recLabel.style.marginRight = '1.1em';
  const stamp = document.createElement('span');
  line1.append(dot, recLabel, stamp);

  const line2 = document.createElement('div');
  line2.textContent = OSD_DEVICE_ID;
  line2.style.opacity = '0.82';

  root.append(line1, line2);
  overlay.appendChild(root);

  let lastSec = -1;
  let lastStandby = null;
  let lastDotOn = null;
  let lastOpacity = '';

  return {
    el: root,
    /** @param {{standby:boolean, glitch:number}} s */
    update(s) {
      const now = new Date();
      const sec = Math.floor(now.getTime() / 1000);
      if (sec !== lastSec) {
        lastSec = sec;
        stamp.textContent =
          `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}  ` +
          `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      }
      if (s.standby !== lastStandby) {
        lastStandby = s.standby;
        recLabel.textContent = s.standby ? 'STBY' : 'REC';
        dot.style.background = s.standby ? '#8a8a86' : '#e3241b';
        dot.style.boxShadow = s.standby ? 'none' : '0 0 4px rgba(255,40,30,0.8)';
      }
      // blink: on for ~0.6 s of every second (steady in standby)
      const dotOn = s.standby ? true : (now.getMilliseconds() < 600);
      if (dotOn !== lastDotOn) { lastDotOn = dotOn; dot.style.visibility = dotOn ? 'visible' : 'hidden'; }
      // signal loss flicker
      let op = '1';
      if (s.glitch > 0.05 && Math.random() < s.glitch * 0.35) op = (0.25 + Math.random() * 0.5).toFixed(2);
      if (op !== lastOpacity) { lastOpacity = op; root.style.opacity = op; }
    },
  };
}
