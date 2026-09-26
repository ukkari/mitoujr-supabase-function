export type VideoSource = {
  date: string;
  label: "今日" | "昨日";
  channels: Array<{ name: string; url: string; text: string }>;
};

export type VideoScene = {
  source: number;
  heading: string;
  narration: string;
  keyword: string;
  start: number;
  end: number;
};

export type VideoPlan = {
  demo?: boolean;
  date: string;
  label: string;
  headline: string;
  accent: string;
  music: "house" | "citypop" | "futurebass" | "lofi";
  transition: "zoom" | "whip" | "swipe" | "flash";
  scenes: VideoScene[];
  sources: VideoSource["channels"];
};

export type GeminiConfig = {
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  GEMINI_TTS_MODEL?: string;
  GEMINI_VOICE?: string;
};
