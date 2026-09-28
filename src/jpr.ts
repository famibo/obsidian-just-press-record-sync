import { readFile } from 'fs/promises';

// Boxes that contain child boxes rather than raw data
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'meta', 'ilst']);

interface Box {
  type: string;
  path: string;
  start: number;      // offset of the box header in the file
  size: number;       // total size including header
  headerSize: number;
}

function* walk(buf: Buffer, start: number, end: number, parent: string): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {            // 64-bit "largesize"
      size = Number(buf.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {     // box extends to end of parent
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break; // corrupt or truncated

    const box: Box = { type, path: parent ? `${parent}/${type}` : type, start: offset, size, headerSize };
    yield box;

    if (CONTAINERS.has(type)) {
      let childStart = offset + headerSize;
      // ISO-style 'meta' has 4 bytes of version/flags before its children; QuickTime-style does not
      if (type === 'meta' && buf.toString('latin1', childStart + 4, childStart + 8) !== 'hdlr') {
        childStart += 4;
      }
      yield* walk(buf, childStart, offset + size, box.path);
    }
    offset += size;
  }
}

function payload(buf: Buffer, box: Box): Buffer {
  return buf.subarray(box.start + box.headerSize, box.start + box.size);
}

// Extracts the Just Press Record transcript from a JPR2 atom's JSON payload
// (_root.txscriptv2.tx._data, base64-encoded).
function extractJprTranscript(buf: Buffer): string | undefined {
  for (const box of walk(buf, 0, buf.length, '')) {
    if (box.type !== 'JPR2') continue;
    const json = JSON.parse(payload(buf, box).toString('utf8'));
    const data = json?._root?.txscriptv2?.tx?._data;
    if (typeof data === 'string') {
      return Buffer.from(data, 'base64').toString('utf8');
    }
  }
  return undefined;
}

/**
 * Plug your existing extraction code in here.
 * Must return the transcription stored in the M4A metadata, or undefined if none.
 */
export async function extractJprTranscriptFromFile(file: string): Promise<string | undefined> {
  return extractJprTranscript(await readFile(file));
}