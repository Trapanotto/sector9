// Pistol ammunition logic (pure; unit-tested in scripts/test-c-player.mjs).
// One round in the chamber + a 15-round magazine. Spare magazines are tracked individually: a partially
// emptied magazine is RETAINED (back into the pouch) on a reload, an empty one is dropped. The slide locks back
// when the last round is fired; an empty-gun reload releases the slide and chambers a round.
export const MAG_CAP = 15;

export function createAmmo(spares = [MAG_CAP, MAG_CAP, MAG_CAP, MAG_CAP]) {
  return { cap: MAG_CAP, chamber: 1, mag: MAG_CAP, spares: spares.slice(), slideLocked: false, dropped: 0, fired: 0 };
}
export function resetAmmo(a, spares = [MAG_CAP, MAG_CAP, MAG_CAP, MAG_CAP]) {
  a.chamber = 1; a.mag = a.cap; a.spares.length = 0; for (const s of spares) a.spares.push(s);
  a.slideLocked = false; a.dropped = 0; a.fired = 0;
  return a;
}
/** rounds in the gun (chamber + magazine) */
export const inGun = (a) => a.chamber + a.mag;
/** rounds in spare magazines */
export function reserve(a) { let n = 0; for (let i = 0; i < a.spares.length; i++) n += a.spares[i]; return n; }

/** trigger pull: 'fired' (slide cycles; locks back after the last round) | 'locked' (slide back, no click) | 'click' */
export function pull(a) {
  if (a.slideLocked) return 'locked';
  if (!a.chamber) return 'click';
  a.chamber = 0; a.fired++;
  if (a.mag > 0) { a.mag--; a.chamber = 1; } else a.slideLocked = true;
  return 'fired';
}
function bestSpare(a) {
  let bi = -1;
  for (let i = 0; i < a.spares.length; i++) if (bi < 0 || a.spares[i] > a.spares[bi]) bi = i;
  return bi;
}
/** a reload makes sense: some spare holds more than the current magazine (or the gun is empty) */
export function canReload(a) {
  const bi = bestSpare(a);
  if (bi < 0 || a.spares[bi] <= 0) return false;
  return a.spares[bi] > a.mag || (!a.chamber && a.mag === 0);
}
/** 'empty' (slide locked / nothing chambered: slide must be released) or 'tactical' (round stays chambered) */
export const reloadKind = (a) => (a.slideLocked || !a.chamber ? 'empty' : 'tactical');
/** magazine change (at the moment the new magazine seats): old one retained if it still holds rounds */
export function swapMag(a) {
  const bi = bestSpare(a);
  if (bi < 0) return false;
  const n = a.spares[bi];
  a.spares.splice(bi, 1);
  if (a.mag > 0) a.spares.push(a.mag); else a.dropped++;
  a.mag = n;
  return true;
}
/** slide release (empty reload): chamber a round from the magazine */
export function releaseSlide(a) {
  a.slideLocked = false;
  if (!a.chamber && a.mag > 0) { a.mag--; a.chamber = 1; }
}
