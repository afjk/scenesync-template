#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import JSZip from 'jszip';

const ROOT_DIR = process.cwd();
const DOCS_DIR = path.join(ROOT_DIR, 'docs');
const WORLDS_DIR = path.join(DOCS_DIR, 'worlds');
const SUBMISSIONS_DIR = path.join(ROOT_DIR, 'submissions');
const SUMMARY_PATH = path.join(ROOT_DIR, '.publish-summary.md');

const SCENE_SYNC_EXPORT_FORMAT = 'scene-sync-export-scene';
const CATALOG_SCHEMA_VERSION = 1;
const MIB = 1024 * 1024;
const WARN_SINGLE_FILE_BYTES = 50 * MIB;
const MAX_SINGLE_FILE_BYTES = 100 * MIB;
const WARN_ZIP_BYTES = 100 * MIB;
const WARN_TOTAL_BYTES = 250 * MIB;
const WARN_FILE_COUNT = 1000;
const THUMBNAIL_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const METADATA_EXTENSIONS = new Set(['.md', '.markdown']);
const GENERATED_THUMBNAIL_RE = /^thumbnail-[a-f0-9]{8}\.(png|jpe?g|webp)$/i;

const args = new Set(process.argv.slice(2));
const removeSubmissions = args.has('--remove-submissions');

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function toVersionTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sanitizeSlug(input) {
  const slug = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/\.zip$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug || null;
}

function titleizeSlug(slug) {
  return String(slug || '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseListLine(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePrMetadata() {
  const body = process.env.PR_BODY || '';
  const titleMatch = body.match(/^Title:\s*(.+)$/im);
  const descriptionMatch = body.match(/^Description:\s*(.+)$/im);
  const tagsMatch = body.match(/^Tags:\s*(.+)$/im);
  const slugMatch = body.match(/^Slug:\s*(.+)$/im);

  return {
    slug: slugMatch ? sanitizeSlug(slugMatch[1]) : null,
    title: titleMatch ? titleMatch[1].trim() : '',
    description: descriptionMatch ? descriptionMatch[1].trim() : '',
    tags: tagsMatch ? parseListLine(tagsMatch[1]) : [],
  };
}

function emptyPrMetadata() {
  return {
    slug: null,
    title: '',
    description: '',
    tags: [],
  };
}

function parseMarkdownMetadata(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const descriptionLines = [];
  let title = '';
  let description = '';
  let tags = [];

  for (const line of lines) {
    const titleMatch = line.match(/^Title:\s*(.+)$/i);
    if (titleMatch) {
      title = titleMatch[1].trim();
      continue;
    }

    const descriptionMatch = line.match(/^Description:\s*(.+)$/i);
    if (descriptionMatch) {
      description = descriptionMatch[1].trim();
      continue;
    }

    const tagsMatch = line.match(/^Tags:\s*(.+)$/i);
    if (tagsMatch) {
      tags = parseListLine(tagsMatch[1]);
      continue;
    }

    const headingMatch = line.match(/^#\s+(.+)$/);
    if (headingMatch && !title) {
      title = headingMatch[1].trim();
      continue;
    }

    descriptionLines.push(line);
  }

  if (!description) {
    description = descriptionLines.join('\n').trim();
  }

  return { title, description, tags };
}

function isSupportedImageBuffer(buffer, ext) {
  const normalizedExt = String(ext || '').toLowerCase();
  if (normalizedExt === '.png') {
    return buffer.length >= 8
      && buffer[0] === 0x89
      && buffer[1] === 0x50
      && buffer[2] === 0x4e
      && buffer[3] === 0x47
      && buffer[4] === 0x0d
      && buffer[5] === 0x0a
      && buffer[6] === 0x1a
      && buffer[7] === 0x0a;
  }
  if (normalizedExt === '.jpg' || normalizedExt === '.jpeg') {
    return buffer.length >= 3
      && buffer[0] === 0xff
      && buffer[1] === 0xd8
      && buffer[2] === 0xff;
  }
  if (normalizedExt === '.webp') {
    return buffer.length >= 12
      && buffer.toString('ascii', 0, 4) === 'RIFF'
      && buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidNumberArray(value, minLength) {
  return Array.isArray(value)
    && value.length >= minLength
    && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

function isValidSceneDocument(doc) {
  if (!isPlainObject(doc)) return false;
  if (doc.format !== SCENE_SYNC_EXPORT_FORMAT) return false;
  if (!Number.isInteger(doc.version)) return false;
  if (!Array.isArray(doc.objects)) return false;
  return doc.objects.every((obj) => (
    isPlainObject(obj)
    && typeof obj.id === 'string'
    && isValidNumberArray(obj.position, 3)
    && isValidNumberArray(obj.rotation, 4)
    && isValidNumberArray(obj.scale, 3)
  ));
}

function normalizeZipPath(name) {
  if (typeof name !== 'string') return null;
  if (!name || name.includes('\0') || name.includes('\\')) return null;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!trimmed) return null;
  const parts = trimmed.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return trimmed;
}

function safeJoin(baseDir, relativePath) {
  const target = path.resolve(baseDir, ...relativePath.split('/'));
  const relative = path.relative(baseDir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Unsafe output path: ${relativePath}`);
  }
  return target;
}

async function readJsonFile(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readCatalog() {
  return await readJsonFile(path.join(DOCS_DIR, 'worlds.json'), {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    updatedAt: null,
    worlds: [],
  });
}

async function writeCatalog(catalog) {
  const worlds = Array.isArray(catalog.worlds) ? catalog.worlds : [];
  await writeJsonFile(path.join(DOCS_DIR, 'worlds.json'), {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    updatedAt: catalog.updatedAt || null,
    worlds,
  });
}

async function findSubmissionZips(dir = SUBMISSIONS_DIR) {
  if (!existsSync(dir)) return [];
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findSubmissionZips(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

async function findSubmissionPatchFiles(dir = SUBMISSIONS_DIR) {
  if (!existsSync(dir)) return [];
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findSubmissionPatchFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (THUMBNAIL_EXTENSIONS.has(ext)) {
      results.push({ kind: 'thumbnail', path: fullPath });
    } else if (METADATA_EXTENSIONS.has(ext)) {
      results.push({ kind: 'metadata', path: fullPath });
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function slugFromPatchFile(filePath) {
  const relativePath = path.relative(SUBMISSIONS_DIR, filePath);
  const parts = relativePath.split(path.sep).filter(Boolean);
  const filename = parts[parts.length - 1] || '';
  const basename = path.basename(filename, path.extname(filename));
  const directorySlug = parts.length > 1 ? sanitizeSlug(parts[0]) : null;
  const fileSlug = sanitizeSlug(basename);
  const genericNames = new Set(['thumbnail', 'preview', 'cover', 'metadata', 'details', 'world']);
  if (directorySlug && genericNames.has(String(fileSlug || '').toLowerCase())) {
    return directorySlug;
  }
  return fileSlug;
}

function groupPatchFiles(files) {
  const groups = new Map();
  for (const file of files) {
    const slug = slugFromPatchFile(file.path);
    if (!slug) throw new Error(`Could not derive slug from ${path.relative(ROOT_DIR, file.path)}`);
    const group = groups.get(slug) || { slug, metadataFiles: [], thumbnailFiles: [] };
    if (file.kind === 'metadata') group.metadataFiles.push(file.path);
    if (file.kind === 'thumbnail') group.thumbnailFiles.push(file.path);
    groups.set(slug, group);
  }
  return [...groups.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

function findThumbnailPath(zip) {
  const candidates = [
    'thumbnail.png',
    'thumbnail.jpg',
    'thumbnail.jpeg',
    'thumbnail.webp',
    'preview.png',
    'preview.jpg',
    'preview.jpeg',
    'preview.webp',
    'cover.png',
    'cover.jpg',
    'cover.jpeg',
    'cover.webp',
    'assets/thumbnail.png',
    'assets/preview.png',
    'assets/cover.png',
  ];
  return candidates.find((candidate) => zip.file(candidate)) || null;
}

function collectAssetCount(manifest) {
  if (Array.isArray(manifest?.assets)) return manifest.assets.length;
  if (Array.isArray(manifest?.assetManifest)) return manifest.assetManifest.length;
  return null;
}

async function extractZipAsIs(zip, destinationDir) {
  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.mkdir(destinationDir, { recursive: true });

  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  let totalUncompressedBytes = 0;
  let largest = { path: null, bytes: 0 };

  for (const entry of files) {
    const safeName = normalizeZipPath(entry.name);
    if (!safeName) throw new Error(`Unsafe ZIP entry path: ${entry.name}`);
    const data = await entry.async('nodebuffer');
    totalUncompressedBytes += data.byteLength;
    if (data.byteLength > largest.bytes) largest = { path: safeName, bytes: data.byteLength };
    if (data.byteLength > MAX_SINGLE_FILE_BYTES) {
      throw new Error(`File exceeds 100 MiB limit: ${safeName} (${formatBytes(data.byteLength)})`);
    }
    const target = safeJoin(destinationDir, safeName);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }

  return { fileCount: files.length, totalUncompressedBytes, largest };
}

function buildWorldIndexHtml({ title, versionId }) {
  const safeTitle = String(title || 'Scene Sync World')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const safeVersion = String(versionId || '').replace(/[^A-Za-z0-9_.-]/g, '');

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #101317;
      color: #edf2f7;
      font: 16px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(560px, calc(100% - 32px));
      padding: 24px;
      border: 1px solid #34404d;
      border-radius: 8px;
      background: #181e24;
    }
    a { color: #5cc8ff; }
  </style>
</head>
<body>
  <main>
    <h1>${safeTitle}</h1>
    <p id="status">Opening latest version...</p>
    <p><a id="fallback" href="./versions/${safeVersion}/">Open latest version</a></p>
  </main>
  <script>
    const statusEl = document.getElementById('status');
    const fallbackEl = document.getElementById('fallback');
    const params = new URLSearchParams(location.search);
    const cacheKey = params.get('v') || Date.now();
    fetch('./current.json?v=' + encodeURIComponent(cacheKey), { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then((current) => {
        const versionId = current && current.versionId;
        if (!versionId) throw new Error('current.json does not include versionId');
        const target = './versions/' + encodeURIComponent(versionId) + '/' + location.search + location.hash;
        fallbackEl.href = target;
        location.replace(target);
      })
      .catch((error) => {
        statusEl.textContent = 'Failed to open latest version: ' + error.message;
      });
  </script>
</body>
</html>
`;
}

async function updateCatalog(worldRecord) {
  const catalog = await readCatalog();
  const worlds = Array.isArray(catalog.worlds) ? catalog.worlds : [];
  const nextWorlds = worlds.filter((world) => world.slug !== worldRecord.slug);
  nextWorlds.push(worldRecord);
  nextWorlds.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  await writeCatalog({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    updatedAt: worldRecord.updatedAt,
    worlds: nextWorlds,
  });
}

async function pruneEmptyParents(startDir, stopDir) {
  let current = startDir;
  const stop = path.resolve(stopDir);
  while (path.resolve(current).startsWith(stop) && path.resolve(current) !== stop) {
    const entries = await fs.readdir(current).catch(() => null);
    if (!entries || entries.length > 0) return;
    await fs.rmdir(current);
    current = path.dirname(current);
  }
}

async function publishSubmission(zipPath, { timestamp, prMetadata, allowPrSlugOverride }) {
  const warnings = [];
  const zipBuffer = await fs.readFile(zipPath);
  const zipHash = hashBuffer(zipBuffer);
  const zipSize = zipBuffer.byteLength;
  if (zipSize > WARN_ZIP_BYTES) {
    warnings.push(`ZIP is large: ${formatBytes(zipSize)}`);
  }

  const zip = await JSZip.loadAsync(zipBuffer);
  for (const entry of Object.values(zip.files)) {
    if (!normalizeZipPath(entry.name)) {
      throw new Error(`Unsafe ZIP entry path: ${entry.name}`);
    }
  }

  const sceneEntry = zip.file('scene.json');
  if (!sceneEntry) throw new Error('scene.json was not found at the ZIP root');
  const sceneDocument = JSON.parse(await sceneEntry.async('string'));
  if (!isValidSceneDocument(sceneDocument)) {
    throw new Error('scene.json is not a valid Scene Sync Export document');
  }

  let manifest = null;
  const manifestEntry = zip.file('manifest.json');
  if (manifestEntry) {
    manifest = JSON.parse(await manifestEntry.async('string'));
  } else {
    warnings.push('manifest.json was not found');
  }

  const fileSlug = sanitizeSlug(path.basename(zipPath));
  const slug = allowPrSlugOverride && prMetadata.slug ? prMetadata.slug : fileSlug;
  if (!slug) throw new Error(`Could not derive slug from ${path.basename(zipPath)}`);

  const title = prMetadata.title
    || sceneDocument.title
    || manifest?.title
    || titleizeSlug(slug);
  const description = prMetadata.description
    || sceneDocument.description
    || manifest?.description
    || '';
  const tags = prMetadata.tags.length > 0
    ? prMetadata.tags
    : (Array.isArray(sceneDocument.tags) ? sceneDocument.tags : []);
  const versionId = `${timestamp}-${zipHash.slice(0, 8)}`;
  const worldDir = path.join(WORLDS_DIR, slug);
  const versionDir = path.join(worldDir, 'versions', versionId);

  const extraction = await extractZipAsIs(zip, versionDir);
  if (extraction.fileCount > WARN_FILE_COUNT) {
    warnings.push(`ZIP contains many files: ${extraction.fileCount}`);
  }
  if (extraction.totalUncompressedBytes > WARN_TOTAL_BYTES) {
    warnings.push(`Expanded files are large: ${formatBytes(extraction.totalUncompressedBytes)}`);
  }
  if (extraction.largest.bytes > WARN_SINGLE_FILE_BYTES) {
    warnings.push(`Largest file is ${formatBytes(extraction.largest.bytes)}: ${extraction.largest.path}`);
  }

  const thumbnailPath = findThumbnailPath(zip);
  if (!thumbnailPath) warnings.push('No thumbnail image found');

  const updatedAt = new Date().toISOString();
  const current = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    slug,
    title,
    description,
    tags,
    versionId,
    versionPath: `versions/${versionId}/`,
    updatedAt,
    zipSha256: zipHash,
  };

  await writeJsonFile(path.join(worldDir, 'current.json'), current);
  await fs.writeFile(path.join(worldDir, 'index.html'), buildWorldIndexHtml({ title, versionId }), 'utf8');

  const worldRecord = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    slug,
    title,
    description,
    tags,
    updatedAt,
    versionId,
    path: `worlds/${slug}/`,
    versionPath: `worlds/${slug}/versions/${versionId}/`,
    thumbnail: thumbnailPath ? `worlds/${slug}/versions/${versionId}/${thumbnailPath}` : null,
    objectCount: sceneDocument.objects.length,
    assetCount: collectAssetCount(manifest),
    zipSize,
    expandedSize: extraction.totalUncompressedBytes,
    zipSha256: zipHash,
    warnings,
  };
  await updateCatalog(worldRecord);

  if (removeSubmissions) {
    await fs.unlink(zipPath);
    await pruneEmptyParents(path.dirname(zipPath), SUBMISSIONS_DIR);
  }

  return {
    kind: 'publish',
    slug,
    title,
    versionId,
    objectCount: sceneDocument.objects.length,
    assetCount: collectAssetCount(manifest),
    zipSize,
    expandedSize: extraction.totalUncompressedBytes,
    warnings,
    urlPath: `docs/worlds/${slug}/versions/${versionId}/`,
  };
}

async function removeGeneratedThumbnails(worldDir) {
  const entries = await fs.readdir(worldDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries
    .filter((entry) => entry.isFile() && GENERATED_THUMBNAIL_RE.test(entry.name))
    .map((entry) => fs.unlink(path.join(worldDir, entry.name))));
}

async function readPatchMetadata(metadataFiles) {
  if (metadataFiles.length === 0) return { title: '', description: '', tags: [] };
  if (metadataFiles.length > 1) {
    throw new Error(`Only one metadata file is allowed per slug: ${metadataFiles.map((file) => path.relative(ROOT_DIR, file)).join(', ')}`);
  }
  const text = await fs.readFile(metadataFiles[0], 'utf8');
  return parseMarkdownMetadata(text);
}

async function writePatchThumbnail({ slug, thumbnailFiles, worldDir }) {
  if (thumbnailFiles.length === 0) return null;
  if (thumbnailFiles.length > 1) {
    throw new Error(`Only one thumbnail file is allowed per slug: ${thumbnailFiles.map((file) => path.relative(ROOT_DIR, file)).join(', ')}`);
  }

  const thumbnailPath = thumbnailFiles[0];
  const ext = path.extname(thumbnailPath).toLowerCase();
  if (!THUMBNAIL_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported thumbnail extension: ${path.relative(ROOT_DIR, thumbnailPath)}`);
  }

  const buffer = await fs.readFile(thumbnailPath);
  if (buffer.byteLength > MAX_SINGLE_FILE_BYTES) {
    throw new Error(`Thumbnail exceeds 100 MiB limit: ${path.relative(ROOT_DIR, thumbnailPath)} (${formatBytes(buffer.byteLength)})`);
  }
  if (!isSupportedImageBuffer(buffer, ext)) {
    throw new Error(`Thumbnail does not look like a valid ${ext.slice(1).toUpperCase()} file: ${path.relative(ROOT_DIR, thumbnailPath)}`);
  }

  const hash = hashBuffer(buffer).slice(0, 8);
  const filename = `thumbnail-${hash}${ext}`;
  await removeGeneratedThumbnails(worldDir);
  await fs.writeFile(path.join(worldDir, filename), buffer);
  return {
    hash,
    path: `worlds/${slug}/${filename}`,
    size: buffer.byteLength,
  };
}

function removeResolvedWarnings(warnings, { thumbnail }) {
  const next = Array.isArray(warnings) ? warnings.slice() : [];
  if (!thumbnail) return next;
  return next.filter((warning) => warning !== 'No thumbnail image found');
}

async function applyPatchSubmission(group, { prMetadata, allowPrSlugOverride }) {
  const slug = allowPrSlugOverride && prMetadata.slug ? prMetadata.slug : group.slug;
  const worldDir = path.join(WORLDS_DIR, slug);
  const currentPath = path.join(worldDir, 'current.json');
  const current = await readJsonFile(currentPath, null);
  if (!current) {
    throw new Error(`World does not exist for metadata/thumbnail update: ${slug}`);
  }

  const catalog = await readCatalog();
  const worlds = Array.isArray(catalog.worlds) ? catalog.worlds : [];
  const existingRecord = worlds.find((world) => world.slug === slug);
  if (!existingRecord) {
    throw new Error(`World is missing from docs/worlds.json: ${slug}`);
  }

  const fileMetadata = await readPatchMetadata(group.metadataFiles);
  const thumbnail = await writePatchThumbnail({
    slug,
    thumbnailFiles: group.thumbnailFiles,
    worldDir,
  });

  const title = prMetadata.title || fileMetadata.title || existingRecord.title || current.title || titleizeSlug(slug);
  const description = prMetadata.description || fileMetadata.description || existingRecord.description || current.description || '';
  const tags = prMetadata.tags.length > 0
    ? prMetadata.tags
    : (fileMetadata.tags.length > 0
      ? fileMetadata.tags
      : (Array.isArray(existingRecord.tags) ? existingRecord.tags : []));
  const updatedAt = new Date().toISOString();
  const versionId = current.versionId || existingRecord.versionId;
  if (!versionId) {
    throw new Error(`World is missing current versionId: ${slug}`);
  }

  const nextCurrent = {
    ...current,
    title,
    description,
    tags,
    updatedAt,
  };
  if (thumbnail) nextCurrent.thumbnail = thumbnail.path;

  await writeJsonFile(currentPath, nextCurrent);
  await fs.writeFile(path.join(worldDir, 'index.html'), buildWorldIndexHtml({ title, versionId }), 'utf8');

  const nextRecord = {
    ...existingRecord,
    title,
    description,
    tags,
    updatedAt,
    thumbnail: thumbnail ? thumbnail.path : existingRecord.thumbnail,
    warnings: removeResolvedWarnings(existingRecord.warnings, { thumbnail }),
  };
  await updateCatalog(nextRecord);

  if (removeSubmissions) {
    for (const filePath of [...group.metadataFiles, ...group.thumbnailFiles]) {
      await fs.unlink(filePath);
      await pruneEmptyParents(path.dirname(filePath), SUBMISSIONS_DIR);
    }
  }

  const changed = [];
  if (prMetadata.title || fileMetadata.title) changed.push('title');
  if (prMetadata.description || fileMetadata.description) changed.push('description');
  if (prMetadata.tags.length > 0 || fileMetadata.tags.length > 0) changed.push('tags');
  if (thumbnail) changed.push('thumbnail');

  return {
    kind: 'patch',
    slug,
    title,
    versionId,
    warnings: nextRecord.warnings || [],
    changed,
    thumbnail,
    urlPath: `docs/worlds/${slug}/`,
  };
}

async function writeSummary(results, failures) {
  if (results.length === 0 && failures.length === 0) return;

  const lines = ['# Scene Sync submission publisher', ''];
  for (const result of results) {
    lines.push(`## ${result.title}`);
    lines.push('');
    lines.push(`- action: ${result.kind === 'patch' ? 'updated metadata/thumbnail' : 'published ZIP'}`);
    lines.push(`- slug: \`${result.slug}\``);
    if (result.versionId) lines.push(`- version: \`${result.versionId}\``);
    if (Number.isFinite(result.objectCount)) lines.push(`- objects: ${result.objectCount}`);
    if (result.assetCount !== null && result.assetCount !== undefined) lines.push(`- assets: ${result.assetCount}`);
    if (Number.isFinite(result.zipSize)) lines.push(`- zip size: ${formatBytes(result.zipSize)}`);
    if (Number.isFinite(result.expandedSize)) lines.push(`- expanded size: ${formatBytes(result.expandedSize)}`);
    if (Array.isArray(result.changed) && result.changed.length > 0) {
      lines.push(`- changed: ${result.changed.join(', ')}`);
    }
    if (result.thumbnail) {
      lines.push(`- thumbnail: \`${result.thumbnail.path}\` (${formatBytes(result.thumbnail.size)})`);
    }
    lines.push(`- generated: \`${result.urlPath}\``);
    if (result.warnings.length > 0) {
      lines.push('- warnings:');
      for (const warning of result.warnings) lines.push(`  - ${warning}`);
    }
    lines.push('');
  }
  for (const failure of failures) {
    lines.push(`## Failed: ${failure.file}`);
    lines.push('');
    lines.push(failure.error);
    lines.push('');
  }
  await fs.writeFile(SUMMARY_PATH, `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  await fs.rm(SUMMARY_PATH, { force: true });
  await fs.mkdir(DOCS_DIR, { recursive: true });
  await fs.mkdir(WORLDS_DIR, { recursive: true });
  const zipFiles = await findSubmissionZips();
  const patchFiles = await findSubmissionPatchFiles();
  const timestamp = toVersionTimestamp();
  const prMetadata = parsePrMetadata();
  const failures = [];
  let patchGroups = [];
  try {
    patchGroups = groupPatchFiles(patchFiles);
  } catch (error) {
    failures.push({
      file: 'submissions',
      error: error.stack || error.message,
    });
  }

  const inferredSlugs = new Set([
    ...zipFiles.map((zipPath) => sanitizeSlug(path.basename(zipPath))).filter(Boolean),
    ...patchGroups.map((group) => group.slug).filter(Boolean),
  ]);
  const allowPrMetadataOverride = inferredSlugs.size === 1;
  const scopedPrMetadata = allowPrMetadataOverride ? prMetadata : emptyPrMetadata();
  const seenZipSlugs = new Set();
  const results = [];

  for (const zipPath of zipFiles) {
    try {
      const fileSlug = sanitizeSlug(path.basename(zipPath));
      const slug = allowPrMetadataOverride && scopedPrMetadata.slug ? scopedPrMetadata.slug : fileSlug;
      if (seenZipSlugs.has(slug)) throw new Error(`Duplicate ZIP slug in submissions: ${slug}`);
      seenZipSlugs.add(slug);
      results.push(await publishSubmission(zipPath, {
        timestamp,
        prMetadata: scopedPrMetadata,
        allowPrSlugOverride: allowPrMetadataOverride,
      }));
    } catch (error) {
      failures.push({
        file: path.relative(ROOT_DIR, zipPath),
        error: error.stack || error.message,
      });
    }
  }

  for (const group of patchGroups) {
    try {
      results.push(await applyPatchSubmission(group, {
        prMetadata: scopedPrMetadata,
        allowPrSlugOverride: allowPrMetadataOverride,
      }));
    } catch (error) {
      failures.push({
        file: group.slug,
        error: error.stack || error.message,
      });
    }
  }

  await writeSummary(results, failures);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`Failed to publish ${failure.file}:`);
      console.error(failure.error);
    }
    process.exitCode = 1;
    return;
  }

  for (const result of results) {
    console.log(`${result.kind === 'patch' ? 'Updated' : 'Published'} ${result.slug} ${result.versionId || ''}`.trim());
    for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
  }
  if (results.length === 0) console.log('No submission files were found.');
}

await main();
