export type AudioTrack = Readonly<{ label: string; url: string }>;

const AUDIO_FILES = ["ding.wav"] as const;

export const AUDIO_TRACKS: readonly AudioTrack[] = AUDIO_FILES.map((file) => ({
  label: file.replace(/\.[^.]+$/, ""),
  url: `/audio/${file}`,
}));
