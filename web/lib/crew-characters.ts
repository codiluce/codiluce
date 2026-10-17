/** Original 12 × 14 pixel bodies. The pose engine and all props remain shared. */
export interface CharacterSprite { rows: string[]; colors: Record<string, string>; hand: [number, number] }
const palette = (body: string, light: string): Record<string, string> => ({ B: body, L: light, D: '#263346', W: '#f0f4f6', C: '#f6cf65' });
const sprite = (body: string, light: string, rows: string[]): CharacterSprite => ({ rows, colors: palette(body, light), hand: [11, 8] });
export const CHARACTERS: Record<string, CharacterSprite> = {
  'terminal-cube': sprite('#5d6961', '#c4d3b8', [
    '............', '..LLLLLLLL..', '.LBBBBBBBBL.', '.BDDDDDDDDB.', '.BDWDDDDDDB.', '.BDDWDDDDDB.', '.BDWDDWWDDB.', '.BDDDDDDDDB.', '.BBBBBBBBBB.', '..BBLBBLBB..', '..BBBBBBBB..', '...BB..BB...', '...DD..DD...', '............',
  ]),
  'round-builder': sprite('#d46aa3', '#f5beda', [
    '....LLLL....', '..LLBBBBLL..', '.LBBBBBBBBL.', '.BBBBBBBBBB.', '.BBWWWWWWBB.', '.BBDWDDWDBB.', '.BBDWDDWDBB.', '.BBDWDDWDBB.', '.BBBBBBBBBB.', '..BLLBBLLB..', '..BBBBBBBB..', '...BB..BB...', '...DD..DD...', '............',
  ]),
  'pointer-scout': sprite('#728196', '#c9d3e2', [
    '..W.........', '..WW........', '..WLW.......', '..WLLW......', '..WLLLW.....', '..WLLLLW....', '..WWWWWWW...', '..WBBW......', '..BBWBBW....', '..BBBBBBBB..', '..BBLLBBBB..', '...BB..BB...', '...DD..DD...', '............',
  ]),
  'visor-pilot': sprite('#7867d7', '#c5b8ff', [
    '...LLLLLL...', '..LBBBBBBL..', '.BBBDDDDBBB.', '.BDDWDDWDDB.', 'BBWWWDDWWWBB', 'BBWWWDDWWWBB', '.BDDDDDDDDB.', '..BBBBBBBB..', '.BBLLBBLLBB.', '..BBBBBBBB..', '..BBBBBBBB..', '...BB..BB...', '...DD..DD...', '............',
  ]),
  'twin-star': sprite('#527de0', '#afccff', [
    '..C......L..', '.CCC....LLL.', 'CCCCC..LLLLL', '.CCC....LLL.', '..C.BBBB.L..', '..BBBBBBBB..', '.BDWWDDWWDB.', '.BBBBBBBBBB.', '..BLLBBLLB..', '..BBBBBBBB..', '..BBBBBBBB..', '...BB..BB...', '...DD..DD...', '............',
  ]),
  'notebook-courier': sprite('#d29644', '#ffe0a3', [
    '...LLLLLL...', '..BBBBBBBB..', '..BDWWDWDB..', '..BBBBBBBB..', '.DLLLLLLLLB.', '.DLWLLLLLLB.', '.DLLLLLLLLB.', '.DLWWWWLLLB.', '.DLLLLLLLLB.', '.DLWWWWLLLB.', '..BBBBBBBB..', '...BB..BB...', '...DD..DD...', '............',
  ]),
  'orbit-mechanic': sprite('#a16eda', '#dfc1ff', [
    '..CCCCCCCC..', '.C........C.', '..CCCCCCCC..', '...BBBBBB...', '..BBBBBBBB..', '.BDWWDDWWDB.', '.BDDDDDDDDB.', '..BBBBBBBB..', '.BLLBBBBLLB.', '..BBBBBBBB..', '...BBBBBB...', '..B......B..', '...DD..DD...', '............',
  ]),
  'wave-courier': sprite('#37a99c', '#a4f0df', [
    '......LLL...', '....LLBBLL..', '...LBBBBL...', '..LBBBBBL...', '.LBBBBBBBLL.', '.BDWWDDWWDB.', '.BBBBBBBBBB.', '.BLLBBBBLLB.', '..BBBBBBBB..', '..BBBBBBBB..', '..BBBBBBBB..', '...BB..BB...', '...DD..DD...', '............',
  ]),
  'claw-scout': sprite('#dd6258', '#ffb9a1', [
    '.L........L.', 'LBB......BBL', 'LBBL....LBBL', '.BB..LL..BB.', '..BBBBBBBB..', '..BDWWDWDB..', '.BBBBBBBBBB.', '..BLLBBLLB..', '..BBBBBBBB..', '.BBBLLLLBBB.', '..BBBBBBBB..', '...BB..BB...', '...DD..DD...', '............',
  ]),
  'winged-courier': sprite('#bd9055', '#ffe1aa', [
    'L..........L', '.LL..CC..LL.', '..LLBBBBLL..', '..BBBBBBBB..', '.BBWWDDWWBB.', '.BDDDDDDDDB.', '..BBBBBBBB..', 'W.BBBBBBBB.W', 'WWBLLBBLLBWW', '.WBBBBBBBBW.', '..BBBBBBBB..', '...BB..BB...', '...DD..DD...', '............',
  ]),
};
