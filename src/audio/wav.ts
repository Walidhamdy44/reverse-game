type DataChunk = {
  offset: number;
  size: number;
};

type Pcm16Wav = {
  channels: number;
  dataBytes: number;
  dataChunks: DataChunk[];
  frameCount: number;
  frameSize: number;
  sampleRate: number;
};

const WAV_HEADER_SIZE = 44;
const DEFAULT_WAVEFORM_BARS = 48;
const MAX_WAVEFORM_BARS = 4096;
const UINT32_MAX = 0xffff_ffff;

/**
 * Reverse the order of complete interleaved PCM frames in a 16-bit WAV.
 * Extra RIFF chunks and their required odd-byte padding are skipped safely.
 * Multiple `data` chunks are treated as one continuous stream of frames.
 */
export function reversePcmWav(input: Uint8Array): Uint8Array {
  const wav = parsePcm16Wav(input);
  const riffSize = 36 + wav.dataBytes;

  // A canonical RIFF header stores its total size in an unsigned 32-bit field.
  if (riffSize > UINT32_MAX) {
    throw new Error("WAV audio data is too large for a canonical RIFF file.");
  }

  let output: Uint8Array;
  try {
    output = new Uint8Array(WAV_HEADER_SIZE + wav.dataBytes);
  } catch {
    throw new Error("WAV audio data is too large to process in memory.");
  }

  writeFourCc(output, 0, "RIFF");
  writeUint32(output, 4, riffSize);
  writeFourCc(output, 8, "WAVE");
  writeFourCc(output, 12, "fmt ");
  writeUint32(output, 16, 16);
  writeUint16(output, 20, 1);
  writeUint16(output, 22, wav.channels);
  writeUint32(output, 24, wav.sampleRate);
  writeUint32(output, 28, wav.sampleRate * wav.frameSize);
  writeUint16(output, 32, wav.frameSize);
  writeUint16(output, 34, 16);
  writeFourCc(output, 36, "data");
  writeUint32(output, 40, wav.dataBytes);

  // Chunk payloads form one continuous stream; RIFF padding bytes do not.
  let outputOffset = WAV_HEADER_SIZE;
  for (const chunk of wav.dataChunks) {
    output.set(input.subarray(chunk.offset, chunk.offset + chunk.size), outputOffset);
    outputOffset += chunk.size;
  }

  // Swap whole frames so stereo channels remain paired and each sample's
  // little-endian byte order stays intact.
  let leftFrameOffset = WAV_HEADER_SIZE;
  let rightFrameOffset = WAV_HEADER_SIZE + wav.dataBytes - wav.frameSize;
  while (leftFrameOffset < rightFrameOffset) {
    for (let byteInFrame = 0; byteInFrame < wav.frameSize; byteInFrame += 1) {
      const leftByte = leftFrameOffset + byteInFrame;
      const rightByte = rightFrameOffset + byteInFrame;
      const temporary = output[leftByte];
      output[leftByte] = output[rightByte];
      output[rightByte] = temporary;
    }

    leftFrameOffset += wav.frameSize;
    rightFrameOffset -= wav.frameSize;
  }

  return output;
}

/**
 * Return up to `bars` normalized peak levels from the WAV's PCM samples.
 * The default is 48 bars; requests above 4096 are rejected to bound work.
 * If the clip has fewer frames than requested bars, one bar is returned per frame.
 */
export function getPcmWaveform(input: Uint8Array, bars = DEFAULT_WAVEFORM_BARS): number[] {
  if (!Number.isInteger(bars) || bars < 1 || bars > MAX_WAVEFORM_BARS) {
    throw new Error(`Waveform bar count must be an integer from 1 to ${MAX_WAVEFORM_BARS}.`);
  }

  const wav = parsePcm16Wav(input);
  const barCount = Math.min(bars, wav.frameCount);
  const peaks: number[] = [];

  // Read concatenated data chunks without copying them; a sample may span a
  // chunk boundary, so the byte reader carries across chunk payloads directly.
  let chunkIndex = 0;
  let byteInChunk = 0;
  const nextDataByte = (): number => {
    while (chunkIndex < wav.dataChunks.length) {
      const chunk = wav.dataChunks[chunkIndex];
      if (byteInChunk < chunk.size) {
        const value = input[chunk.offset + byteInChunk];
        byteInChunk += 1;
        return value;
      }

      chunkIndex += 1;
      byteInChunk = 0;
    }

    // The parser has already checked the total frame length; this is a guard
    // against unexpected mutation of a shared input buffer while reading it.
    throw new Error("WAV audio data ended before the declared PCM frames.");
  };

  for (let bar = 0; bar < barCount; bar += 1) {
    const startFrame = Math.floor((bar * wav.frameCount) / barCount);
    const endFrame = Math.floor(((bar + 1) * wav.frameCount) / barCount);
    let peak = 0;

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      for (let channel = 0; channel < wav.channels; channel += 1) {
        const lowByte = nextDataByte();
        const highByte = nextDataByte();
        let sample = lowByte | (highByte << 8);
        if (sample >= 0x8000) sample -= 0x1_0000;
        peak = Math.max(peak, Math.abs(sample));
      }
    }

    peaks.push(Math.max(0, Math.min(1, peak / 32768)));
  }

  return peaks;
}

function parsePcm16Wav(input: Uint8Array): Pcm16Wav {
  if (input.byteLength < 12) {
    throw new Error("WAV header is truncated.");
  }
  if (!hasFourCc(input, 0, "RIFF") || !hasFourCc(input, 8, "WAVE")) {
    throw new Error("Expected a valid RIFF/WAVE file.");
  }

  const riffSize = readUint32(input, 4);
  if (riffSize < 4) {
    throw new Error("RIFF size is smaller than a WAVE header.");
  }

  const riffEnd = 8 + riffSize;
  if (riffEnd > input.byteLength) {
    throw new Error("RIFF size extends past the supplied WAV data.");
  }

  let format: { channels: number; sampleRate: number; frameSize: number } | undefined;
  const dataChunks: DataChunk[] = [];
  let dataBytes = 0;

  for (let chunkHeaderOffset = 12; chunkHeaderOffset < riffEnd; ) {
    if (riffEnd - chunkHeaderOffset < 8) {
      throw new Error("WAV contains a truncated chunk header.");
    }

    const chunkSize = readUint32(input, chunkHeaderOffset + 4);
    const chunkOffset = chunkHeaderOffset + 8;
    if (chunkSize > riffEnd - chunkOffset) {
      throw new Error("WAV chunk size extends past the RIFF boundary.");
    }

    const chunkEnd = chunkOffset + chunkSize;
    const paddedChunkEnd = chunkEnd + (chunkSize % 2);
    if (paddedChunkEnd > riffEnd) {
      throw new Error("WAV chunk is missing its required odd-byte padding.");
    }

    if (hasFourCc(input, chunkHeaderOffset, "fmt ")) {
      if (format !== undefined) {
        throw new Error("WAV contains more than one format chunk.");
      }
      if (chunkSize < 16) {
        throw new Error("PCM format chunk is truncated.");
      }

      const formatTag = readUint16(input, chunkOffset);
      const channels = readUint16(input, chunkOffset + 2);
      const sampleRate = readUint32(input, chunkOffset + 4);
      const byteRate = readUint32(input, chunkOffset + 8);
      const frameSize = readUint16(input, chunkOffset + 12);
      const bitsPerSample = readUint16(input, chunkOffset + 14);

      if (formatTag !== 1) {
        throw new Error("Only integer PCM WAV audio is supported.");
      }
      if (bitsPerSample !== 16) {
        throw new Error("Only 16-bit PCM WAV audio is supported.");
      }
      if (channels < 1) {
        throw new Error("PCM WAV must contain at least one channel.");
      }
      if (sampleRate < 1) {
        throw new Error("PCM WAV must use a positive sample rate.");
      }

      const expectedFrameSize = channels * 2;
      if (frameSize !== expectedFrameSize) {
        throw new Error("PCM WAV block alignment is inconsistent with its channel count.");
      }
      if (byteRate !== sampleRate * expectedFrameSize) {
        throw new Error("PCM WAV byte rate is inconsistent with its sample rate and channels.");
      }

      format = { channels, sampleRate, frameSize };
    } else if (hasFourCc(input, chunkHeaderOffset, "data")) {
      dataChunks.push({ offset: chunkOffset, size: chunkSize });
      dataBytes += chunkSize;
    }

    // RIFF chunks are word-aligned; an odd-sized payload consumes one pad byte.
    chunkHeaderOffset = paddedChunkEnd;
  }

  if (format === undefined) {
    throw new Error("WAV is missing a format chunk.");
  }
  if (dataChunks.length === 0) {
    throw new Error("WAV is missing audio data.");
  }
  if (dataBytes === 0) {
    throw new Error("WAV audio data must not be empty.");
  }
  if (dataBytes % format.frameSize !== 0) {
    throw new Error("WAV audio data contains an incomplete PCM sample frame.");
  }

  return {
    channels: format.channels,
    dataBytes,
    dataChunks,
    frameCount: dataBytes / format.frameSize,
    frameSize: format.frameSize,
    sampleRate: format.sampleRate,
  };
}

function hasFourCc(input: Uint8Array, offset: number, value: string): boolean {
  return (
    input[offset] === value.charCodeAt(0) &&
    input[offset + 1] === value.charCodeAt(1) &&
    input[offset + 2] === value.charCodeAt(2) &&
    input[offset + 3] === value.charCodeAt(3)
  );
}

function readUint16(input: Uint8Array, offset: number): number {
  return input[offset] | (input[offset + 1] << 8);
}

function readUint32(input: Uint8Array, offset: number): number {
  return (
    input[offset] +
    input[offset + 1] * 0x100 +
    input[offset + 2] * 0x1_0000 +
    input[offset + 3] * 0x1_000000
  );
}

function writeFourCc(output: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < 4; index += 1) {
    output[offset + index] = value.charCodeAt(index);
  }
}

function writeUint16(output: Uint8Array, offset: number, value: number): void {
  output[offset] = value & 0xff;
  output[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(output: Uint8Array, offset: number, value: number): void {
  output[offset] = value & 0xff;
  output[offset + 1] = (value >>> 8) & 0xff;
  output[offset + 2] = (value >>> 16) & 0xff;
  output[offset + 3] = (value >>> 24) & 0xff;
}
