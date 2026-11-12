import { spawnSync } from 'child_process';
import { Logger } from '../core/logger';

export interface AudioInputDevice {
  name: string;
  alternativeName?: string;
}

/**
 * Detects and manages audio input devices across operating systems (Windows DirectShow, macOS AVFoundation, Linux)
 */
export class AudioDeviceDetector {
  private static cachedDevices: AudioInputDevice[] | null = null;
  private static cachedDefaultDevice: string | null = null;

  /**
   * List DirectShow audio input devices on Windows via ffmpeg
   */
  static getDirectShowAudioDevices(ffmpegPath: string = 'ffmpeg'): AudioInputDevice[] {
    if (this.cachedDevices) {
      return this.cachedDevices;
    }

    try {
      const probe = spawnSync(ffmpegPath, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
        encoding: 'utf8',
        timeout: 5000,
        shell: false
      });

      // FFmpeg outputs device listings to stderr
      const output = (probe.stderr || '') + (probe.stdout || '');
      const devices: AudioInputDevice[] = [];
      let inAudioSection = false;

      const lines = output.split(/\r?\n/);
      for (const line of lines) {
        if (line.includes('DirectShow audio devices')) {
          inAudioSection = true;
          continue;
        }
        if (inAudioSection) {
          // Video section starts after audio or vice versa
          if (line.includes('DirectShow video devices')) {
            break;
          }

          // Parse device line: [dshow @ ...]  "Microphone (Realtek Audio)"
          const match = line.match(/\[dshow[^\]]*\]\s+"([^"]+)"/);
          if (match && !line.includes('Alternative name')) {
            devices.push({ name: match[1] });
          } else if (match && line.includes('Alternative name') && devices.length > 0) {
            devices[devices.length - 1].alternativeName = match[1];
          }
        }
      }

      this.cachedDevices = devices;
      Logger.debug(`🎤 [AudioDeviceDetector] Detected ${devices.length} DirectShow audio devices`);
      return devices;
    } catch (error) {
      Logger.error('❌ [AudioDeviceDetector] Failed to probe DirectShow devices:', error);
      return [];
    }
  }

  /**
   * Get the primary audio input device identifier for the current platform
   */
  static getDefaultInputDevice(ffmpegPath: string = 'ffmpeg'): string | null {
    // 1. Check environment variable override
    if (process.env.JARVIS_AUDIO_DEVICE) {
      Logger.info(`🎙️ [AudioDeviceDetector] Using audio device from JARVIS_AUDIO_DEVICE: "${process.env.JARVIS_AUDIO_DEVICE}"`);
      return process.env.JARVIS_AUDIO_DEVICE;
    }

    if (this.cachedDefaultDevice) {
      return this.cachedDefaultDevice;
    }

    // 2. Windows DirectShow discovery
    if (process.platform === 'win32') {
      const devices = this.getDirectShowAudioDevices(ffmpegPath);
      if (devices.length > 0) {
        this.cachedDefaultDevice = devices[0].name;
        Logger.info(`🎙️ [AudioDeviceDetector] Selected Windows DirectShow device: "${this.cachedDefaultDevice}"`);
        return this.cachedDefaultDevice;
      }
      Logger.warning('⚠️ [AudioDeviceDetector] No DirectShow audio devices discovered, fallback to virtual-audio-capturer');
      return 'virtual-audio-capturer';
    }

    // 3. macOS AVFoundation default audio index
    if (process.platform === 'darwin') {
      return ':0';
    }

    // 4. Linux PulseAudio / ALSA
    return 'default';
  }

  /**
   * Clear cached devices (e.g. after plug/unplug)
   */
  static resetCache(): void {
    this.cachedDevices = null;
    this.cachedDefaultDevice = null;
  }
}
