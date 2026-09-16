const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE_URL = 'https://catalog.yec.uz';
const TYPE_URL = `${BASE_URL}/type/kover/`;
const STATIC_FILTER = '?filter=static';

const rootDir = path.join(__dirname, '..', '..');
const collectionsDir = path.join(rootDir, 'front', 'public', 'images', 'collections');
const manifestPath = path.join(collectionsDir, 'manifest.json');

const mergeRules = {
  'touch-blue': { slug: 'touch', name: 'Touch' },
  'touch-gold': { slug: 'touch', name: 'Touch' },
  'new-luna': { slug: 'luna', name: 'Luna' },
  'luna': { slug: 'luna', name: 'Luna' },
  'trio': { slug: 'trio', name: 'Trio' },
  'trio-white': { slug: 'trio', name: 'Trio' },
};

const allowedExts = ['.jpg', '.jpeg', '.png', '.webp'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchHtml = (url) =>
  new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString();
          resolve(fetchHtml(nextUrl));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });

const downloadFile = (url, dest) =>
  new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).toString();
          resolve(downloadFile(nextUrl, dest));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        const fileStream = fs.createWriteStream(dest);
        res.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(resolve));
        fileStream.on('error', reject);
      })
      .on('error', reject);
  });

const withRetry = async (fn, attempts = 3, label = '') => {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const wait = 800 * (i + 1);
      if (label) {
        console.warn(`Retry ${i + 1}/${attempts} failed for ${label}: ${error.message || error}`);
      }
      await sleep(wait);
    }
  }
  throw lastError;
};

const parseCollections = (html) => {
  const regex = /<a href="\/collection\/([^/]+)\/" class="adi">([^<]+)<\/a>\s*<div class="ozellik">Yarn Type:\s*([^<]+)<\/div>/g;
  const results = [];
  let match;
  while ((match = regex.exec(html))) {
    results.push({
      slug: match[1].trim(),
      name: match[2].trim(),
      yarn: match[3].trim(),
    });
  }
  return results;
};

const parseImageLinks = (html) => {
  const regex = /href="(\/media\/photos\/collections\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi;
  const links = new Set();
  let match;
  while ((match = regex.exec(html))) {
    links.add(match[1]);
  }
  return Array.from(links);
};

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const findExistingFile = (dir, code) => {
  for (const ext of allowedExts) {
    const candidate = path.join(dir, `${code}${ext}`);
    if (fs.existsSync(candidate)) return `${code}${ext}`;
  }
  return null;
};

const mapTarget = (slug, name) => {
  const key = slug.toLowerCase();
  if (key.includes('tuft') || name.toLowerCase().includes('tuft')) {
    return null;
  }
  if (mergeRules[key]) return mergeRules[key];
  return { slug: key, name };
};

async function main() {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest topilmadi: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.collections = manifest.collections || [];
  manifest.images = manifest.images || {};
  manifest.materials = manifest.materials || {};

  const typeHtml = await withRetry(() => fetchHtml(TYPE_URL), 5, 'type');
  const collections = parseCollections(typeHtml);

  const materialsByTarget = new Map();

  const targets = collections
    .map((item) => {
      const target = mapTarget(item.slug, item.name);
      if (!target) return null;
      const existing = materialsByTarget.get(target.slug) || new Set();
      if (item.yarn) existing.add(item.yarn);
      materialsByTarget.set(target.slug, existing);
      return { ...item, targetSlug: target.slug, targetName: target.name };
    })
    .filter(Boolean);

  const perTargetImages = new Map();

  for (const item of targets) {
    const collectionUrl = `${BASE_URL}/collection/${item.slug}/${STATIC_FILTER}`;
    let html = '';
    try {
      html = await withRetry(() => fetchHtml(collectionUrl), 5, item.slug);
    } catch (error) {
      console.warn(`Skip ${item.slug}: ${error.message || error}`);
      continue;
    }
    const imageLinks = parseImageLinks(html);
    const list = perTargetImages.get(item.targetSlug) || [];

    for (const link of imageLinks) {
      const fullUrl = `${BASE_URL}${link}`;
      const fileName = path.basename(link);
      const ext = path.extname(fileName).toLowerCase();
      const code = fileName.split('_')[0].replace(ext, '');
      if (!code) continue;

      list.push({ code, ext: ext || '.jpg', url: fullUrl });
    }

    perTargetImages.set(item.targetSlug, list);
  }

  for (const [targetSlug, images] of perTargetImages.entries()) {
    const targetDir = path.join(collectionsDir, targetSlug);
    ensureDir(targetDir);

    if (!manifest.images[targetSlug]) manifest.images[targetSlug] = {};

    const seenCodes = new Set();
    for (const image of images) {
      if (seenCodes.has(image.code)) continue;
      seenCodes.add(image.code);

      const existingFile = findExistingFile(targetDir, image.code);
      const localFileName = existingFile || `${image.code}${image.ext}`;
      const localPath = path.join(targetDir, localFileName);

      if (!existingFile && !fs.existsSync(localPath)) {
        try {
          await withRetry(() => downloadFile(image.url, localPath), 4, image.url);
        } catch (error) {
          console.warn(`Download failed: ${image.url}`);
          continue;
        }
      }

      manifest.images[targetSlug][image.code] = `/images/collections/${targetSlug}/${localFileName}`;
    }
  }

  for (const item of targets) {
    if (!manifest.collections.find((c) => c.slug === item.targetSlug)) {
      manifest.collections.push({ name: item.targetName, slug: item.targetSlug });
    } else {
      manifest.collections = manifest.collections.map((c) =>
        c.slug === item.targetSlug ? { ...c, name: item.targetName } : c,
      );
    }
  }

  for (const [targetSlug, yarnSet] of materialsByTarget.entries()) {
    const yarns = Array.from(yarnSet).filter(Boolean);
    if (yarns.length) {
      manifest.materials[targetSlug] = yarns.length > 1 ? yarns.join(' / ') : yarns[0];
    }
  }

  manifest.generatedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log('Sync tugadi.');
}

main().catch((error) => {
  console.error('Sync xatosi:', error);
  process.exit(1);
});
