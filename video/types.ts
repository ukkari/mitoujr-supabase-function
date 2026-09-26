export type Reaction = { emoji: string; count: number };

export type SourcePost = {
  id: string;
  userId: string;
  user: string;
  time: string;
  message: string;
  reactions: Reaction[];
  replies: number;
};

export type VideoSource = {
  date: string;
  label: "今日" | "昨日";
  channels: Array<{ name: string; url: string; posts: SourcePost[] }>;
};

export type Vocal = "none" | "laugh" | "gasp" | "sigh" | "breath";

export type SceneKind = "progress" | "question" | "share" | "fun" | "news";

export type VideoScene = {
  source: number;
  kind: SceneKind;
  heading: string;
  narration: string;
  keyword: string;
  emoji: string[];
  // Performance: a Gemini prebuilt voice, a delivery direction, and an optional vocal burst.
  voice: string;
  tone: string;
  vocal: Vocal;
  // Indices into VideoPlan.posts: the original posts shown as cards in this scene.
  posts: number[];
  start: number;
  end: number;
};

// Only a short verbatim excerpt of each selected post is kept, never the full body.
export type VideoPost = {
  userId: string;
  user: string;
  channel: number;
  time: string;
  text: string;
  reactions: Reaction[];
  replies: number;
};

export const PLAN_VERSION = 4;

export type VideoPlan = {
  version: number;
  demo?: boolean;
  // Final length is set by the renderer from the sped-up narration (≤ 60 s).
  date: string;
  label: string;
  headline: string;
  // The Mattermost message for the video: a clickable title with emoji, nothing else.
  title: string;
  emoji: string[];
  accent: string;
  music: "futurebass" | "phonk" | "trap" | "house" | "citypop";
  transition: "whip" | "zoom" | "flash" | "swipe" | "band" | "pixel";
  scenes: VideoScene[];
  posts: VideoPost[];
  stats: { posts: number; channels: number; people: number; reactions: number };
  stars: Array<{ userId: string; user: string; posts: number }>;
  // Every active channel, busiest first is not guaranteed; `posts`/`people` are that day's counts.
  sources: Array<{ name: string; url: string; posts: number; people: number; top: string }>;
};

export type GeminiConfig = {
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  GEMINI_TTS_MODEL?: string;
  GEMINI_VOICE?: string;
};
