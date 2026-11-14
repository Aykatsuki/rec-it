// AudioWorklet running the acompressor port for one clip's sound (ADR-042).
import { Compressor, type CompressorSettings } from './compressor';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  constructor(options?: { processorOptions?: unknown });
}
declare function registerProcessor(name: string, processor: unknown): void;

class CompressorProcessor extends AudioWorkletProcessor {
  private readonly compressor: Compressor;
  constructor(options: { processorOptions: CompressorSettings }) {
    super(options);
    this.compressor = new Compressor(options.processorOptions, sampleRate);
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    const n = output[0]?.length ?? 0;
    // No input yet (before the clip starts): silence, and the detector stays at rest.
    if (!input.length) {
      for (const ch of output) ch.fill(0);
      return true;
    }
    for (let c = 0; c < output.length; c++) output[c]!.set(input[Math.min(c, input.length - 1)]!);
    this.compressor.process(output, n);
    return true;
  }
}

registerProcessor('recit-compressor', CompressorProcessor);
