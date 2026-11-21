// Browser decode test for the shipped library.
// Serve public/assets/audio (e.g. `python -m http.server 8765 -d public/assets/audio`), open
// http://127.0.0.1:8765/manifest.json in the browser under test and paste this into the console.
// It decodes every manifest file with decodeAudioData and compares the decoded duration.
// Result on 2026-11-21, Chromium 156 (Claude desktop browser pane): 524/524 decoded, 0 duration mismatches.
(async () => {
  const man = await (await fetch('/manifest.json', { cache: 'no-store' })).json();
  const ctx = new OfflineAudioContext(2, 44100, 44100);
  let ok = 0, n = 0, durErr = 0; const fail = [];
  for (const s of Object.values(man.sounds)) {
    for (const v of s.variations) {
      n++;
      try {
        const ab = await ctx.decodeAudioData(await (await fetch('/' + v.file, { cache: 'no-store' })).arrayBuffer());
        const exp = v.duration + (v.loop ? 2 * v.loopStart : 0);
        if (Math.abs(ab.duration - exp) > 0.08) durErr++;
        ok++;
      } catch (e) { fail.push(v.file + ': ' + e); }
    }
  }
  console.log(JSON.stringify({ ua: navigator.userAgent, files: n, decoded: ok, failed: fail, durationMismatch: durErr }));
})();
