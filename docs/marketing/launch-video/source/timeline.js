// The launch film's timeline: scenes for the picture, cues for the sound. 120 BPM: a beat is 0.5 s, a bar 2 s.
var TL = {
  // The sound ends at soundEnd; the end card then holds, silent, to the end of the film.
  fps: 60, duration: 37, soundEnd: 36, bpm: 120,
  scenes: {
    hook: [0, 3], problem: [3, 5.75], stop: [5.75, 6], reveal: [6, 8.5],
    map: [8.5, 11.5], flows: [11.5, 15], pulls: [15, 21], health: [21, 24], agents: [24, 28],
    montage: [28, 32], cta: [32, 37],
  },
  // Where each real-UI clip starts playing (film time); before that it holds its first frame.
  clips: { map: 8.15, wishflow: 11.5, prfocus: 15.0, prtour: 18.0, health: 21.0, agents: 23.85, people: 27.95, deps: 28.95, history: 29.55, plan: 31.05 },
  // The window's address bar names the repository each shot was captured on.
  features: [
    { key: 'map', clip: 'map', repo: 'bookstack', n: '01', eyebrow: 'The map', title: 'See your whole codebase.', sub: 'One map you can zoom, from folders down to functions.' },
    { key: 'flows', clip: 'wishflow', repo: 'storefront', n: '02', eyebrow: 'Flows', title: 'Follow every flow.', sub: 'From the click to the database table, step by step.' },
    { key: 'pulls', repo: 'storefront', n: '03', eyebrow: 'Pull requests', title: 'Review every pull request.',
      beats: [{ at: 15, clip: 'prfocus', sub: 'See what it changes, right on the map.' }, { at: 18, clip: 'prtour', sub: 'Then your agent explains it, in reading order.' }] },
    { key: 'health', clip: 'health', repo: 'bookstack', n: '04', eyebrow: 'Code health', title: 'Find the problem files.', sub: 'Hotspots: complex code that keeps changing.' },
    { key: 'agents', clip: 'agents', repo: 'bookstack', n: '05', eyebrow: 'Agents', title: 'Watch your agents work. Live.', sub: 'Claude Code, Codex, Cursor and more, walking your map.' },
  ],
  montage: [
    { clip: 'people', from: 28, to: 29, label: 'Know who wrote what.' },
    { clip: 'deps', from: 29, to: 30, label: 'Trace what depends on it.' },
    { clip: 'history', from: 30, to: 31, label: 'Replay every commit.' },
    { clip: 'plan', from: 31, to: 32, label: '3D or 2D.' },
  ],
  pr: { number: 2841, files: 41, added: 551, deleted: 13 },
  command: 'npx codiluce@latest start .',
  // Picture moments the sound lands on (film time, seconds).
  cues: {
    hookPanes: [0.0, 0.25, 0.5], hookWords: [0.12, 0.3, 0.48, 0.66, 0.84], hookSwap: 1.5, hookGrid: [1.5, 2.0, 2.5],
    prStamp: 3.0, questions: [3.75, 4.35, 4.95], riserEnd: 5.75, reveal: 6.0, wordmark: 6.4, tagline: 6.95,
    openWhoosh: 8.35, featureCuts: [11.5, 15.0, 21.0, 24.0, 28.0], beatCuts: [18.0],
    clicks: [11.5 + 33 / 60, 15 + 20 / 60, 15 + 63 / 60, 18 + 42 / 60, 21 + 13 / 60, 21 + 31 / 60, 21 + 84 / 60],
    morph: 18 + 42 / 60 + 0.05, agentHops: [24.3, 24.7, 25.1, 26.2, 26.4, 26.75],
    montageCuts: [28.0, 29.0, 30.0, 31.0], peopleClick: 27.95 + 5 / 60, depsTap: 28.95 + 5 / 60, historyStep: 29.55 + 82 / 60, planSnap: 31.05 + 6 / 60,
    sting: 32.0, typeStart: 32.9, typeEnd: 34.05, enter: 34.25, url: 34.5, button: 35.5,
  },
};
if (typeof module !== 'undefined') module.exports = TL;
