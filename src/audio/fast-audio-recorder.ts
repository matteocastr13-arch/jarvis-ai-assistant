import { Logger } from '../core/logger';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { IAudioRecorder } from './audio-recorder.interface';
import { AudioDeviceDetector } from './audio-device-detector';

/**
 * Cross-platform audio recorder using FFmpeg (DirectShow on Windows, AVFoundation on macOS, PulseAudio on Linux)
 */
export class FastAudioRecorder implements IAudioRecorder {
  private recordingProcess: any = null;
  private isRecording = false;
  private audioChunks: Buffer[] = [];
  private recordingStartTime = 0;
  private onAudioLevel?: (level: number) => void;
  private onChunk?: (buf: Buffer) => void;

  /**
   * Resolve FFmpeg binary across platforms (bundled or system PATH)
   */
  private resolveFfmpegBinary(): string {
    const isWindows = process.platform === 'win32';
    const binaryName = isWindows ? 'ffmpeg.exe' : 'ffmpeg';

    const candidates = [
      path.join(process.resourcesPath || __dirname, binaryName),
      path.join(process.cwd(), 'assets', binaryName),
      path.join(process.cwd(), 'node_modules', 'ffmpeg-static', binaryName),
      isWindows ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : null,
      process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : null,
      process.platform === 'darwin' ? '/usr/local/bin/ffmpeg' : null,
      'ffmpeg'
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      try {
        const isAbsolute = path.isAbsolute(candidate);
        if (isAbsolute && !fs.existsSync(candidate)) {
          continue;
        }

        const probe = spawnSync(candidate, ['-version'], {
          encoding: 'utf8',
          timeout: 4000,
          shell: !isAbsolute && isWindows
        });

        if (probe.status === 0) {
          Logger.debug(`✅ [FastAudio] Discovered working ffmpeg: ${candidate}`);
          return candidate;
        }
      } catch (err) {
        // Try next candidate
      }
    }

    throw new Error(`FFmpeg executable not found. Please install ffmpeg or add it to system PATH (${process.platform})`);
  }

  /**
   * Build capture arguments according to the host platform
   */
  private getCaptureArgs(ffmpegPath: string): string[] {
    if (process.platform === 'win32') {
      const inputDevice = AudioDeviceDetector.getDefaultInputDevice(ffmpegPath) || 'virtual-audio-capturer';
      Logger.debug(`🎤 [FastAudio] Windows DirectShow recording using device: "${inputDevice}"`);
      return [
        '-f', 'dshow',
        '-i', `audio=${inputDevice}`,
        '-ar', '16000',
        '-ac', '1',
        '-f', 'wav',
        '-loglevel', 'info',
        'pipe:1'
      ];
    }

    if (process.platform === 'darwin') {
      return [
        '-f', 'avfoundation',
        '-i', ':0',
        '-ar', '16000',
        '-ac', '1',
        '-f', 'wav',
        '-loglevel', 'info',
        'pipe:1'
      ];
    }

    // Linux fallback (PulseAudio)
    return [
      '-f', 'pulse',
      '-i', 'default',
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      '-loglevel', 'info',
      'pipe:1'
    ];
  }

  async start(onAudioLevel?: (level: number) => void, onChunk?: (buf: Buffer) => void): Promise<void> {
    if (this.isRecording) return;

    try {
      this.isRecording = true;
      this.recordingStartTime = Date.now();
      this.audioChunks = [];
      this.onAudioLevel = onAudioLevel;
      this.onChunk = onChunk;

      Logger.debug(`🎤 Starting audio recording (platform: ${process.platform})...`);

      await this.startRecording();

      Logger.debug('✅ Audio recording started successfully');
    } catch (error) {
      Logger.error('❌ Failed to start audio recording:', error);
      this.isRecording = false;
      throw error;
    }
  }

  private async startRecording(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const ffmpegPath = this.resolveFfmpegBinary();
        const args = this.getCaptureArgs(ffmpegPath);

        Logger.debug(`🎤 [FastAudio] Spawning FFmpeg with args: ${args.join(' ')}`);
        this.recordingProcess = spawn(ffmpegPath, args, {
          windowsHide: true
        });

        const stderrChunks: string[] = [];

        this.recordingProcess.stdout.on('data', (data: Buffer) => {
          this.audioChunks.push(data);

          if (this.onChunk) {
            try {
              this.onChunk(data);
            } catch (chunkError) {
              // Never let consumer sink errors break capture
            }
          }

          if (this.onAudioLevel) {
            const level = this.calculateAudioLevel(data);
            this.onAudioLevel(level);
          }
        });

        this.recordingProcess.stderr.on('data', (data: Buffer) => {
          const output = data.toString();
          stderrChunks.push(output);
          if (output.toLowerCase().includes('error') || output.toLowerCase().includes('fail')) {
            Logger.warning(`⚠️ [FastAudio] FFmpeg stderr: ${output.trim()}`);
          }
        });

        this.recordingProcess.on('error', (err: Error) => {
          Logger.error('❌ [FastAudio] Recording process error:', err);
          this.isRecording = false;
          reject(err);
        });

        this.recordingProcess.on('spawn', () => {
          Logger.debug('✅ [FastAudio] Recording process spawned successfully');
        });

        this.recordingProcess.on('exit', (code: number) => {
          if (code !== 0 && code !== null && this.isRecording) {
            const errorOutput = stderrChunks.join('\n');
            Logger.error(`❌ [FastAudio] FFmpeg exited with code ${code}. Stderr: ${errorOutput}`);
            this.isRecording = false;
          }
        });

        // Verification timeout to confirm audio stream is flowing
        setTimeout(() => {
          if (this.recordingProcess && !this.recordingProcess.killed) {
            if (this.audioChunks.length > 0) {
              Logger.debug('✅ [FastAudio] Recording confirmed active (audio chunks flowing)');
              resolve();
            } else {
              Logger.error('❌ [FastAudio] Process running but no audio chunks received within timeout');
              this.emergencyStop();
              reject(new Error('FFmpeg started but produced no audio chunks'));
            }
          } else {
            Logger.error('❌ [FastAudio] Recording process failed to start within timeout');
            reject(new Error('Recording process failed to start'));
          }
        }, 2000);

      } catch (error) {
        Logger.error('❌ Error in startRecording:', error);
        reject(error);
      }
    });
  }

  stop(): Buffer | null {
    if (!this.isRecording) return null;

    try {
      if (this.recordingProcess) {
        this.recordingProcess.kill('SIGTERM');
        this.recordingProcess = null;
      }

      this.isRecording = false;

      const totalSize = this.audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const audioBuffer = Buffer.concat(this.audioChunks, totalSize);
      this.audioChunks = [];

      const duration = Date.now() - this.recordingStartTime;
      Logger.debug(`🎵 Audio captured: ${audioBuffer.length} bytes (${duration}ms)`);

      return audioBuffer;
    } catch (error) {
      Logger.error('❌ Error stopping recording:', error);
      return null;
    }
  }

  get recording(): boolean {
    return this.isRecording;
  }

  cleanup(): void {
    if (this.isRecording && this.recordingProcess) {
      try {
        this.recordingProcess.kill('SIGKILL');
      } catch (e) {
        // Ignore kill error during cleanup
      }
    }
    this.isRecording = false;
    this.recordingProcess = null;
    this.audioChunks = [];
    this.recordingStartTime = 0;
    this.onAudioLevel = undefined;
    this.onChunk = undefined;
  }

  emergencyStop(): void {
    try {
      this.recordingProcess?.kill('SIGKILL');
    } catch (e) {
      // Ignore
    }
    this.cleanup();
  }

  getAllChunks(): Buffer[] {
    return [...this.audioChunks];
  }

  getLatestChunks(fromIndex: number = 0): Buffer[] {
    if (!this.isRecording || fromIndex < 0) return [];
    return this.audioChunks.slice(fromIndex);
  }

  getChunkCount(): number {
    return this.audioChunks.length;
  }

  private calculateAudioLevel(chunk: Buffer): number {
    let sum = 0;
    for (let i = 0; i < chunk.length; i += 2) {
      if (i + 1 < chunk.length) {
        const sample = chunk.readInt16LE(i);
        sum += sample * sample;
      }
    }
    const rms = Math.sqrt(sum / Math.max(1, chunk.length / 2));
    return Math.min(100, (rms / 32768) * 100);
  }
}
