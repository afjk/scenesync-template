import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { deepStrictEqual, equal, match, ok } from 'node:assert/strict';
import JSZip from 'jszip';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'publish-submissions.mjs');
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADggGAbLIEyAAAAABJRU5ErkJggg==',
  'base64'
);

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function createTempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scenesync-template-test-'));
  await writeJson(path.join(dir, 'docs/worlds.json'), {
    schemaVersion: 1,
    updatedAt: null,
    worlds: [],
  });
  await fs.mkdir(path.join(dir, 'submissions'), { recursive: true });
  return dir;
}

async function createExistingWorld(root, slug, overrides = {}) {
  const versionId = overrides.versionId || `${slug}-v1`;
  const updatedAt = overrides.updatedAt || '2026-06-13T00:00:00.000Z';
  const record = {
    schemaVersion: 1,
    slug,
    title: overrides.title || `${slug} title`,
    description: overrides.description || `${slug} description`,
    tags: overrides.tags || [`${slug}-tag`],
    updatedAt,
    versionId,
    path: `worlds/${slug}/`,
    versionPath: `worlds/${slug}/versions/${versionId}/`,
    thumbnail: overrides.thumbnail || null,
    objectCount: overrides.objectCount || 1,
    assetCount: overrides.assetCount || 0,
    zipSize: overrides.zipSize || 123,
    expandedSize: overrides.expandedSize || 456,
    zipSha256: overrides.zipSha256 || `${slug}hash`,
    warnings: overrides.warnings || [],
  };

  const catalog = await readJson(path.join(root, 'docs/worlds.json'));
  catalog.updatedAt = updatedAt;
  catalog.worlds = [...(catalog.worlds || []), record];
  await writeJson(path.join(root, 'docs/worlds.json'), catalog);
  await writeJson(path.join(root, `docs/worlds/${slug}/current.json`), {
    schemaVersion: 1,
    slug,
    title: record.title,
    description: record.description,
    tags: record.tags,
    versionId,
    versionPath: `versions/${versionId}/`,
    updatedAt,
    zipSha256: record.zipSha256,
  });
  await fs.mkdir(path.join(root, `docs/worlds/${slug}/versions/${versionId}`), { recursive: true });
  return record;
}

async function createSceneZip() {
  const zip = new JSZip();
  zip.file('index.html', '<!doctype html><title>Scene</title>');
  zip.file('scene.json', JSON.stringify({
    format: 'scene-sync-export-scene',
    version: 2,
    objects: [
      {
        id: 'box-1',
        name: 'Box',
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        asset: { type: 'primitive', primitive: 'box' },
      },
    ],
  }));
  zip.file('manifest.json', JSON.stringify({
    schemaVersion: 1,
    assets: [],
  }));
  return await zip.generateAsync({ type: 'nodebuffer' });
}

async function runPublisher(root, { prBody = '' } = {}) {
  return await execFileAsync(
    process.execPath,
    [SCRIPT_PATH, '--remove-submissions'],
    {
      cwd: root,
      env: {
        ...process.env,
        PR_BODY: prBody,
      },
      maxBuffer: 1024 * 1024 * 10,
    }
  );
}

async function listSubmissionFiles(root) {
  const submissionsDir = path.join(root, 'submissions');
  const entries = await fs.readdir(submissionsDir, { recursive: true }).catch(() => []);
  return entries.filter((entry) => !String(entry).endsWith('.DS_Store'));
}

test('updates metadata without a new ZIP', async () => {
  const root = await createTempProject();
  await createExistingWorld(root, 'sample');
  await fs.writeFile(path.join(root, 'submissions/sample.md'), [
    '# Updated Sample',
    '',
    'Updated description.',
    '',
    'Tags: alpha, beta',
  ].join('\n'));

  await runPublisher(root);

  const catalog = await readJson(path.join(root, 'docs/worlds.json'));
  const world = catalog.worlds.find((entry) => entry.slug === 'sample');
  equal(world.title, 'Updated Sample');
  equal(world.description, 'Updated description.');
  deepStrictEqual(world.tags, ['alpha', 'beta']);
  const current = await readJson(path.join(root, 'docs/worlds/sample/current.json'));
  equal(current.title, 'Updated Sample');
  deepStrictEqual(await listSubmissionFiles(root), []);
});

test('updates thumbnail without a new ZIP', async () => {
  const root = await createTempProject();
  await createExistingWorld(root, 'sample', {
    warnings: ['No thumbnail image found'],
  });
  await fs.writeFile(path.join(root, 'submissions/sample.png'), PNG_BYTES);

  await runPublisher(root);

  const catalog = await readJson(path.join(root, 'docs/worlds.json'));
  const world = catalog.worlds.find((entry) => entry.slug === 'sample');
  match(world.thumbnail, /^worlds\/sample\/thumbnail-[a-f0-9]{8}\.png$/);
  deepStrictEqual(world.warnings, []);
  await fs.access(path.join(root, 'docs', world.thumbnail));
  const current = await readJson(path.join(root, 'docs/worlds/sample/current.json'));
  equal(current.thumbnail, world.thumbnail);
});

test('publishes a ZIP and applies matching thumbnail/metadata patch in the same run', async () => {
  const root = await createTempProject();
  await fs.writeFile(path.join(root, 'submissions/new-room.zip'), await createSceneZip());
  await fs.writeFile(path.join(root, 'submissions/new-room.png'), PNG_BYTES);
  await fs.writeFile(path.join(root, 'submissions/new-room.md'), [
    '# New Room Title',
    '',
    'New room description.',
    '',
    'Tags: new, room',
  ].join('\n'));

  await runPublisher(root);

  const catalog = await readJson(path.join(root, 'docs/worlds.json'));
  const world = catalog.worlds.find((entry) => entry.slug === 'new-room');
  equal(world.title, 'New Room Title');
  equal(world.description, 'New room description.');
  deepStrictEqual(world.tags, ['new', 'room']);
  match(world.thumbnail, /^worlds\/new-room\/thumbnail-[a-f0-9]{8}\.png$/);
  ok(world.versionId);
  await fs.access(path.join(root, `docs/worlds/new-room/versions/${world.versionId}/scene.json`));
  deepStrictEqual(await listSubmissionFiles(root), []);
});

test('does not apply PR body metadata when a PR targets multiple slugs', async () => {
  const root = await createTempProject();
  await createExistingWorld(root, 'alpha', { title: 'Old Alpha', tags: ['old-alpha'] });
  await createExistingWorld(root, 'beta', { title: 'Old Beta', tags: ['old-beta'] });
  await fs.writeFile(path.join(root, 'submissions/alpha.md'), [
    '# Alpha Local',
    '',
    'Alpha local description.',
  ].join('\n'));
  await fs.writeFile(path.join(root, 'submissions/beta.md'), [
    '# Beta Local',
    '',
    'Beta local description.',
  ].join('\n'));

  await runPublisher(root, {
    prBody: [
      'Title: Shared Title',
      'Description: Shared description',
      'Tags: shared',
    ].join('\n'),
  });

  const catalog = await readJson(path.join(root, 'docs/worlds.json'));
  const alpha = catalog.worlds.find((entry) => entry.slug === 'alpha');
  const beta = catalog.worlds.find((entry) => entry.slug === 'beta');
  equal(alpha.title, 'Alpha Local');
  equal(alpha.description, 'Alpha local description.');
  deepStrictEqual(alpha.tags, ['old-alpha']);
  equal(beta.title, 'Beta Local');
  equal(beta.description, 'Beta local description.');
  deepStrictEqual(beta.tags, ['old-beta']);
});

test('does not create a summary when no submission files are present', async () => {
  const root = await createTempProject();

  const { stdout } = await runPublisher(root);

  match(stdout, /No submission files were found/);
  await fs.access(path.join(root, '.publish-summary.md'))
    .then(() => { throw new Error('summary should not exist'); })
    .catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
});
