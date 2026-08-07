import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
} from './vendor/mediabunny/mediabunny.min.mjs';

function toPositivePixels(value) {
  const pixels = Math.floor(Number(value) || 0);
  return pixels > 0 ? pixels : 0;
}

export async function transformMp4(buffer, {
  padLeftPx = 0,
  onProgress = null,
} = {}) {
  const pad = toPositivePixels(padLeftPx);
  if (pad <= 0) {
    throw new Error('padLeftPx must be a positive number');
  }

  const sourceBytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const input = new Input({
    source: new BlobSource(new Blob([sourceBytes], { type: 'video/mp4' })),
    formats: ALL_FORMATS,
  });
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });

  let conversion = null;
  let operationFailed = false;
  let inputWidth = 0;
  let inputHeight = 0;
  let outputWidth = 0;
  let outputHeight = 0;

  try {
    const firstTimestamp = await input.getFirstTimestamp();

    conversion = await Conversion.init({
      input,
      output,
      tracks: 'all',
      trim: { start: Number.isFinite(firstTimestamp) ? firstTimestamp : 0 },
      video: async (track) => {
        inputWidth = await track.getDisplayWidth();
        inputHeight = await track.getDisplayHeight();
        outputWidth = inputWidth + pad;
        outputHeight = inputHeight;

        if (outputWidth <= 0 || outputHeight <= 0) {
          throw new Error(`invalid transformed size: ${outputWidth}x${outputHeight}`);
        }

        const canvas = new OffscreenCanvas(outputWidth, outputHeight);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) {
          throw new Error('2D canvas unavailable');
        }

        return {
          codec: 'avc',
          forceTranscode: true,
          hardwareAcceleration: 'prefer-hardware',
          allowRotationMetadata: false,
          processedWidth: outputWidth,
          processedHeight: outputHeight,
          process(sample) {
            context.fillStyle = '#000';
            context.fillRect(0, 0, outputWidth, outputHeight);
            sample.draw(context, pad, 0, inputWidth, inputHeight);
            return canvas;
          },
        };
      },
      audio: {},
      showWarnings: false,
    });

    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((entry) => entry.reason).join(', ');
      throw new Error(`unsupported media conversion${reasons ? `: ${reasons}` : ''}`);
    }
    if (typeof onProgress === 'function') {
      conversion.onProgress = onProgress;
    }

    await conversion.execute();
    if (!target.buffer) {
      throw new Error('media conversion returned no output');
    }

    return {
      bytes: new Uint8Array(target.buffer),
      inputWidth,
      inputHeight,
      outputWidth,
      outputHeight,
    };
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    let cleanupError = null;
    try {
      if (!conversion || conversion.state === 'canceled') {
        await output.cancel();
      } else {
        await conversion.cancel();
      }
    } catch (error) {
      cleanupError = error;
    }

    try {
      input.dispose();
    } catch (error) {
      cleanupError ??= error;
    }

    if (cleanupError && !operationFailed) {
      throw cleanupError;
    }
  }
}
