import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(projectRoot, 'node_modules', '@mediapipe', 'tasks-vision');
const cacheDirectory = path.join(projectRoot, '.local', 'vision-assets');
const publicDirectory = path.join(projectRoot, 'apps', 'client', 'public', 'vision');
const modelName = 'blaze_face_short_range.tflite';
const modelUrl = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
const modelSha256 = 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f';
const modelByteLength = 229_746;
const wasmFiles = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

async function assertReadable(filePath, description) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`${description} is missing at ${filePath}. Run npm ci before building.`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readVerifiedModel(filePath) {
  const bytes = await readFile(filePath);
  if (bytes.byteLength !== modelByteLength || sha256(bytes) !== modelSha256) {
    throw new Error(`Face model integrity check failed for ${filePath}.`);
  }
  return bytes;
}

async function acquireModel(cachePath) {
  try {
    return await readVerifiedModel(cachePath);
  } catch (error) {
    if (error instanceof Error && !error.message.includes('ENOENT')) {
      await rm(cachePath, { force: true });
    }
  }

  const suppliedPath = process.env.SCREEVA_FACE_MODEL_PATH;
  let bytes;
  if (suppliedPath) {
    bytes = await readVerifiedModel(path.resolve(suppliedPath));
  } else {
    const response = await fetch(modelUrl, { redirect: 'error' });
    if (!response.ok) throw new Error(`Unable to download the pinned face model (${response.status}).`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength !== modelByteLength || sha256(bytes) !== modelSha256) {
      throw new Error('Downloaded face model failed its pinned size or SHA-256 check.');
    }
  }

  await mkdir(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx' });
    await rename(temporaryPath, cachePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return bytes;
}

await mkdir(path.join(publicDirectory, 'wasm'), { recursive: true });
await mkdir(path.join(publicDirectory, 'models'), { recursive: true });

for (const fileName of wasmFiles) {
  const source = path.join(packageRoot, 'wasm', fileName);
  await assertReadable(source, `MediaPipe runtime asset ${fileName}`);
  await copyFile(source, path.join(publicDirectory, 'wasm', fileName));
}

const model = await acquireModel(path.join(cacheDirectory, modelName));
await writeFile(path.join(publicDirectory, 'models', modelName), model);
console.log(`Prepared local MediaPipe vision assets (${model.byteLength} byte model, SHA-256 ${modelSha256}).`);
