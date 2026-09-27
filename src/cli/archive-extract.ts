/**
 * Shared single-file archive extractors for the portable release-binary
 * installers (dolt-install.ts, beads-install.ts).
 *
 * Both installers download one release archive and need exactly one file out
 * of it (the static CLI binary), so they share these two readers rather than
 * pulling in a tar/zip dependency. Lifted out of dolt-install.ts (where they
 * were module-private) when the beads installer was added (apra-fleet-i9ag.13.1)
 * -- do NOT duplicate them per-installer.
 */
import zlib from 'node:zlib';

/**
 * Finds and returns the raw (decompressed) bytes of a single named file
 * inside a .zip archive buffer. Handles both the STORE (0) and DEFLATE (8)
 * compression methods -- the only two release zips and typical zip
 * fixtures use.
 */
export function extractSingleFileFromZip(buf: Buffer, binaryName: string): Buffer {
  const eocdSig = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === eocdSig) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid zip archive: End Of Central Directory record not found');
  }

  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  let offset = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x02014b50) {
      throw new Error('Invalid zip archive: malformed central directory entry');
    }
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const fileNameLength = buf.readUInt16LE(offset + 28);
    const extraFieldLength = buf.readUInt16LE(offset + 30);
    const fileCommentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const fileName = buf.toString('utf-8', offset + 46, offset + 46 + fileNameLength);

    if (fileName.replace(/\\/g, '/').split('/').pop() === binaryName) {
      const localSig = buf.readUInt32LE(localHeaderOffset);
      if (localSig !== 0x04034b50) {
        throw new Error('Invalid zip archive: malformed local file header');
      }
      const localNameLength = buf.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressedData = buf.subarray(dataStart, dataStart + compressedSize);

      if (compressionMethod === 0) {
        return Buffer.from(compressedData);
      }
      if (compressionMethod === 8) {
        return zlib.inflateRawSync(compressedData);
      }
      throw new Error(`Unsupported zip compression method ${compressionMethod} for entry ${fileName}`);
    }

    offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }

  throw new Error(`Binary "${binaryName}" not found in zip archive`);
}

/**
 * Finds and returns the raw bytes of a single named file inside a gzipped
 * (ustar/POSIX) tar archive buffer.
 */
export function extractSingleFileFromTarGz(buf: Buffer, binaryName: string): Buffer {
  const tarBuf = zlib.gunzipSync(buf);
  let offset = 0;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker block

    const rawName = header.toString('utf-8', 0, 100).replace(/\0.*$/, '');
    const sizeField = header.toString('utf-8', 124, 136).replace(/\0.*$/, '').trim();
    const size = sizeField ? parseInt(sizeField, 8) : 0;
    const typeFlag = header.toString('utf-8', 156, 157);

    const dataStart = offset + 512;
    const paddedSize = Math.ceil(size / 512) * 512;

    // '0' and '\0' both denote a regular file per the tar spec.
    const isRegularFile = typeFlag === '0' || typeFlag === '\0' || typeFlag === '';
    if (isRegularFile && rawName.replace(/\\/g, '/').split('/').pop() === binaryName) {
      return Buffer.from(tarBuf.subarray(dataStart, dataStart + size));
    }

    offset = dataStart + paddedSize;
  }

  throw new Error(`Binary "${binaryName}" not found in tar archive`);
}
