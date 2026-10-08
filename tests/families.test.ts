// Data families without a language model (projection/families.ts): tables
// joined by foreign keys and names, and files placed by the tables they use or
// through the code they use.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectionIndex, type EntityRow, type RelationRow } from '../src/projection/hierarchy.js';
import { dataFamilies, familyName } from '../src/projection/families.js';

/** A small Laravel-like repository: tables with foreign keys, models, services, commands, a page and shared code. */
function repository() {
  const rows: EntityRow[] = [{ id: 'r', type: 'repository', name: 'r' }, { id: 'app', type: 'application', name: 'backend', parentId: 'r' }];
  const relations: RelationRow[] = [];
  let n = 0;
  const relate = (from: string, to: string, type: string) => relations.push({ id: `rel${n++}`, from, to, type });
  const dir = (id: string, path: string, parentId = 'app') => rows.push({ id, type: 'directory', name: path.split('/').at(-1)!, path, parentId });
  /** A file with one class inside (relations from the class count for the file). */
  const file = (id: string, path: string, parentId: string, language = 'php') => { rows.push({ id, type: 'file', name: path.split('/').at(-1)!, path, language, parentId }); rows.push({ id: `${id}#c`, type: 'class', name: id, parentId: id }); return `${id}#c`; };
  const table = (name: string, migrations?: string[]) => rows.push({ id: `t:${name}`, type: 'database_table', name, path: `database/migrations/create_${name}.php`, parentId: 'app', ...(migrations ? { migrations } : {}) });
  // users is referenced by six tables: a hub.
  for (const name of ['users', 'songs', 'song_artists', 'videos', 'lessons', 'cards', 'user_lessons', 'user_settings', 'crm_leads', 'crm_tags', 'tasks', 'task_tags', 'task_task_tag', 'playlists']) table(name);
  for (const name of ['songs', 'videos', 'lessons', 'crm_leads', 'playlists', 'user_lessons']) relate(`t:${name}`, 't:users', 'foreign_key');
  relate('t:song_artists', 't:songs', 'foreign_key');
  relate('t:cards', 't:lessons', 'foreign_key');
  relate('t:user_lessons', 't:lessons', 'foreign_key');
  relate('t:task_task_tag', 't:tasks', 'foreign_key'); relate('t:task_task_tag', 't:task_tags', 'foreign_key');
  dir('models', 'app/Models'); dir('services', 'app/Services'); dir('commands', 'app/Console/Commands'); dir('helpers', 'app/Helpers'); dir('pages', 'resources/js/pages'); dir('migrations', 'database/migrations');
  relate(file('Song', 'app/Models/Song.php', 'models'), 't:songs', 'maps_to');
  relate(file('Video', 'app/Models/Video.php', 'models'), 't:videos', 'maps_to');
  relate(file('User', 'app/Models/User.php', 'models'), 't:users', 'maps_to');
  const songService = file('SongService', 'app/Services/SongService.php', 'services');
  relate(songService, 't:songs', 'writes'); relate(songService, 't:users', 'reads');
  const str = file('Str', 'app/Helpers/Str.php', 'helpers');
  // A command using the service (and the shared helper) follows the service.
  const scrape = file('ScrapeSongs', 'app/Console/Commands/ScrapeSongs.php', 'commands');
  relate(scrape, songService, 'calls'); relate(scrape, str, 'calls');
  rows.push({ id: 'cmd', type: 'command', name: 'songs:scrape', parentId: 'app' }); relate('cmd', scrape, 'handles');
  // Code used by two families stays apart.
  const videoService = file('VideoService', 'app/Services/VideoService.php', 'services'); relate(videoService, 't:videos', 'writes'); relate(videoService, str, 'calls');
  const mixer = file('Mixer', 'app/Services/Mixer.php', 'services'); relate(mixer, songService, 'calls'); relate(mixer, videoService, 'calls');
  // A page requesting an endpoint follows its handler; its style sheet follows the page.
  const page = file('SongsPage', 'resources/js/pages/songs.tsx', 'pages', 'typescript');
  file('SongsStyle', 'resources/js/pages/songs.module.scss', 'pages', 'scss');
  relate('SongsPage', 'SongsStyle', 'imports');
  rows.push({ id: 'ep', type: 'api_endpoint', name: 'GET /songs', routePath: '/songs', method: 'GET', parentId: 'app' });
  relate(page, 'ep', 'requests'); relate('ep', songService, 'handles');
  // A migration changing a table is placed by the table's list of migrations.
  file('AlterVideos', 'database/migrations/add_title_to_videos.php', 'migrations');
  rows.find(row => row.id === 't:videos')!.migrations = ['database/migrations/create_videos.php', 'database/migrations/add_title_to_videos.php'];
  return { rows, relations };
}

test('data families: foreign keys join tables, hubs stand alone, names join their namesake', () => {
  const { rows, relations } = repository();
  const families = dataFamilies(new ProjectionIndex('run', rows, relations, []));
  const tablesOf = (table: string) => families.families.find(family => family.key === families.of.get(`t:${table}`))!;
  assert.deepEqual(tablesOf('users').tables, ['users', 'user_settings'], 'a table named after a hub joins it when nothing else connects it');
  assert.equal(tablesOf('users').hub, true);
  assert.deepEqual(tablesOf('songs').tables, ['songs', 'song_artists']);
  assert.deepEqual([...tablesOf('lessons').tables].sort(), ['cards', 'lessons', 'user_lessons'], 'user_lessons joins lessons, not the users hub');
  assert.notEqual(families.of.get('t:songs'), families.of.get('t:videos'), 'the hub does not join the families referencing it');
  assert.equal(tablesOf('crm_leads').name, 'CRM', 'tables sharing a short prefix are named by it');
  assert.equal(tablesOf('task_task_tag').name, 'Tasks', 'the table others are named after names the family');
  assert.equal(familyName(['word_groups', 'word_group_word']), 'Word groups');
});
test('data families: files follow their tables, then the code they use or that uses them; shared code stays apart', () => {
  const { rows, relations } = repository();
  const families = dataFamilies(new ProjectionIndex('run', rows, relations, []));
  const songs = families.of.get('t:songs');
  assert.equal(families.of.get('Song'), songs, 'a model maps its table');
  assert.equal(families.of.get('SongService'), songs, 'writing a specific table outweighs reading a hub');
  assert.equal(families.of.get('User'), families.of.get('t:users'));
  assert.equal(families.of.get('AlterVideos'), families.of.get('t:videos'), 'a migration changing a table');
  assert.equal(families.of.get('ScrapeSongs'), songs, 'a command follows the service it runs');
  assert.ok(families.inferred.has('ScrapeSongs') && !families.inferred.has('SongService'));
  assert.equal(families.of.get('cmd'), songs, 'the command entity follows its class');
  assert.equal(families.of.get('SongsPage'), songs, 'a page follows the handler of the endpoint it requests');
  assert.equal(families.of.get('SongsStyle'), songs, 'a style sheet follows the only file using it');
  assert.equal(families.of.get('ep'), songs, 'an endpoint follows its handler');
  assert.equal(families.of.get('Mixer'), undefined, 'code using two families equally belongs to neither');
  assert.equal(families.of.get('Str'), undefined, 'a helper whose users disagree belongs to none');
  assert.equal(families.families[0]!.key, songs, 'most files first');
});
