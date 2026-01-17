export function extractAudioData(
  buffer: ArrayBuffer,
): {
  data: Uint8Array;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
} | null {
  try {
    const view = new DataView(buffer);

    const riff = String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3),
    );
    if (riff !== "RIFF") {
      console.error("Not a valid WAV file - missing RIFF header");
      return null;
    }

    const channels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);

    let offset = 12;
    while (offset < buffer.byteLength - 8) {
      const chunkId = String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3),
      );
      const chunkSize = view.getUint32(offset + 4, true);

      if (chunkId === "data") {
        const dataStart = offset + 8;
        const data = new Uint8Array(buffer, dataStart, chunkSize);
        return { data, sampleRate, channels, bitsPerSample };
      }

      offset += 8 + chunkSize;
      if (chunkSize % 2 === 1) {
        offset += 1;
      }
    }

    console.error("Data chunk not found in WAV file");
    return null;
  } catch (err) {
    console.error("Error parsing WAV file:", err);
    return null;
  }
}

export function mergeWavFiles(buffers: ArrayBuffer[]): ArrayBuffer {
  if (buffers.length === 0) return new ArrayBuffer(0);
  if (buffers.length === 1) return buffers[0];

  const audioDataList: {
    data: Uint8Array;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
  }[] = [];

  for (let i = 0; i < buffers.length; i++) {
    const extracted = extractAudioData(buffers[i]);
    if (!extracted) {
      console.error(`Failed to extract audio data from buffer ${i}`);
      continue;
    }
    audioDataList.push(extracted);
  }

  if (audioDataList.length === 0) {
    console.error("No valid audio data found");
    return new ArrayBuffer(0);
  }

  const { sampleRate, channels, bitsPerSample } = audioDataList[0];

  let totalDataSize = 0;
  for (const audio of audioDataList) {
    totalDataSize += audio.data.length;
  }

  const headerSize = 44;
  const fileSize = headerSize + totalDataSize;
  const outputBuffer = new ArrayBuffer(fileSize);
  const view = new DataView(outputBuffer);
  const outputArray = new Uint8Array(outputBuffer);

  outputArray[0] = 0x52;
  outputArray[1] = 0x49;
  outputArray[2] = 0x46;
  outputArray[3] = 0x46;
  view.setUint32(4, fileSize - 8, true);
  outputArray[8] = 0x57;
  outputArray[9] = 0x41;
  outputArray[10] = 0x56;
  outputArray[11] = 0x45;

  outputArray[12] = 0x66;
  outputArray[13] = 0x6D;
  outputArray[14] = 0x74;
  outputArray[15] = 0x20;
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bitsPerSample / 8, true);
  view.setUint16(32, channels * bitsPerSample / 8, true);
  view.setUint16(34, bitsPerSample, true);

  outputArray[36] = 0x64;
  outputArray[37] = 0x61;
  outputArray[38] = 0x74;
  outputArray[39] = 0x61;
  view.setUint32(40, totalDataSize, true);

  let offset = headerSize;
  for (const audio of audioDataList) {
    outputArray.set(audio.data, offset);
    offset += audio.data.length;
  }

  console.log(
    `Merged ${audioDataList.length} WAV files, total size: ${fileSize} bytes`,
  );
  return outputBuffer;
}
