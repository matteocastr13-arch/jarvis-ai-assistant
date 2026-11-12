/**
 * Unified interface for audio recorders across all platforms
 */
export interface IAudioRecorder {
  readonly recording: boolean;
  start(onAudioLevel?: (level: number) => void, onChunk?: (buf: Buffer) => void): Promise<void>;
  stop(): Buffer | null;
  cleanup?(): void;
  emergencyStop?(): void;
  getAllChunks?(): Buffer[];
  getLatestChunks?(fromIndex?: number): Buffer[];
  getChunkCount?(): number;
}
