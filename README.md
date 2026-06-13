# Scene Sync Templates

Scene Sync Export ZIP files are published here as playable GitHub Pages worlds.

## Enable GitHub Pages

Repository Settings -> Pages -> Build and deployment -> Source: GitHub Actions

## Publish a World

Create a pull request that adds one or more ZIP files under `submissions/`.

```txt
submissions/
  my-room.zip
```

That is the only required input. The `Publish Scene Sync submission` workflow
validates each ZIP, expands it as-is into `docs/worlds/<slug>/versions/<version>/`,
updates `docs/worlds.json`, updates `current.json`, removes the submitted ZIP
from the PR, and commits the generated files back to the same PR branch.

The slug is derived from the ZIP filename:

```txt
submissions/my-room.zip -> worlds/my-room/
```

Optional PR body metadata can override the generated values:

```md
Title: Neon Gallery
Description: A sample gallery made with Scene Sync.
Tags: gallery, glb, image
Slug: neon-gallery
```

`Slug:` is only honored when the PR targets a single inferred slug.

## Update Metadata or Thumbnail

To update an existing world without uploading a new Export ZIP, create a pull
request that adds files under `submissions/` with the existing world slug.

```txt
submissions/
  my-room.png
  my-room.md
```

Supported thumbnail extensions are `.png`, `.jpg`, `.jpeg`, and `.webp`.
The publisher copies the image to `docs/worlds/<slug>/thumbnail-<hash>.<ext>`,
updates `worlds.json`, and removes the submitted image from the PR.

The Markdown file is optional and can contain:

```md
# My Room

Short description shown on the template list.

Tags: sample, room, glb
```

`Title:`, `Description:`, `Tags:`, and `Slug:` lines in the PR body are only
honored when the PR targets a single inferred slug. PR body values override the
Markdown file when both are present.

## Generated Layout

```txt
docs/
  index.html
  worlds.json
  worlds/
    <slug>/
      index.html
      current.json
      versions/
        <versionId>/
          index.html
          scene.json
          manifest.json
          assets/
          viewer/
```

The ZIP contents are preserved inside each version directory so that exported
viewer/runtime compatibility remains tied to the export that produced it.

## Validation

The publisher rejects:

- ZIPs without root-level `scene.json`
- invalid Scene Sync Export scene documents
- unsafe ZIP paths such as absolute paths or `..`
- any single file over 100 MiB
- duplicate slugs in the same PR
- metadata/thumbnail updates for a slug that does not exist yet
- multiple metadata or thumbnail files for the same slug

The publisher warns about:

- files over 50 MiB
- ZIPs over 100 MiB
- expanded contents over 250 MiB
- more than 1000 files
- missing thumbnails

## Local Check

```sh
npm ci
npm run check
npm run publish:submissions
```
